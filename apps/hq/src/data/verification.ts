// The verification window and the sweep. A merged change is watched after the deploy grace for a
// window; the sweep (the agent's schedule calls `run_verification_sweep`) moves items on as time
// passes and facts change: it abandons stale attempts, retriages reopened items, opens the window
// of an item whose grace elapsed and settles the items in `verify` against their contract.
//
// Everything here is driven by an injected `now`: no timer, no clock read. Each item is moved in
// its own transaction under its row lock, and the state is read again under that lock, so two
// sweeps (or a sweep and a founder) never move an item twice: the second finds it already moved.
// The sweep is idempotent: a second run over the same clock changes nothing, except that an item
// the first run reopened is retriaged by the second (that is progress, not repetition).
//
// `transitionItem` owns the `cycle + 1` on `reopened>triage`: nothing here adds another.
import type { Database } from "@proof/db"
import { AppError, reportError } from "@proof/errors"
import { and, asc, eq, gt, gte, lte, max, sql } from "drizzle-orm"

import {
  agentQuestions,
  attempts,
  contractItems,
  signals,
  verificationWindows,
  workItemEvents,
  workItems,
} from "../db/schema"
import { DEPLOY_GRACE_MINUTES, VERIFY_WINDOW_HOURS } from "../work/constants"
import type { VerifierKind, WorkState } from "../work/machine"
import { expireAttempt, listStaleAttempts } from "./attempts"
import { CONNECTED_VERIFIER_KINDS } from "./contract"
import { closeRunningWindow } from "./decisions"
import { appendEvent } from "./work-events"
import {
  type Actor,
  currentPullRequest,
  loadFacts,
  lockItem,
  newestFinishedFix,
  transitionItem,
  type Tx,
} from "./work-items"

export type WindowRow = typeof verificationWindows.$inferSelect

export interface SweepResult {
  /** Items that moved `deploy` to `verify` (their window opened). */
  advanced: string[]
  /** Items that moved `verify` to `done`. */
  passed: string[]
  /** Items that moved `verify` to `reopened` because a contract item failed. */
  reopened: string[]
  /** Items that moved `reopened` to `triage` (cycle + 1). */
  retriaged: string[]
  /** Attempt ids whose lease passed. */
  abandoned: string[]
  /** What failed and was skipped: one item's (or the expiry's) error never stops the pass. */
  errors: SweepError[]
}

export interface SweepError {
  /** The item whose transaction failed (an attempt's item for the expiry), or null when none is known. */
  itemId: string | null
  rule: "expire" | "retriage" | "advance" | "settle"
  /** The error's code and message for an AppError, else its name and first line, capped. */
  message: string
}

const SYSTEM: Actor = { type: "system", id: "hq" }
const MINUTE_MS = 60_000

/**
 * A clock for the events of one item written by one call: each `next()` is a strictly later
 * millisecond than the item's newest event and than `now`, so `(at, id)` tells the story in order
 * even when a second sweep over the same `now` follows a first (an item the first reopened, the
 * second retriages) or when one sweep takes an item through two rules in two transactions.
 */
async function itemClock(tx: Tx, itemId: string, now: Date): Promise<() => Date> {
  const [latest] = await tx
    .select({ at: max(workItemEvents.at) })
    .from(workItemEvents)
    .where(eq(workItemEvents.itemId, itemId))
  let t = Math.max(now.getTime(), latest?.at ? latest.at.getTime() + 1 : 0)
  return () => new Date(t++)
}

// ---------------------------------------------------------------------------------------------
// Contract evaluation.
// ---------------------------------------------------------------------------------------------

interface Verdict {
  status: "passing" | "failing" | "pending"
  evidence: string
}

const pending = (evidence: string): Verdict => ({ status: "pending", evidence })

