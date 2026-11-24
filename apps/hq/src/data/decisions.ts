// A founder's decisions on a work item: approve a merge, stop, reopen, grant one more attempt,
// ask for a revert. Each locks the item's row first and moves state only through `transitionItem`,
// so the machine decides what is allowed; this file adds the facts the machine does not hold (the
// head sha an approval is bound to, the current pull request) and the side effects of a decision
// (a stop ends what was waiting on the item). Approving only records a decision: hq calls nothing
// and merges nothing.
//
// Events written in one call share `now`; each one after the first is one millisecond later, in
// story order, so ordering by (at, id) tells the story.
import type { Database } from "@proof/db"
import { AppError } from "@proof/errors"
import { and, asc, eq, inArray } from "drizzle-orm"

import {
  agentQuestions,
  attempts,
  mergeApprovals,
  pullRequests,
  verificationWindows,
  workItems,
} from "../db/schema"
import { NOTE_MAX_CHARS } from "../work/constants"
import { deriveAttention } from "../work/machine"
import { type VoidReason, voidMergeApprovals } from "./merge-approvals"
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

const bad = (message: string, field: string) =>
  new AppError("BAD_REQUEST", message, { context: { field } })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A commit id as git prints it: 7 to 64 hex digits (the form pull-requests.ts stores, lower-cased). */
const HEAD_SHA = /^[0-9a-f]{7,64}$/i
const FOUNDER_ID_MAX_CHARS = 200

const SYSTEM: Actor = { type: "system", id: "hq" }

/** A uuid, lower-cased (ids are stored that way). A work item's `FAC-<n>` is for the operations to resolve. */
export function checkUuid(field: string, value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw bad(`${field} must be a uuid`, field)
  return value.toLowerCase()
}

export const checkFounderId = (value: unknown): string =>
  checkText("founderId", value, { max: FOUNDER_ID_MAX_CHARS })

/** An optional free-text note: capped at NOTE_MAX_CHARS, trimmed, and none when blank. */
export function optionalNote(field: string, value: unknown): string | null {
  if (value === undefined || value === null) return null
  return checkText(field, value, { max: NOTE_MAX_CHARS, allowEmpty: true }).trim() || null
}

/** One millisecond later each call, starting one after `now`: the clock of one call's later events. */
const ticker = (now: Date) => {
  let n = 0
  return () => new Date(now.getTime() + ++n)
}

// ---------------------------------------------------------------------------------------------
// Side effects a decision shares.
// ---------------------------------------------------------------------------------------------

/**
 * End the item's running verification window of its CURRENT cycle (`stopped` when a founder ended
 * it, `failed` when a signal or a contract check came back, `passed` when the sweep verified it),
 * stamp `checked_at` with `now` and write one `window_closed` event at `eventAt()` (default `now`).
 * Does nothing, and says so, when there is no running window: an item still in `deploy`, or one
 * whose window already closed. The caller holds the item's lock. Returns whether a window was
 * closed.
 */
export async function closeRunningWindow(
  tx: Tx,
  input: {
    item: Pick<WorkItemRow, "id" | "cycle">
    status: "failed" | "stopped" | "passed"
    note?: string
    actor: Actor
    now: Date
    /** The instant of the event, asked for only when a window is closed (so no tick is wasted). */
    eventAt?: () => Date
  },
): Promise<boolean> {
  const { item, now } = input
  const [row] = await tx
    .update(verificationWindows)
    .set({ status: input.status, checkedAt: now, resultNote: input.note ?? null })
    .where(
      and(
        eq(verificationWindows.itemId, item.id),
        eq(verificationWindows.cycle, item.cycle),
        eq(verificationWindows.status, "running"),
      ),
    )
    .returning({ id: verificationWindows.id })
  if (!row) return false
  await appendEvent(tx, {
    itemId: item.id,
    at: input.eventAt?.() ?? now,
    kind: "window_closed",
    actor: input.actor,
    note: input.note ?? null,
    detail: { windowId: row.id, status: input.status },
    cycle: item.cycle,
  })
  return true
}

/**
 * Void the item's approvals in `statuses` on its OPEN pull requests (a stop, say): those are the
 * ones that could still authorize a merge. An approval on a merged or closed pull request was
 * already acted on and keeps its status, as the record of what the founder decided.
 */
