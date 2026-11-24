// Work items: the rows, the one door a state change goes through (`transitionItem`), the facts the
// machine's guards read (`loadFacts`), manual items and the list. Every query on items lives here
// or beside it in data/; the pure rules are in work/machine.ts and are never re-implemented.
import type { Database } from "@proof/db"
import { AppError } from "@proof/errors"
import { and, desc, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm"

import {
  agentQuestions,
  attempts,
  contractItems,
  mergeApprovals,
  pullRequests,
  signals,
  verificationWindows,
  type WorkAuthorType,
  workItems,
} from "../db/schema"
import { DEPLOY_GRACE_MINUTES, PAYLOAD_MAX_BYTES } from "../work/constants"
import {
  type AttemptKind,
  type AttemptResult,
  type AttemptStatus,
  type AttentionFacts,
  assertTransition,
  displayId,
  findTransition,
  type GuardFacts,
  parseWorkRef,
  type SignalSource,
  type TransitionReason,
  WORK_ID_PREFIX,
  type WorkActor,
  type WorkState,
} from "../work/machine"
import { appendEvent } from "./work-events"

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

/** The three ways a request reaches hq: an API key, a signed-in session, an OAuth token. */
export type ActorVia = "key" | "session" | "oauth"

export interface Actor {
  type: WorkActor
  id: string
  /**
   * How the actor reached hq. It is a label the OPERATION sets from the credential the request
   * arrived with, never from input, and it never changes who the actor is: `appendEvent` only
   * copies it into the event's `detail.via`. It grants nothing.
   */
  via?: ActorVia
}

export interface WorkItemRow {
  id: string
  number: number
  displayId: string
  title: string
  repo: string
  source: SignalSource
  state: WorkState
  cycle: number
  dedupeKey: string | null
  attemptLimit: number | null
  createdAt: Date
  updatedAt: Date
  stateChangedAt: Date
}

export const toWorkItemRow = (r: typeof workItems.$inferSelect): WorkItemRow => ({
  id: r.id,
  number: r.number,
  displayId: displayId(r.number),
  title: r.title,
  repo: r.repo,
  source: r.source,
  state: r.state,
  cycle: r.cycle,
  dedupeKey: r.dedupeKey,
  attemptLimit: r.attemptLimit,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  stateChangedAt: r.stateChangedAt,
})

/** What `signals.recorded_by_type` and `work_items.created_by_type` store: a founder is a person. */
export const authorTypeOf = (actor: Actor): WorkAuthorType =>
  actor.type === "founder" ? "person" : actor.type

// ---------------------------------------------------------------------------------------------
// Validation shared by the two doors that take outside text (recordSignal, createManualItem).
// ---------------------------------------------------------------------------------------------

const bad = (message: string, field: string) =>
  new AppError("BAD_REQUEST", message, { context: { field } })

export const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/
export const REPO_MAX_CHARS = 200
export const TITLE_MAX_CHARS = 300
export const SUMMARY_MAX_CHARS = 300
export const URL_MAX_CHARS = 500
export const ID_MAX_CHARS = 200

/** Text Postgres can hold: no NUL byte and no lone surrogate (either would end as a 500). */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
export const isStorable = (text: string): boolean =>
  !text.includes("\u0000") && !LONE_SURROGATE.test(text)

export function checkText(
  field: string,
  value: unknown,
  o: { max: number; allowEmpty?: boolean },
): string {
  if (typeof value !== "string") throw bad(`${field} must be text`, field)
  if (!o.allowEmpty && value.trim().length === 0) throw bad(`${field} must not be empty`, field)
  if (value.length > o.max) throw bad(`${field} is over ${o.max} characters`, field)
  if (!isStorable(value)) throw bad(`${field} holds a character that cannot be stored`, field)
  return value
}

/** The repo, lower-cased: hq compares repos case-insensitively (GitHub owners are mixed-case). */
export function checkRepo(value: unknown): string {
  const repo = checkText("repo", value, { max: REPO_MAX_CHARS })
  if (!REPO_PATTERN.test(repo)) throw bad("repo must look like owner/name", "repo")
  return repo.toLowerCase()
}

/** A JSON object of at most PAYLOAD_MAX_BYTES serialized bytes whose every string is storable. */
export function checkPayload(value: unknown, field = "payload"): Record<string, unknown> | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "object" || Array.isArray(value))
    throw bad(`${field} must be an object`, field)
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw bad(`${field} is not JSON`, field)
  }
  if (Buffer.byteLength(serialized) > PAYLOAD_MAX_BYTES) {
    throw bad(`${field} is over ${PAYLOAD_MAX_BYTES} bytes`, field)
  }
  const walk = (v: unknown): boolean => {
    if (typeof v === "string") return isStorable(v)
    if (Array.isArray(v)) return v.every(walk)
    if (v && typeof v === "object") {
      return Object.entries(v).every(([k, x]) => isStorable(k) && walk(x))
    }
    return true
  }
  if (!walk(value)) throw bad(`${field} holds a character that cannot be stored`, field)
  return value as Record<string, unknown>
}