/**
 * Check the current cycle's contract items against what hq knows and store each result (`status`,
 * `evidence`, `checked_at = now`). Only the item's CURRENT cycle's rows count.
 *
 * - `reviewer` passes when the cycle's newest fix attempt was approved; otherwise it is pending
 *   (the plan names no failure for it).
 * - `ci` passes when the current pull request is merged and every one of its checks passed, fails
 *   when any check failed, and is pending with no checks, a pending check or no merged pull request.
 * - `signal_recurrence` fails when a signal with the item's dedupe key has `occurred_at` strictly
 *   after the window's start, else passes; an item with no dedupe key stays pending (nothing can
 *   be matched, so nothing is claimed).
 * - A kind that is not connected (`sentry`, `posthog`, anything unknown) is `not_connected` and
 *   stays pending: a window is never passed because a verifier cannot run.
 *
 * `allPassing` needs at least one row (a window with nothing to verify does not pass).
 */
export async function evaluateContract(
  tx: Tx,
  item: { id: string; cycle: number; dedupeKey: string | null },
  window: Pick<WindowRow, "startsAt">,
  now: Date,
): Promise<{ allPassing: boolean; anyFailing: boolean }> {
  const rows = await tx
    .select()
    .from(contractItems)
    .where(and(eq(contractItems.itemId, item.id), eq(contractItems.cycle, item.cycle)))
    .orderBy(asc(contractItems.position))
  if (rows.length === 0) return { allPassing: false, anyFailing: false }

  const pr = await currentPullRequest(tx, item)
  // The same definition of "the newest fix" as `loadFacts` (a shared helper): the newest FINISHED
  // fix of this cycle that counts, so a fix still `requested` or ended `needs_answer` is not it.
  const cycleAttempts = await tx
    .select({
      number: attempts.number,
      kind: attempts.kind,
      status: attempts.status,
      result: attempts.result,
    })
    .from(attempts)
    .where(and(eq(attempts.itemId, item.id), eq(attempts.cycle, item.cycle)))
  const newestFix = newestFinishedFix(cycleAttempts)

  const judge = async (kind: VerifierKind): Promise<Verdict> => {
    if (!CONNECTED_VERIFIER_KINDS.includes(kind)) {
      return pending(`not_connected: ${kind} is not connected, so it cannot verify this item.`)
    }
    if (kind === "reviewer") {
      if (newestFix?.result === "approved") {
        return {
          status: "passing",
          evidence: `The reviewer approved fix attempt ${newestFix.number}.`,
        }
      }
      return pending(
        newestFix
          ? `The newest finished fix attempt of this cycle (${newestFix.number}) ended ${newestFix.result ?? newestFix.status}, not approved.`
          : "This cycle has no finished fix attempt for the reviewer to approve.",
      )
    }
    if (kind === "ci") {
      if (!pr || pr.state !== "merged")
        return pending("No merged pull request to read checks from.")
      const failed = pr.checks.filter((c) => c.state === "failed").length
      if (failed > 0) {
        return { status: "failing", evidence: `${failed} of ${pr.checks.length} checks failed.` }
      }
      if (pr.checks.length === 0) return pending("The pull request reports no checks.")
      const waiting = pr.checks.filter((c) => c.state !== "passed").length
      if (waiting > 0) {
        return pending(`${waiting} of ${pr.checks.length} checks have not passed yet.`)
      }
      return { status: "passing", evidence: `All ${pr.checks.length} checks passed.` }
    }
    // signal_recurrence
    if (item.dedupeKey === null) {
      return pending("The item has no dedupe key, so a recurrence cannot be matched.")
    }
    const [seen] = await tx
      .select({ n: sql<number>`count(*)::int`, newest: max(signals.occurredAt) })
      .from(signals)
      .where(and(eq(signals.dedupeKey, item.dedupeKey), gt(signals.occurredAt, window.startsAt)))
    if (seen && seen.n > 0) {
      return {
        status: "failing",
        evidence: `${seen.n} signal${seen.n === 1 ? "" : "s"} with this dedupe key arrived after ${window.startsAt.toISOString()}${
          seen.newest ? `, the newest at ${seen.newest.toISOString()}` : ""
        }.`,
      }
    }
    return {
      status: "passing",
      evidence: `No signal with this dedupe key since ${window.startsAt.toISOString()}.`,
    }
  }

  let allPassing = true
  let anyFailing = false
  for (const row of rows) {
    const verdict = await judge(row.verifierKind)
    await tx
      .update(contractItems)
      .set({ status: verdict.status, evidence: verdict.evidence, checkedAt: now })
      .where(eq(contractItems.id, row.id))
    if (verdict.status !== "passing") allPassing = false
    if (verdict.status === "failing") anyFailing = true
  }
  return { allPassing, anyFailing }
}

