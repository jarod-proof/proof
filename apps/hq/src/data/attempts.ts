// Attempts: one try at a work item, an investigation or a fix. A founder requests one, the agent
// (or a dispatcher) starts or claims it, a heartbeat keeps its lease, a finish or the expiry ends
// it. Every function that writes locks the item's row first, so the attempts of one item are
// serialized and the item's state move and the attempt row commit together. The pure rules (which
// state a kind may start from, what counts as used) live in work/machine.ts and `loadFacts`; the
// state itself only ever moves through `transitionItem`.
import type { Database } from "@proof/db"
import { AppError } from "@proof/errors"
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm"

import { attempts, workItems } from "../db/schema"
import {
  ATTEMPT_LEASE_MINUTES,
  ATTEMPT_LIMIT_MAX,
  BRANCH_MAX_CHARS,
  EXTERNAL_REF_MAX_CHARS,
  FILE_MAX_CHARS,
  FILES_MAX,
  NOTE_MAX_CHARS,
  RUN_ID_MAX_CHARS,
  SESSION_ID_MAX_CHARS,
} from "../work/constants"
import {
  ATTEMPT_KINDS,
  type AttemptKind,
  type AttemptStatus,
  displayId,
  type TransitionReason,
  type WorkState,
} from "../work/machine"
import { type FinishAttemptInput, HEAD_SHA_PATTERN, REVIEWER_VERDICTS } from "../work/types"
import { ensureMergeApproval } from "./merge-approvals"
import { appendEvent } from "./work-events"
import {
  type Actor,
  checkText,
  currentPullRequest,
  loadFacts,
  lockItem,
  transitionItem,
  type Tx,
  type WorkItemRow,
} from "./work-items"

export type AttemptRow = typeof attempts.$inferSelect

// The caps live in work/constants.ts (the operations' schemas share them); re-exported here.
export {
  ATTEMPT_LIMIT_MAX,
  BRANCH_MAX_CHARS,
  EXTERNAL_REF_MAX_CHARS,
  FILE_MAX_CHARS,
  FILES_MAX,
  RUN_ID_MAX_CHARS,
  SESSION_ID_MAX_CHARS,
}
/** What a start or request may carry where an operation sends none. */
export const REQUEST_ORIGINS = ["founder_request", "policy_dispatch"] as const
export type RequestOrigin = (typeof REQUEST_ORIGINS)[number]

const FINISH_RESULTS = ["investigated", "approved", "rejected", "failed", "needs_answer"] as const

const bad = (message: string, field: string) =>
  new AppError("BAD_REQUEST", message, { context: { field } })

/**
 * Two events of one transaction share `now`, and events are ordered by (at, id): a random id would
 * shuffle the story. The second event of a pair is written one millisecond later.
 */
const afterMove = (now: Date) => new Date(now.getTime() + 1)

const leaseEnd = (now: Date) => new Date(now.getTime() + ATTEMPT_LEASE_MINUTES * 60_000)

// ---------------------------------------------------------------------------------------------
// Validation of outside text (a key's or a founder's input; never trusted, always capped).
// ---------------------------------------------------------------------------------------------

function checkKind(value: unknown): AttemptKind {
  if (!(ATTEMPT_KINDS as readonly unknown[]).includes(value)) {
    throw bad("kind must be investigate or fix", "kind")
  }
  return value as AttemptKind
}

function checkId(field: string, value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined
  return checkText(field, value, { max })
}

function checkFiles(files: string[] | undefined): string[] | undefined {
  if (files === undefined) return undefined
  if (!Array.isArray(files)) throw bad("files must be a list of paths", "files")
  if (files.length > FILES_MAX) throw bad(`files is over ${FILES_MAX} paths`, "files")
  return files.map((f) => checkText("files", f, { max: FILE_MAX_CHARS }))
}

function checkNote(field: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return checkText(field, value, { max: NOTE_MAX_CHARS, allowEmpty: true })
}

function checkLimit(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 1 || value > ATTEMPT_LIMIT_MAX) {
    throw bad(`attemptLimit must be a whole number from 1 to ${ATTEMPT_LIMIT_MAX}`, "attemptLimit")
  }
  return value
}

// ---------------------------------------------------------------------------------------------
// The start rules every door shares (rule 2 to 4 of the plan's Task 4).
// ---------------------------------------------------------------------------------------------