// ---------------------------------------------------------------------------------------------
// Reads and the lock.
// ---------------------------------------------------------------------------------------------

/** Lock an item's row for the rest of the transaction. Every function that moves an item calls it. */
export async function lockItem(tx: Tx, itemId: string): Promise<WorkItemRow> {
  const [row] = await tx.select().from(workItems).where(eq(workItems.id, itemId)).for("update")
  if (!row) throw new AppError("NOT_FOUND", "Work item not found")
  return toWorkItemRow(row)
}

/** An item by uuid or `FAC-<n>`; a malformed reference is as NOT_FOUND as an unknown one. */
export async function resolveItem(db: Database, ref: string): Promise<WorkItemRow> {
  const parsed = parseWorkRef(ref)
  if (parsed) {
    const [row] = await db
      .select()
      .from(workItems)
      .where(
        parsed.kind === "id" ? eq(workItems.id, parsed.id) : eq(workItems.number, parsed.number),
      )
    if (row) return toWorkItemRow(row)
  }
  throw new AppError("NOT_FOUND", "Work item not found")
}

export type PullRequestRow = typeof pullRequests.$inferSelect

/**
 * The item's pull request for its CURRENT cycle: the newest one (by opened time, then number)
 * among those that belong to it. `pull_requests` has no cycle column, so a pull request is tied to
 * a cycle through the attempt it remembers (`attempt_id`, stored when the row is first recorded: the
 * attempt that reported its branch, the current cycle's before an older one's): it belongs to the
 * current cycle when that attempt does. That holds when a branch is reused across cycles, which a
 * retry or a reopened item's agent can do. Only a row with no attempt falls back to the branch
 * rule: it counts when a current-cycle attempt reported its branch, or no attempt of another cycle
 * did (a cycle 1 item has no other cycle, so every such row counts). `branch` narrows the choice to
 * one branch.
 */
export async function currentPullRequest(
  tx: Tx,
  item: { id: string; cycle: number },
  branch?: string,
): Promise<PullRequestRow | undefined> {
  const [pr] = await tx
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.itemId, item.id),
        branch === undefined ? undefined : eq(pullRequests.branch, branch),
        sql`(case when ${pullRequests.attemptId} is not null then
            exists (select 1 from ${attempts} where ${attempts.id} = ${pullRequests.attemptId}
              and ${attempts.cycle} = ${item.cycle})
          else
            (exists (select 1 from ${attempts} where ${attempts.itemId} = ${pullRequests.itemId}
              and ${attempts.cycle} = ${item.cycle} and ${attempts.branch} = ${pullRequests.branch})
            or not exists (select 1 from ${attempts} where ${attempts.itemId} = ${pullRequests.itemId}
              and ${attempts.cycle} <> ${item.cycle} and ${attempts.branch} = ${pullRequests.branch}))
          end)`,
      ),
    )
    .orderBy(desc(pullRequests.openedAt), desc(pullRequests.number))
    .limit(1)
  return pr
}

/** The columns of an attempt that decide whether it is a fix that counts. */
export interface FixFacts {
  number: number
  kind: AttemptKind
  status: AttemptStatus
  result: AttemptResult | null
}

/**
 * A fix counts as used while it runs and once it finished, unless it ended asking a question; a
 * `requested` fix has not started. Null-safe: a running fix has no result and still counts.
 */
export const countsAsUsedFix = (a: Pick<FixFacts, "kind" | "status" | "result">): boolean =>
  a.kind === "fix" && a.status !== "requested" && a.result !== "needs_answer"

/**
 * The newest FINISHED fix among an item's attempts of one cycle (highest `number`), skipping fixes
 * that do not count (`countsAsUsedFix`). This is the one definition of "the newest fix": the
 * attention rules (`newestFixResult`) and the reviewer verifier of the verification window read it.
 */