// ---------------------------------------------------------------------------------------------
// One item at a time (exported so a test can show each re-reads the state under the lock).
// ---------------------------------------------------------------------------------------------

/**
 * Rule 3: a `deploy` item whose merge is older than the deploy grace moves to `verify` and its
 * window opens: `starts_at = merged_at + 15 min`, `ends_at = starts_at + 6 h`. Whether the grace
 * elapsed is read from `loadFacts`, the same fact the machine's guard reads. Returns whether it moved.
 */
export async function advanceDeployItem(db: Database, itemId: string, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const found = await lockItem(tx, itemId)
    if (found.state !== "deploy") return false
    const facts = await loadFacts(tx, found, now)
    if (!facts.graceElapsed) return false
    const pr = await currentPullRequest(tx, found)
    if (!pr?.mergedAt) return false
    const next = await itemClock(tx, found.id, now)
    const item = await transitionItem(tx, {
      item: found,
      to: "verify",
      actor: SYSTEM,
      reason: "deploy_grace_elapsed",
      now: next(),
    })
    const startsAt = new Date(pr.mergedAt.getTime() + DEPLOY_GRACE_MINUTES * MINUTE_MS)
    const endsAt = new Date(startsAt.getTime() + VERIFY_WINDOW_HOURS * 60 * MINUTE_MS)
    const [window] = await tx
      .insert(verificationWindows)
      .values({
        id: crypto.randomUUID(),
        itemId: item.id,
        cycle: item.cycle,
        startsAt,
        endsAt,
        status: "running",
      })
      // A window of this cycle already existing is unreachable today (no path returns an item to
      // `deploy` within a cycle). Were it ever reached, the item would stay in `verify` with no
      // running window and `settleVerifyItem` would skip it: that is why this does not throw.
      .onConflictDoNothing()
      .returning({ id: verificationWindows.id })
    if (window) {
      await appendEvent(tx, {
        itemId: item.id,
        at: next(),
        kind: "window_started",
        actor: SYSTEM,
        detail: {
          windowId: window.id,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
        },
        cycle: item.cycle,
      })
    }
    return true
  })
}

/**
 * Rule 4: a `verify` item with a running window of its current cycle is evaluated. With any
 * contract item failing it goes to `reopened` (`contract_failed`) and the window fails, whenever
 * that is found; with every item passing and `now >= ends_at` it goes to `done` (`window_passed`)
 * and the window passes; otherwise it is left. Returns what happened, or null when nothing did.
 */