async function voidItemApprovals(
  tx: Tx,
  item: Pick<WorkItemRow, "id" | "cycle">,
  statuses: readonly ("pending" | "approved")[],
  reason: VoidReason,
  at: () => Date,
): Promise<void> {
  const rows = await tx
    .selectDistinct({ pullRequestId: mergeApprovals.pullRequestId })
    .from(mergeApprovals)
    .innerJoin(pullRequests, eq(pullRequests.id, mergeApprovals.pullRequestId))
    .where(
      and(
        eq(mergeApprovals.itemId, item.id),
        inArray(mergeApprovals.status, [...statuses]),
        eq(pullRequests.state, "open"),
      ),
    )
  for (const { pullRequestId } of rows) {
    await voidMergeApprovals(tx, {
      itemId: item.id,
      pullRequestId,
      statuses,
      reason,
      cycle: item.cycle,
      at,
    })
  }
}

// ---------------------------------------------------------------------------------------------
// Approve a merge.
// ---------------------------------------------------------------------------------------------

/**
 * Record a founder's go-ahead to merge the item's pull request at one head sha. It changes nothing
 * on GitHub and moves no state (the merge is observed later). The checks, in order, each a CONFLICT
 * that writes nothing: the item is in `review`; its CURRENT pull request exists and is `open`; that
 * pull request has a `pending` approval (a second approve finds none); the sha the founder saw
 * (lower-cased) is that approval's and the pull request's head now, else "The pull request changed
 * since you looked". An approval bound to an older pull request of the item, or left pending by a
 * retry that moved the item out of `review`, can therefore never be approved.
 */
export async function approveMerge(
  db: Database,
  input: { itemId: string; headSha: string; note?: string; founderId: string; now: Date },
): Promise<{ headSha: string; pullRequestUrl: string }> {
  const itemId = checkUuid("itemId", input.itemId)
  const headSha = checkText("headSha", input.headSha, { max: 64 })
  if (!HEAD_SHA.test(headSha)) throw bad("headSha must be a commit id", "headSha")
  const sha = headSha.toLowerCase()
  const note = optionalNote("note", input.note)
  const founderId = checkFounderId(input.founderId)
  const { now } = input
  return db.transaction(async (tx) => {
    const item = await lockItem(tx, itemId)
    if (item.state !== "review") {
      throw new AppError(
        "CONFLICT",
        `A merge can be approved only while the work item is in review, not in ${item.state}.`,
        { context: { state: item.state } },
      )
    }
    const pr = await currentPullRequest(tx, item)
    if (!pr || pr.state !== "open") {
      throw new AppError("CONFLICT", "The pull request is not open.", {
        context: { pullRequestState: pr?.state ?? "none" },
      })
    }
    const [pending] = await tx
      .select()
      .from(mergeApprovals)
      .where(and(eq(mergeApprovals.pullRequestId, pr.id), eq(mergeApprovals.status, "pending")))
    if (!pending) {
      // The founder saw a head that is no longer the pull request's: a push voided the approval.
      if (sha !== pr.headSha) {
        throw new AppError("CONFLICT", "The pull request changed since you looked", {
          hint: "Read the work item again and approve the head it shows now.",
        })
      }
      const [decided] = await tx
        .select({ id: mergeApprovals.id })
        .from(mergeApprovals)
        .where(
          and(
            eq(mergeApprovals.pullRequestId, pr.id),
            eq(mergeApprovals.headSha, sha),
            eq(mergeApprovals.status, "approved"),
          ),
        )
      throw new AppError(
        "CONFLICT",
        decided
          ? "This merge is already approved."
          : "No merge approval is waiting for this pull request.",
        { hint: "Read the work item again." },
      )
    }
    if (pending.headSha !== sha || pr.headSha !== sha) {
      throw new AppError("CONFLICT", "The pull request changed since you looked", {
        hint: "Read the work item again and approve the head it shows now.",
      })
    }
    const [row] = await tx
      .update(mergeApprovals)
      .set({ status: "approved", decidedBy: founderId, decidedAt: now, note })
      .where(and(eq(mergeApprovals.id, pending.id), eq(mergeApprovals.status, "pending")))
      .returning({ id: mergeApprovals.id })
    if (!row) throw new AppError("CONFLICT", "This merge approval was decided first.")
    await appendEvent(tx, {
      itemId: item.id,
      at: now,
      kind: "merge_approved",
      actor: { type: "founder", id: founderId },
      note,
      detail: {
        approvalId: pending.id,
        pullRequestId: pr.id,
        pullRequestNumber: pr.number,
        headSha: sha,
      },
      cycle: item.cycle,
    })
    return { headSha: sha, pullRequestUrl: pr.url }
  })
}