export function newestFinishedFix<T extends FixFacts>(rows: readonly T[]): T | undefined {
  return rows
    .filter((a) => countsAsUsedFix(a) && a.status === "finished")
    .sort((a, b) => b.number - a.number)[0]
}

/**
 * The facts the machine's guards and the attention rules read, in one place. `contractItems`,
 * `attemptsUsed` and `newestFixResult` are the item's CURRENT cycle's; `activeAttempt` reads ALL of
 * the item's attempts (one active attempt per item, whatever its cycle: a stopped item's running
 * attempt is still active after a reopen); `pullRequest` is the item's newest pull request
 * of the current cycle (`currentPullRequest`).
 */
export async function loadFacts(
  tx: Tx,
  item: WorkItemRow,
  now: Date,
): Promise<GuardFacts & AttentionFacts> {
  const [contract] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(contractItems)
    .where(and(eq(contractItems.itemId, item.id), eq(contractItems.cycle, item.cycle)))
  const cycleAttempts = await tx
    .select({
      number: attempts.number,
      kind: attempts.kind,
      status: attempts.status,
      result: attempts.result,
    })
    .from(attempts)
    .where(and(eq(attempts.itemId, item.id), eq(attempts.cycle, item.cycle)))
  const [active] = await tx
    .select({ status: attempts.status, leaseExpiresAt: attempts.leaseExpiresAt })
    .from(attempts)
    .where(and(eq(attempts.itemId, item.id), inArray(attempts.status, ["requested", "running"])))
    .limit(1)
  const pr = await currentPullRequest(tx, item)
  const [window] = await tx
    .select({ endsAt: verificationWindows.endsAt, status: verificationWindows.status })
    .from(verificationWindows)
    .where(and(eq(verificationWindows.itemId, item.id), eq(verificationWindows.cycle, item.cycle)))
  // A pending approval is a card that asks for a decision, so it counts only while the decision
  // can be taken: the item is in `review` and the approval is bound to its CURRENT pull request,
  // which is open (`approveMerge` refuses anything else). Otherwise the card would be dead.
  const [pending] =
    item.state === "review" && pr?.state === "open"
      ? await tx
          .select({ id: mergeApprovals.id })
          .from(mergeApprovals)
          .where(and(eq(mergeApprovals.pullRequestId, pr.id), eq(mergeApprovals.status, "pending")))
          .limit(1)
      : []
  const [open] = await tx
    .select({ id: agentQuestions.id })
    .from(agentQuestions)
    .where(and(eq(agentQuestions.itemId, item.id), eq(agentQuestions.status, "open")))
    .limit(1)

  const used = cycleAttempts.filter(countsAsUsedFix)
  const newestFinished = newestFinishedFix(cycleAttempts)
  const stale =
    active?.status === "running" && active.leaseExpiresAt !== null && active.leaseExpiresAt <= now
  const graceMs = DEPLOY_GRACE_MINUTES * 60_000

  return {
    state: item.state,
    contractItems: contract?.n ?? 0,
    pullRequest: pr?.state ?? "none",
    attemptsRemaining: item.attemptLimit === null || used.length < item.attemptLimit,
    graceElapsed:
      pr?.state === "merged" &&
      pr.mergedAt !== null &&
      now.getTime() >= pr.mergedAt.getTime() + graceMs,
    windowPassed:
      window !== undefined &&
      (window.status === "running" || window.status === "passed") &&
      now >= window.endsAt,
    pendingMergeApproval: pending !== undefined,
    openQuestion: open !== undefined,
    attemptsUsed: used.length,
    attemptLimit: item.attemptLimit,
    activeAttempt: !active ? "none" : stale ? "stale" : "fresh",
    newestFixResult: newestFinished?.result ?? null,
  }
}

const NO_FACTS: GuardFacts = {
  contractItems: 0,
  pullRequest: "none",
  attemptsRemaining: false,
  graceElapsed: false,
  windowPassed: false,
}

/**
 * The only door to a state change: the machine decides (FORBIDDEN, CONFLICT), the row moves and one
 * `transition` event is written. The caller holds the item's lock (`lockItem`); the update is also
 * a compare-and-set on the state and the cycle, so a stale row cannot write a second move. A move
 * out of `reopened` or `stopped` into `triage` ADDS 1 to `cycle` here, and its event carries the
 * new one; callers never add it themselves.
 */