export async function settleVerifyItem(
  db: Database,
  itemId: string,
  now: Date,
): Promise<"passed" | "reopened" | null> {
  return db.transaction(async (tx) => {
    const found = await lockItem(tx, itemId)
    if (found.state !== "verify") return null
    const [window] = await tx
      .select()
      .from(verificationWindows)
      .where(
        and(eq(verificationWindows.itemId, found.id), eq(verificationWindows.cycle, found.cycle)),
      )
    if (!window || window.status !== "running") return null

    const verdict = await evaluateContract(tx, found, window, now)
    if (verdict.anyFailing) {
      const failing = await tx
        .select({ kind: contractItems.verifierKind })
        .from(contractItems)
        .where(
          and(
            eq(contractItems.itemId, found.id),
            eq(contractItems.cycle, found.cycle),
            eq(contractItems.status, "failing"),
          ),
        )
        .orderBy(asc(contractItems.position))
      const note = `Contract failed: ${failing.map((f) => f.kind).join(", ")}.`
      const next = await itemClock(tx, found.id, now)
      const item = await transitionItem(tx, {
        item: found,
        to: "reopened",
        actor: SYSTEM,
        reason: "contract_failed",
        note,
        now: next(),
      })
      await closeRunningWindow(tx, {
        item,
        status: "failed",
        note,
        actor: SYSTEM,
        now,
        eventAt: next,
      })
      return "reopened"
    }
    // The decision is made on the real `now`; the clock below only orders the events.
    if (verdict.allPassing && now.getTime() >= window.endsAt.getTime()) {
      const next = await itemClock(tx, found.id, now)
      const item = await transitionItem(tx, {
        item: found,
        to: "done",
        actor: SYSTEM,
        reason: "window_passed",
        now: next(),
      })
      await closeRunningWindow(tx, {
        item,
        status: "passed",
        note: "Every contract item passed and the window ended.",
        actor: SYSTEM,
        now,
        eventAt: next,
      })
      return "passed"
    }
    return null
  })
}

/**
 * Rule 2: a `reopened` item goes back to `triage` as the system (`retriaged`). The move into
 * triage adds the 1 to `cycle`. Open questions are NOT withdrawn: they carry into the new cycle
 * (a founder may still answer them), and the transition event names them. Returns whether it moved.
 */
export async function retriageReopenedItem(
  db: Database,
  itemId: string,
  now: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const found = await lockItem(tx, itemId)
    if (found.state !== "reopened") return false
    const open = await tx
      .select({ id: agentQuestions.id })
      .from(agentQuestions)
      .where(and(eq(agentQuestions.itemId, found.id), eq(agentQuestions.status, "open")))
      .orderBy(asc(agentQuestions.createdAt), asc(agentQuestions.id))
    const next = await itemClock(tx, found.id, now)
    await transitionItem(tx, {
      item: found,
      to: "triage",
      actor: SYSTEM,
      reason: "retriaged",
      ...(open.length === 0 ? {} : { detail: { carriedQuestionIds: open.map((q) => q.id) } }),
      now: next(),
    })
    return true
  })
}

// ---------------------------------------------------------------------------------------------
// The sweep.
// ---------------------------------------------------------------------------------------------

async function idsIn(db: Database, state: WorkState): Promise<string[]> {
  const rows = await db
    .select({ id: workItems.id })
    .from(workItems)
    .where(eq(workItems.state, state))
    .orderBy(asc(workItems.stateChangedAt), asc(workItems.id))
  return rows.map((r) => r.id)
}

/**
 * One pass, in this order: (1) stale attempts are abandoned; (2) every item `reopened` at the start
 * of the pass is retriaged; (3) every `deploy` item past the grace opens its window; (4) every
 * `verify` item, including one rule 3 just advanced, is settled. An item moves at most one edge per
 * rule, so a merge older than grace plus window reaches `done` in one pass, and an item rule 4
 * reopens waits for the next pass to be retriaged. Idempotent over one clock. An error in one
 * item's transaction is recorded in `errors` and the pass goes on.
 */