/** Rule 2: where a kind may start from, and the move it takes (null = the item stays where it is). */
function stateMove(
  item: WorkItemRow,
  kind: AttemptKind,
): { to: WorkState; reason: TransitionReason } | null {
  const refuse = () =>
    new AppError(
      "CONFLICT",
      `A ${kind} attempt cannot start while the work item is in ${item.state}.`,
      {
        context: { state: item.state, kind },
        ...(item.state === "triage" && kind === "fix"
          ? { hint: "Investigate first: a fix starts from plan, attempt or review." }
          : {}),
      },
    )
  switch (item.state) {
    case "triage":
      if (kind === "investigate") return { to: "plan", reason: "investigation_started" }
      throw refuse()
    case "plan":
      return kind === "investigate" ? null : { to: "attempt", reason: "fix_started" }
    case "review":
      if (kind === "fix") return { to: "attempt", reason: "retry_started" }
      throw refuse()
    case "attempt":
      if (kind === "fix") return null
      throw refuse()
    default:
      throw refuse()
  }
}

/** Rule 3: one active attempt per item, whatever its cycle (the partial unique index agrees). */
async function assertNoActive(tx: Tx, itemId: string): Promise<void> {
  const [active] = await tx
    .select({ id: attempts.id })
    .from(attempts)
    .where(and(eq(attempts.itemId, itemId), inArray(attempts.status, ["requested", "running"])))
    .limit(1)
  if (active) {
    throw new AppError("CONFLICT", "An attempt is already running", {
      hint: "Wait for it to finish, or for its lease to expire.",
    })
  }
}

/** Rule 4: a fix needs budget (the current cycle's fix attempts, `loadFacts`). */
async function assertBudget(
  tx: Tx,
  item: WorkItemRow,
  kind: AttemptKind,
  now: Date,
): Promise<void> {
  if (kind !== "fix") return
  const facts = await loadFacts(tx, item, now)
  if (!facts.attemptsRemaining) {
    throw new AppError(
      "CONFLICT",
      `This work item has used its ${item.attemptLimit} fix attempts for this cycle.`,
      { context: { attemptsUsed: facts.attemptsUsed, attemptLimit: item.attemptLimit } },
    )
  }
}