// ---------------------------------------------------------------------------------------------
// Stop, reopen, retry, revert.
// ---------------------------------------------------------------------------------------------

/**
 * Stop an in-flight item (the machine says which states have a founder edge: anything else is
 * CONFLICT and nothing is written). In the same transaction, in this order: a running verification
 * window ends as `stopped`; every pending or approved merge approval on an OPEN pull request is voided (a stopped item
 * holds no live go-ahead; one on a merged or closed pull request was already acted on and stays); every `requested` attempt ends as `abandoned` (otherwise it would block
 * the item for good); open questions are withdrawn. A `running` attempt is left alone: hq cannot
 * reach the agent, the attempt's lease and the sweep end it, and what it still reports belongs on
 * the ledger.
 */
export async function stopItem(
  db: Database,
  input: { itemId: string; note?: string; founderId: string; now: Date },
): Promise<WorkItemRow> {
  const itemId = checkUuid("itemId", input.itemId)
  const note = optionalNote("note", input.note)
  const founderId = checkFounderId(input.founderId)
  const { now } = input
  const founder: Actor = { type: "founder", id: founderId }
  return db.transaction(async (tx) => {
    const found = await lockItem(tx, itemId)
    // The questions this stop withdraws, named in the stop's own event (no event kind for it).
    const open = await tx
      .select({ id: agentQuestions.id })
      .from(agentQuestions)
      .where(and(eq(agentQuestions.itemId, found.id), eq(agentQuestions.status, "open")))
      .orderBy(asc(agentQuestions.createdAt), asc(agentQuestions.id))
    const item = await transitionItem(tx, {
      item: found,
      to: "stopped",
      actor: founder,
      reason: "stopped",
      ...(note === null ? {} : { note }),
      ...(open.length === 0 ? {} : { detail: { withdrawnQuestionIds: open.map((q) => q.id) } }),
      now,
    })
    const at = ticker(now)
    await closeRunningWindow(tx, {
      item,
      status: "stopped",
      actor: SYSTEM,
      now,
      eventAt: at,
    })
    await voidItemApprovals(tx, item, ["pending", "approved"], "stopped", at)
    const ended = await tx
      .update(attempts)
      .set({ status: "finished", result: "abandoned", finishedAt: now })
      .where(and(eq(attempts.itemId, item.id), eq(attempts.status, "requested")))
      .returning({ id: attempts.id, number: attempts.number, kind: attempts.kind })
    for (const a of ended.sort((x, y) => x.number - y.number)) {
      await appendEvent(tx, {
        itemId: item.id,
        at: at(),
        kind: "attempt_abandoned",
        actor: SYSTEM,
        detail: { attemptId: a.id, number: a.number, kind: a.kind, reason: "stopped" },
        cycle: item.cycle,
      })
    }
    await tx
      .update(agentQuestions)
      .set({ status: "withdrawn" })
      .where(and(eq(agentQuestions.itemId, item.id), eq(agentQuestions.status, "open")))
    return item
  })
}

/**
 * Take an item back: `done` and `verify` go to `reopened` (the sweep retriages it into the next
 * cycle), `stopped` goes straight to `triage`. The move into `triage` adds the 1 to `cycle`
 * (`transitionItem` owns it: this never adds another). Any other state, `reopened` included, is
 * CONFLICT. A running verification window ends as `stopped`.
 */
export async function reopenItem(
  db: Database,
  input: { itemId: string; note?: string; founderId: string; now: Date },
): Promise<WorkItemRow> {
  const itemId = checkUuid("itemId", input.itemId)
  const note = optionalNote("note", input.note)
  const founderId = checkFounderId(input.founderId)
  const { now } = input
  return db.transaction(async (tx) => {
    const found = await lockItem(tx, itemId)
    const item = await transitionItem(tx, {
      item: found,
      to: found.state === "stopped" ? "triage" : "reopened",
      actor: { type: "founder", id: founderId },
      reason: "reopened",
      ...(note === null ? {} : { note }),
      now,
    })
    if (found.state === "verify") {
      await closeRunningWindow(tx, {
        item: found,
        status: "stopped",
        actor: SYSTEM,
        now,
        eventAt: ticker(now),
      })
    }
    return item
  })
}