export async function transitionItem(
  tx: Tx,
  input: {
    item: WorkItemRow
    to: WorkState
    actor: Actor
    reason: TransitionReason
    note?: string
    /** Extra facts for the event (a stop lists the questions it withdrew). */
    detail?: Record<string, unknown>
    now: Date
  },
): Promise<WorkItemRow> {
  const { item, to, actor, reason, now } = input
  // Facts are read only for an edge that has a guard; any other edge never looks at them.
  const edge = findTransition(item.state, to, actor.type)
  const facts = edge?.guard ? await loadFacts(tx, item, now) : NO_FACTS
  assertTransition({ from: item.state, to, actor: actor.type, reason, facts })
  const cycle =
    to === "triage" && (item.state === "reopened" || item.state === "stopped")
      ? item.cycle + 1
      : item.cycle
  const [row] = await tx
    .update(workItems)
    .set({ state: to, cycle, stateChangedAt: now, updatedAt: now })
    .where(
      and(
        eq(workItems.id, item.id),
        eq(workItems.state, item.state),
        eq(workItems.cycle, item.cycle),
      ),
    )
    .returning()
  if (!row) {
    throw new AppError("CONFLICT", "The work item moved while this change was in flight", {
      hint: "Read it again and retry.",
    })
  }
  await appendEvent(tx, {
    itemId: item.id,
    at: now,
    kind: "transition",
    fromState: item.state,
    toState: to,
    actor,
    reason,
    note: input.note ?? null,
    detail: input.detail ?? null,
    cycle,
  })
  return toWorkItemRow(row)
}

// ---------------------------------------------------------------------------------------------
// Making items and storing signals (used by recordSignal in signals.ts and by createManualItem).
// ---------------------------------------------------------------------------------------------

/** A signal as stored: already validated and normalized. */
export interface StoredSignal {
  source: SignalSource
  externalId: string
  dedupeKey: string
  repo: string
  title: string
  summary: string
  url: string | null
  payload: Record<string, unknown> | null
  occurredAt: Date
}

/**
 * Insert a signal row and its `signal_attached` event on an item. Returns the signal's id. It does
 * not validate and takes no dedupe lock: only `recordSignal` and `createManualItem` call it.
 */
export async function storeSignal(
  tx: Tx,
  item: WorkItemRow,
  signal: StoredSignal,
  recorder: Actor,
  now: Date,
): Promise<string> {
  const id = crypto.randomUUID()
  await tx.insert(signals).values({
    id,
    source: signal.source,
    externalId: signal.externalId,
    dedupeKey: signal.dedupeKey,
    repo: signal.repo,
    title: signal.title,
    summary: signal.summary,
    url: signal.url,
    payload: signal.payload,
    occurredAt: signal.occurredAt,
    receivedAt: now,
    itemId: item.id,
    recordedByType: authorTypeOf(recorder),
    recordedById: recorder.id,
  })
  await appendEvent(tx, {
    itemId: item.id,
    at: now,
    kind: "signal_attached",
    actor: recorder,
    detail: { signalId: id, source: signal.source, externalId: signal.externalId },
    cycle: item.cycle,
  })
  return id
}

/**
 * A new item for a first signal: `signal` state, the signal attached, then `ingested` into triage.
 * It does not validate and takes no dedupe lock: only `recordSignal` and `createManualItem` call it.
 */
export async function createItemFromSignal(
  tx: Tx,
  signal: StoredSignal,
  recorder: Actor,
  now: Date,
): Promise<{ item: WorkItemRow; signalId: string }> {
  const [created] = await tx
    .insert(workItems)
    .values({
      id: crypto.randomUUID(),
      title: signal.title,
      repo: signal.repo,
      source: signal.source,
      state: "signal",
      cycle: 1,
      dedupeKey: signal.dedupeKey,
      createdByType: authorTypeOf(recorder),
      createdById: recorder.id,
      createdAt: now,
      updatedAt: now,
      stateChangedAt: now,
    })
    .returning()
  if (!created) throw new AppError("INTERNAL", "The work item was not created")
  const signalId = await storeSignal(tx, toWorkItemRow(created), signal, recorder, now)
  const item = await transitionItem(tx, {
    item: toWorkItemRow(created),
    to: "triage",
    actor: { type: "system", id: "hq" },
    reason: "ingested",
    // One millisecond after the signal_attached event, so (at, id) tells the story in order.
    now: new Date(now.getTime() + 1),
  })
  return { item, signalId }
}