async function nextNumber(tx: Tx, itemId: string): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(max(${attempts.number}), 0)::int` })
    .from(attempts)
    .where(eq(attempts.itemId, itemId))
  return (row?.n ?? 0) + 1
}

// ---------------------------------------------------------------------------------------------
// Request, start, claim.
// ---------------------------------------------------------------------------------------------

/**
 * A founder asks for an attempt: a `requested` row that counts as active (so nothing else starts)
 * but not as used, and moves no state. It checks the state, active and limit rules; the move and
 * the contract guard wait for the claim. `origin` is required: no default, so a caller that forgot
 * it fails typecheck (and a JavaScript caller that forgot it is refused here).
 */
export async function requestAttempt(
  db: Database,
  input: {
    itemId: string
    kind: AttemptKind
    instructions?: string
    origin: RequestOrigin
    founderId: string
    now: Date
  },
): Promise<AttemptRow> {
  if (!(REQUEST_ORIGINS as readonly unknown[]).includes(input.origin)) {
    throw bad("origin must be founder_request or policy_dispatch", "origin")
  }
  const kind = checkKind(input.kind)
  const founderId = checkText("founderId", input.founderId, { max: 200 })
  const instructions = checkNote("instructions", input.instructions)?.trim() || null
  const { now } = input
  return db.transaction(async (tx) => {
    const item = await lockItem(tx, input.itemId)
    stateMove(item, kind)
    await assertNoActive(tx, item.id)
    await assertBudget(tx, item, kind, now)
    // Phase 5's guard runs here (guardAttemptStart), after the rules above and before the insert.
    const number = await nextNumber(tx, item.id)
    const [row] = await tx
      .insert(attempts)
      .values({
        id: crypto.randomUUID(),
        itemId: item.id,
        number,
        cycle: item.cycle,
        kind,
        status: "requested",
        requestedBy: founderId,
        instructions,
        createdAt: now,
      })
      .returning()
    if (!row) throw new AppError("INTERNAL", "The attempt was not created")
    await appendEvent(tx, {
      itemId: item.id,
      at: now,
      kind: "attempt_requested",
      actor: { type: "founder", id: founderId },
      detail: { attemptId: row.id, number, kind, origin: input.origin },
      cycle: item.cycle,
    })
    return row
  })
}

/**
 * The agent starts an attempt: `running`, lease `now + ATTEMPT_LEASE_MINUTES`. The checks run in
 * this order, so a replay is answered before anything can refuse it: (1) the same `externalRef`
 * on this item, in any status, returns that attempt unchanged (no event, no number, no move);
 * (2) the state rule and its move; (3) one active attempt; (4) the fix budget; then the insert.
 */
export async function startAttempt(
  db: Database,
  input: {
    itemId: string
    kind: AttemptKind
    runId?: string
    attemptLimit?: number
    externalRef?: string
    actor: Actor
    now: Date
  },
): Promise<AttemptRow> {
  const kind = checkKind(input.kind)
  const runId = checkId("runId", input.runId, RUN_ID_MAX_CHARS)
  const externalRef = checkId("externalRef", input.externalRef, EXTERNAL_REF_MAX_CHARS)
  const attemptLimit = checkLimit(input.attemptLimit)
  const { actor, now } = input
  return db.transaction(async (tx) => {
    let item = await lockItem(tx, input.itemId)
    if (externalRef !== undefined) {
      const [same] = await tx
        .select()
        .from(attempts)
        .where(and(eq(attempts.itemId, item.id), eq(attempts.externalRef, externalRef)))
      if (same) return same
    }
    const move = stateMove(item, kind)
    await assertNoActive(tx, item.id)
    // The first limit sent is stored and applies to this very start; a later value is ignored.
    if (attemptLimit !== undefined && item.attemptLimit === null) {
      await tx
        .update(workItems)
        .set({ attemptLimit, updatedAt: now })
        .where(eq(workItems.id, item.id))
      item = { ...item, attemptLimit, updatedAt: now }
    }
    await assertBudget(tx, item, kind, now)
    // Phase 5's guard runs here (guardAttemptStart), after the rules above and before the insert.
    // The move comes before the insert: the new fix must not count against its own budget guard.
    if (move) {
      item = await transitionItem(tx, { item, to: move.to, actor, reason: move.reason, now })
    }
    const number = await nextNumber(tx, item.id)
    const [row] = await tx
      .insert(attempts)
      .values({
        id: crypto.randomUUID(),
        itemId: item.id,
        number,
        cycle: item.cycle,
        kind,
        status: "running",
        startedAt: now,
        leaseExpiresAt: leaseEnd(now),
        runId: runId ?? null,
        externalRef: externalRef ?? null,
        createdAt: now,
      })
      .returning()
    if (!row) throw new AppError("INTERNAL", "The attempt was not created")
    await appendEvent(tx, {
      itemId: item.id,
      at: afterMove(now),
      kind: "attempt_started",
      actor,
      detail: { attemptId: row.id, number, kind, externalRef: externalRef ?? null },
      cycle: item.cycle,
    })
    return row
  })
}

/**
 * Promote a `requested` attempt to `running`: the state move and budget of the start rules, then a
 * compare-and-set on `status = 'requested'`. The item's lock serializes claimers; the predicate is
 * what makes exactly one of them win, and the loser gets CONFLICT. The attempt's status is
 * deliberately not read in JavaScript first: the predicate is the one decision.
 */
export async function claimAttempt(
  db: Database,
  input: {
    attemptId: string
    runId?: string
    externalRef?: string
    actor: Actor
    now: Date
  },
): Promise<AttemptRow> {
  const runId = checkId("runId", input.runId, RUN_ID_MAX_CHARS)
  const externalRef = checkId("externalRef", input.externalRef, EXTERNAL_REF_MAX_CHARS)
  const { actor, now } = input
  const [seen] = await db
    .select({ itemId: attempts.itemId, kind: attempts.kind })
    .from(attempts)
    .where(eq(attempts.id, input.attemptId))
  if (!seen) throw new AppError("NOT_FOUND", "Attempt not found")
  return db.transaction(async (tx) => {
    let item = await lockItem(tx, seen.itemId)
    const move = stateMove(item, seen.kind)
    await assertBudget(tx, item, seen.kind, now)
    if (externalRef !== undefined) {
      const [clash] = await tx
        .select({ id: attempts.id })
        .from(attempts)
        .where(and(eq(attempts.itemId, item.id), eq(attempts.externalRef, externalRef)))
      if (clash && clash.id !== input.attemptId) {
        throw new AppError("CONFLICT", "Another attempt of this item holds that externalRef")
      }
    }
    // Phase 5's guard runs here (guardAttemptStart), after the rules above and before the claim.
    if (move) {
      item = await transitionItem(tx, { item, to: move.to, actor, reason: move.reason, now })
    }
    const [row] = await tx
      .update(attempts)
      .set({
        status: "running",
        claimedAt: now,
        startedAt: now,
        leaseExpiresAt: leaseEnd(now),
        ...(runId === undefined ? {} : { runId }),
        ...(externalRef === undefined ? {} : { externalRef }),
      })
      .where(and(eq(attempts.id, input.attemptId), eq(attempts.status, "requested")))
      .returning()
    if (!row) {
      throw new AppError("CONFLICT", "That attempt was already claimed", {
        hint: "Another session took it; list attempts again.",
      })
    }
    await appendEvent(tx, {
      itemId: item.id,
      at: afterMove(now),
      kind: "attempt_started",
      actor,
      detail: {
        attemptId: row.id,
        number: row.number,
        kind: row.kind,
        externalRef: row.externalRef,
        claimed: true,
      },
      cycle: item.cycle,
    })
    return row
  })
}

// ---------------------------------------------------------------------------------------------
// Heartbeat, finish, expiry.
// ---------------------------------------------------------------------------------------------

/**
 * Extend a running attempt's lease to `now + ATTEMPT_LEASE_MINUTES`, optionally recording its
 * branch, files and note. CONFLICT on an attempt that is not running (requested, finished or
 * abandoned) and on one whose lease already ran out: the sweep owns it from then on.
 */
export async function heartbeatAttempt(
  db: Database,
  input: { attemptId: string; branch?: string; files?: string[]; note?: string; now: Date },
): Promise<{ leaseExpiresAt: Date }> {
  const branch = checkId("branch", input.branch, BRANCH_MAX_CHARS)
  const files = checkFiles(input.files)
  const note = checkNote("note", input.note)
  const { now } = input
  const [seen] = await db
    .select({ itemId: attempts.itemId })
    .from(attempts)
    .where(eq(attempts.id, input.attemptId))
  if (!seen) throw new AppError("NOT_FOUND", "Attempt not found")
  return db.transaction(async (tx) => {
    const item = await lockItem(tx, seen.itemId)
    const [cur] = await tx.select().from(attempts).where(eq(attempts.id, input.attemptId))
    if (!cur) throw new AppError("NOT_FOUND", "Attempt not found")
    if (cur.status !== "running") {
      throw new AppError(
        "CONFLICT",
        `The attempt is ${cur.status === "requested" ? "not started" : "finished"}.`,
      )
    }
    // A founder stopped the item (or it is done): its running attempt must run out its lease, not
    // be kept alive by heartbeats. `reopened` is not refused: the sweep retriages it and an attempt
    // that is still working may still report.
    if (item.state === "stopped" || item.state === "done") {
      throw new AppError("CONFLICT", `The work item is ${item.state}: stop working on it.`, {
        context: { state: item.state },
        hint: "Finish the attempt, or let its lease run out.",
      })
    }
    if (cur.leaseExpiresAt !== null && cur.leaseExpiresAt <= now) {
      throw new AppError("CONFLICT", "The attempt's lease has expired", {
        hint: "It will be marked abandoned; start a new attempt.",
      })
    }
    const leaseExpiresAt = leaseEnd(now)
    await tx
      .update(attempts)
      .set({
        lastHeartbeatAt: now,
        leaseExpiresAt,
        ...(branch === undefined ? {} : { branch }),
        ...(files === undefined ? {} : { files }),
        ...(note === undefined ? {} : { note }),
      })
      .where(and(eq(attempts.id, cur.id), eq(attempts.status, "running")))
    return { leaseExpiresAt }
  })
}

/**
 * The head sha a reviewer verdict was given on: the plan's rule is the recorded pull request's head
 * sha, and the branch only decides WHICH one. Both reads are of the item's CURRENT cycle's pull
 * requests (`currentPullRequest`, so an older cycle's pull request on a reused branch is never the
 * answer): with a branch it is the newest on that branch, and with no branch (a dropped heartbeat)
 * the item's newest, as `loadFacts` reads it: a null here would let `ensureMergeApproval` bind an
 * approval to any head. No pull request at all is null.
 */
async function headShaOfBranch(
  tx: Tx,
  item: { id: string; cycle: number },
  branch: string | null,
): Promise<string | null> {
  const pr = await currentPullRequest(tx, item, branch ?? undefined)
  return pr?.headSha ?? null
}

/**
 * End a running attempt with a result. `investigated` is for an investigation; `approved` and
 * `rejected` are for a fix and carry the reviewer's verdict; `failed` and `needs_answer` are for
 * either. A second finish with the same result returns the stored attempt (a retried step is
 * safe); a different result is CONFLICT. `abandoned` is the sweep's alone.
 */
export async function finishAttempt(
  db: Database,
  input: FinishAttemptInput & { now: Date; actor: Actor },
): Promise<AttemptRow> {
  if (!(FINISH_RESULTS as readonly unknown[]).includes(input.result)) {
    throw bad("result must be investigated, approved, rejected, failed or needs_answer", "result")
  }
  const note = checkNote("note", input.note)
  const files = checkFiles(input.files)
  const branch = checkId("branch", input.branch, BRANCH_MAX_CHARS)
  const sessionId = checkId("sessionId", input.sessionId, SESSION_ID_MAX_CHARS)
  let reviewer:
    | { verdict: (typeof REVIEWER_VERDICTS)[number]; summary: string; headSha?: string }
    | undefined
  if (input.reviewer !== undefined) {
    if (!(REVIEWER_VERDICTS as readonly unknown[]).includes(input.reviewer.verdict)) {
      throw bad("reviewer.verdict must be approve, request_changes or reject", "reviewer")
    }
    reviewer = {
      verdict: input.reviewer.verdict,
      summary: checkText("reviewer.summary", input.reviewer.summary, {
        max: NOTE_MAX_CHARS,
        allowEmpty: true,
      }),
    }
    if (input.reviewer.headSha !== undefined) {
      const sha = checkText("reviewer.headSha", input.reviewer.headSha, { max: 64 })
      if (!HEAD_SHA_PATTERN.test(sha)) throw bad("reviewer.headSha must be a commit id", "reviewer")
      reviewer.headSha = sha.toLowerCase()
    }
  }
  const { now, result } = input
  const { actor } = input
  const [seen] = await db
    .select({ itemId: attempts.itemId })
    .from(attempts)
    .where(eq(attempts.id, input.attemptId))
  if (!seen) throw new AppError("NOT_FOUND", "Attempt not found")
  return db.transaction(async (tx) => {
    const item = await lockItem(tx, seen.itemId)
    const [cur] = await tx.select().from(attempts).where(eq(attempts.id, input.attemptId))
    if (!cur) throw new AppError("NOT_FOUND", "Attempt not found")
    if (cur.status === "finished") {
      if (cur.result === result) return cur
      throw new AppError("CONFLICT", `The attempt already finished as ${cur.result}.`, {
        context: { result: cur.result },
      })
    }
    if (cur.status !== "running") {
      throw new AppError("CONFLICT", "The attempt has not started", {
        hint: "Claim or start it before finishing it.",
      })
    }
    if (result === "investigated" && cur.kind !== "investigate") {
      throw bad("investigated is a result of an investigation", "result")
    }
    if ((result === "approved" || result === "rejected") && cur.kind !== "fix") {
      throw bad(`${result} is a result of a fix`, "result")
    }
    if (result === "approved" || result === "rejected") {
      if (!reviewer) throw bad(`${result} needs the reviewer's verdict`, "reviewer")
      const fits =
        result === "approved" ? reviewer.verdict === "approve" : reviewer.verdict !== "approve"
      if (!fits)
        throw bad(`A ${reviewer.verdict} verdict cannot end an attempt as ${result}`, "reviewer")
    }
    // The sha the reviewer says it read wins: a retry whose finish arrives before its push is
    // recorded would otherwise bind to the older head. Without one, the recorded pull request's.
    const reviewedHeadSha =
      reviewer?.headSha ?? (await headShaOfBranch(tx, item, branch ?? cur.branch))
    const startedAt = cur.startedAt ?? cur.createdAt
    const [row] = await tx
      .update(attempts)
      .set({
        status: "finished",
        result,
        finishedAt: now,
        durationMs: Math.max(0, now.getTime() - startedAt.getTime()),
        reviewedHeadSha,
        ...(note === undefined ? {} : { note }),
        ...(files === undefined ? {} : { files }),
        ...(branch === undefined ? {} : { branch }),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(reviewer
          ? { reviewerVerdict: reviewer.verdict, reviewerSummary: reviewer.summary }
          : {}),
      })
      .where(and(eq(attempts.id, cur.id), eq(attempts.status, "running")))
      .returning()
    if (!row) throw new AppError("CONFLICT", "The attempt finished while this call was in flight")
    await appendEvent(tx, {
      itemId: item.id,
      at: now,
      kind: "attempt_finished",
      actor,
      detail: { attemptId: row.id, number: row.number, kind: row.kind, result },
      cycle: item.cycle,
    })
    // An approved fix may be the last fact a merge approval waits for (the pull request can already
    // be open). Its event is one millisecond after the finish, so (at, id) keeps the story's order.
    await ensureMergeApproval(tx, item.id, afterMove(now))
    return row
  })
}