/**
 * A founder grants one more fix attempt to an item that used its budget: the item's own limit goes
 * up by 1 and a `retry_granted` event carries the founder's note (required). The item must be
 * exhausted: the attention rules say `attempt_budget` once a question or a merge approval is set
 * aside (those are other needs of the item, not signs of a budget that is not spent).
 */
export async function retryItem(
  db: Database,
  input: { itemId: string; note: string; founderId: string; now: Date },
): Promise<{ attemptLimit: number }> {
  const itemId = checkUuid("itemId", input.itemId)
  const note = checkText("note", input.note, { max: NOTE_MAX_CHARS }).trim()
  if (note.length === 0) throw bad("note must not be empty", "note")
  const founderId = checkFounderId(input.founderId)
  const { now } = input
  return db.transaction(async (tx) => {
    const item = await lockItem(tx, itemId)
    const facts = await loadFacts(tx, item, now)
    const attention = deriveAttention({
      ...facts,
      pendingMergeApproval: false,
      openQuestion: false,
    })
    if (attention !== "attempt_budget" || item.attemptLimit === null) {
      throw new AppError(
        "CONFLICT",
        "This work item has attempts left, or is not waiting on one.",
        {
          context: { state: item.state, attemptsUsed: facts.attemptsUsed },
        },
      )
    }
    const from = item.attemptLimit
    const [row] = await tx
      .update(workItems)
      .set({ attemptLimit: from + 1, updatedAt: now })
      .where(and(eq(workItems.id, item.id), eq(workItems.attemptLimit, from)))
      .returning({ attemptLimit: workItems.attemptLimit })
    if (!row || row.attemptLimit === null) {
      throw new AppError("CONFLICT", "The work item changed while this change was in flight.")
    }
    await appendEvent(tx, {
      itemId: item.id,
      at: now,
      kind: "retry_granted",
      actor: { type: "founder", id: founderId },
      note,
      detail: { from, to: row.attemptLimit },
      cycle: item.cycle,
    })
    return { attemptLimit: row.attemptLimit }
  })
}

/**
 * A founder asks for a merged change to be reverted: the item (in `deploy`, `verify` or `done`,
 * with a merged pull request in its current cycle) goes to `reopened` with reason `revert_requested`,
 * and a `revert_requested` event keeps the note and the pull request's url. hq reverts nothing:
 * the sweep retriages the item and a normal fix attempt does the work. A running verification
 * window ends as `stopped`.
 */
export async function requestRevert(
  db: Database,
  input: { itemId: string; note?: string; founderId: string; now: Date },
): Promise<WorkItemRow> {
  const itemId = checkUuid("itemId", input.itemId)
  const note = optionalNote("note", input.note)
  const founderId = checkFounderId(input.founderId)
  const { now } = input
  const founder: Actor = { type: "founder", id: founderId }
  return db.transaction(async (tx) => {
    const found = await lockItem(tx, itemId)
    const pr = await currentPullRequest(tx, found)
    if (!pr || pr.state !== "merged") {
      throw new AppError("CONFLICT", "A revert needs a merged pull request.", {
        context: { state: found.state, pullRequestState: pr?.state ?? "none" },
      })
    }
    const item = await transitionItem(tx, {
      item: found,
      to: "reopened",
      actor: founder,
      reason: "revert_requested",
      ...(note === null ? {} : { note }),
      now,
    })
    const at = ticker(now)
    await closeRunningWindow(tx, {
      item: found,
      status: "stopped",
      actor: SYSTEM,
      now,
      eventAt: at,
    })
    await appendEvent(tx, {
      itemId: item.id,
      at: at(),
      kind: "revert_requested",
      actor: founder,
      note,
      detail: { pullRequestUrl: pr.url, pullRequestNumber: pr.number, headSha: pr.headSha },
      cycle: item.cycle,
    })
    return item
  })
}