export async function runVerificationSweep(db: Database, now: Date): Promise<SweepResult> {
  const result: SweepResult = {
    advanced: [],
    passed: [],
    reopened: [],
    retriaged: [],
    abandoned: [],
    errors: [],
  }
  // One item's failure (a CONFLICT included: under the lock it means something is wrong) is
  // recorded and skipped, so an item that always throws, and so never moves, cannot freeze the
  // items behind it on every scheduled run. Its transaction rolled back whole.
  const guarded = async (
    itemId: string | null,
    rule: SweepError["rule"],
    run: () => Promise<void>,
  ) => {
    try {
      await run()
    } catch (error) {
      reportError(error, { itemId, rule })
      result.errors.push({ itemId, rule, message: describeFailure(error) })
    }
  }
  // Each stale attempt is its own guarded step: one that throws is recorded with its item's id and
  // skips only itself (it is tried again on the next pass), never the attempts behind it.
  let stale: { id: string; itemId: string }[] = []
  await guarded(null, "expire", async () => {
    stale = await listStaleAttempts(db, now)
  })
  for (const attempt of stale) {
    await guarded(attempt.itemId, "expire", async () => {
      if (await expireAttempt(db, attempt.id, attempt.itemId, now))
        result.abandoned.push(attempt.id)
    })
  }
  for (const id of await idsIn(db, "reopened")) {
    await guarded(id, "retriage", async () => {
      if (await retriageReopenedItem(db, id, now)) result.retriaged.push(id)
    })
  }
  for (const id of await idsIn(db, "deploy")) {
    await guarded(id, "advance", async () => {
      if (await advanceDeployItem(db, id, now)) result.advanced.push(id)
    })
  }
  for (const id of await idsIn(db, "verify")) {
    await guarded(id, "settle", async () => {
      const outcome = await settleVerifyItem(db, id, now)
      if (outcome === "passed") result.passed.push(id)
      else if (outcome === "reopened") result.reopened.push(id)
    })
  }
  return result
}

const FAILURE_MAX_CHARS = 200

/**
 * No SQL and no parameters: an AppError's code and message, else the name and first line of the
 * innermost cause (the database's own message sits there; the wrapper above it quotes the query).
 */
function describeFailure(error: unknown): string {
  if (error instanceof AppError)
    return `${error.code}: ${error.message}`.slice(0, FAILURE_MAX_CHARS)
  let root: unknown = error
  for (let depth = 0; root instanceof Error && root.cause instanceof Error && depth < 5; depth++) {
    root = root.cause
  }
  if (root instanceof Error) {
    return `${root.name}: ${root.message.split("\n")[0] ?? ""}`.slice(0, FAILURE_MAX_CHARS)
  }
  return "unknown error"
}

// ---------------------------------------------------------------------------------------------
// Occurrences.
// ---------------------------------------------------------------------------------------------

export const BUCKET_MINUTES = 30
/** More buckets than this is a caller's mistake (about 41 days); the read refuses it. */
export const MAX_BUCKETS = 2000

/**
 * Signals with `dedupeKey` (any item's) counted in 30-minute buckets aligned to `from`: bucket `i`
 * is `[from + 30 min * i, from + 30 min * (i + 1))`, zero-filled, and the last one holds `to`
 * itself, so a range of zero length is one bucket. A reversed range is empty.
 */
export async function occurrenceBuckets(
  db: Database,
  input: { dedupeKey: string; from: Date; to: Date },
): Promise<{ at: Date; count: number }[]> {
  const { dedupeKey, from, to } = input
  const bucketMs = BUCKET_MINUTES * MINUTE_MS
  const span = to.getTime() - from.getTime()
  if (span < 0) return []
  const n = Math.floor(span / bucketMs) + 1
  if (n > MAX_BUCKETS) {
    throw new AppError("BAD_REQUEST", `A range of ${n} buckets is over ${MAX_BUCKETS}.`)
  }
  const index = sql<number>`floor(extract(epoch from (${signals.occurredAt} - ${from.toISOString()}::timestamptz)) / ${BUCKET_MINUTES * 60})::int`
  const rows = await db
    .select({ i: index, count: sql<number>`count(*)::int` })
    .from(signals)
    .where(
      and(
        eq(signals.dedupeKey, dedupeKey),
        gte(signals.occurredAt, from),
        lte(signals.occurredAt, to),
      ),
    )
    .groupBy(sql`1`)
  const counts = new Map(rows.map((r) => [r.i, r.count]))
  return Array.from({ length: n }, (_, i) => ({
    at: new Date(from.getTime() + i * bucketMs),
    count: counts.get(i) ?? 0,
  }))
}