/**
 * Mark every running attempt whose lease has passed as abandoned (finished, result `abandoned`)
 * and return their ids. Each is its own transaction, under its item's lock, with the lease check
 * repeated there, so a heartbeat that won the race keeps its attempt. The item does not move:
 * with the attempt gone the attention rules say what is left to do.
 */
export async function expireStaleAttempts(db: Database, now: Date): Promise<string[]> {
  const expired: string[] = []
  for (const s of await listStaleAttempts(db, now)) {
    if (await expireAttempt(db, s.id, s.itemId, now)) expired.push(s.id)
  }
  return expired
}

/** The running attempts whose lease has passed, oldest lease first. */
export async function listStaleAttempts(
  db: Database,
  now: Date,
): Promise<{ id: string; itemId: string }[]> {
  return db
    .select({ id: attempts.id, itemId: attempts.itemId })
    .from(attempts)
    .where(and(eq(attempts.status, "running"), lte(attempts.leaseExpiresAt, now)))
    .orderBy(asc(attempts.leaseExpiresAt), asc(attempts.id))
}

/**
 * Abandon one stale attempt in its own transaction, under its item's lock, with the lease check
 * repeated there, so a heartbeat that won the race keeps its attempt. False when it was not stale
 * any more. The sweep calls this once per attempt so one that throws skips only itself.
 */