/** At most `max` UTF-16 units (the length the schemas count), cut between code points so an emoji is never split. */
function firstChars(text: string, max: number): string {
  let out = ""
  for (const point of text) {
    if (out.length + point.length > max) break
    out += point
  }
  return out
}

/**
 * A founder-made item: source `manual`, one manual signal (`manual:<uuid>` for both the external
 * id and the dedupe key, so it never joins another item). The body, when there is one, is the
 * signal's payload and the first 300 characters of it are its summary.
 */
export async function createManualItem(
  db: Database,
  input: { title: string; body?: string; repo: string; founderId: string; now: Date },
): Promise<{ itemId: string; displayId: string }> {
  const title = checkText("title", input.title, { max: TITLE_MAX_CHARS })
  const repo = checkRepo(input.repo)
  const body =
    input.body === undefined
      ? undefined
      : checkText("body", input.body, { max: PAYLOAD_MAX_BYTES, allowEmpty: true })
  const payload = body ? checkPayload({ body }) : null
  const key = `manual:${crypto.randomUUID()}`
  const signal: StoredSignal = {
    source: "manual",
    externalId: key,
    dedupeKey: key,
    repo,
    title,
    summary: body
      ? firstChars(body.replace(/\s+/g, " ").trim(), SUMMARY_MAX_CHARS) || title
      : title,
    url: null,
    payload,
    occurredAt: input.now,
  }
  return db.transaction(async (tx) => {
    const { item } = await createItemFromSignal(
      tx,
      signal,
      { type: "founder", id: input.founderId },
      input.now,
    )
    return { itemId: item.id, displayId: item.displayId }
  })
}

// ---------------------------------------------------------------------------------------------
// The list.
// ---------------------------------------------------------------------------------------------

export const LIST_MAX_LIMIT = 100
export const QUERY_MAX_CHARS = 200

const escapeLike = (text: string) => text.replace(/[\\%_]/g, "\\$&")

/**
 * Items newest first by (createdAt, id): that key never changes, so a cursor never skips or repeats
 * a row. `query` matches, case-insensitively and as plain text, the title, the display id, the
 * summary of any of its signals and the files of any of its attempts.
 */
export async function listWorkItems(
  db: Database,
  input: {
    state?: WorkState
    query?: string
    dedupeKey?: string
    pullRequestNumber?: number
    repo?: string
    after?: { at: Date; id: string }
    limit: number
  },
): Promise<WorkItemRow[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > LIST_MAX_LIMIT) {
    throw bad(`limit must be 1 to ${LIST_MAX_LIMIT}`, "limit")
  }
  if (input.query !== undefined && input.query.length > QUERY_MAX_CHARS) {
    throw bad(`query is over ${QUERY_MAX_CHARS} characters`, "query")
  }
  const where: (SQL | undefined)[] = []
  if (input.state) where.push(eq(workItems.state, input.state))
  if (input.dedupeKey) where.push(eq(workItems.dedupeKey, input.dedupeKey))
  if (input.repo) where.push(eq(workItems.repo, input.repo.toLowerCase()))
  if (input.pullRequestNumber !== undefined) {
    where.push(
      sql`exists (select 1 from ${pullRequests} where ${pullRequests.itemId} = ${workItems.id}
        and ${pullRequests.number} = ${input.pullRequestNumber})`,
    )
  }
  const query = input.query?.trim()
  if (query) {
    const pattern = `%${escapeLike(query)}%`
    where.push(
      or(
        ilike(workItems.title, pattern),
        sql`${sql.raw(`'${WORK_ID_PREFIX}-'`)} || ${workItems.number}::text ilike ${pattern}`,
        sql`exists (select 1 from ${signals} where ${signals.itemId} = ${workItems.id}
          and ${signals.summary} ilike ${pattern})`,
        sql`exists (select 1 from ${attempts} where ${attempts.itemId} = ${workItems.id}
          and exists (select 1 from jsonb_array_elements_text(${attempts.files}) as f(v)
            where f.v ilike ${pattern}))`,
      ),
    )
  }
  if (input.after) {
    where.push(
      sql`(${workItems.createdAt}, ${workItems.id}) < (${input.after.at.toISOString()}::timestamptz, ${input.after.id})`,
    )
  }
  const rows = await db
    .select()
    .from(workItems)
    .where(and(...where))
    .orderBy(desc(workItems.createdAt), desc(workItems.id))
    .limit(input.limit)
  return rows.map(toWorkItemRow)
}