export async function expireAttempt(
  db: Database,
  attemptId: string,
  itemId: string,
  now: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const item = await lockItem(tx, itemId)
    const [row] = await tx
      .update(attempts)
      .set({
        status: "finished",
        result: "abandoned",
        finishedAt: now,
        durationMs: sql`greatest(0, (extract(epoch from (${now.toISOString()}::timestamptz - coalesce(${attempts.startedAt}, ${attempts.createdAt}))) * 1000)::bigint)::int`,
      })
      .where(
        and(
          eq(attempts.id, attemptId),
          eq(attempts.status, "running"),
          lte(attempts.leaseExpiresAt, now),
        ),
      )
      .returning()
    if (!row) return false
    await appendEvent(tx, {
      itemId: item.id,
      at: now,
      kind: "attempt_abandoned",
      actor: { type: "system", id: "hq" },
      detail: { attemptId: row.id, number: row.number, kind: row.kind },
      cycle: item.cycle,
    })
    return true
  })
}

// ---------------------------------------------------------------------------------------------
// The list a dispatcher and the agent read.
// ---------------------------------------------------------------------------------------------

export interface AttemptListEntry {
  attemptId: string
  itemId: string
  displayId: string
  kind: AttemptKind
  status: AttemptStatus
  title: string
  repo: string
  instructions: string | null
  externalRef: string | null
}

export const LIST_ATTEMPTS_MAX = 200

/** Attempts oldest first (a dispatcher takes the oldest request), at most LIST_ATTEMPTS_MAX. */
export async function listAttempts(
  db: Database,
  filter: { status?: AttemptStatus; itemId?: string; externalRef?: string },
): Promise<AttemptListEntry[]> {
  const where = []
  if (filter.status) where.push(eq(attempts.status, filter.status))
  if (filter.itemId) where.push(eq(attempts.itemId, filter.itemId))
  if (filter.externalRef !== undefined) where.push(eq(attempts.externalRef, filter.externalRef))
  const rows = await db
    .select({
      attemptId: attempts.id,
      itemId: attempts.itemId,
      number: workItems.number,
      kind: attempts.kind,
      status: attempts.status,
      title: workItems.title,
      repo: workItems.repo,
      instructions: attempts.instructions,
      externalRef: attempts.externalRef,
    })
    .from(attempts)
    .innerJoin(workItems, eq(workItems.id, attempts.itemId))
    .where(and(...where))
    .orderBy(asc(attempts.createdAt), asc(attempts.id))
    .limit(LIST_ATTEMPTS_MAX)
  return rows.map(({ number, ...r }) => ({ ...r, displayId: displayId(number) }))
}
