// Merge approvals: a founder's decision to merge one pull request at one head sha. This file makes
// the pending request and voids requests that no longer mean what they said; the founder's decision
// itself (approving) is the decisions' data layer. An approval is bound to the head sha: a push
// after the card loaded voids it, so approving the old sha is refused there.
import { and, desc, eq, inArray, isNull } from "drizzle-orm"

import { attempts, mergeApprovals, workItems } from "../db/schema"
import { appendEvent } from "./work-events"
import { currentPullRequest, type Actor, type Tx } from "./work-items"

const SYSTEM: Actor = { type: "system", id: "hq" }

export type VoidReason = "head_sha_changed" | "pull_request_closed" | "merged" | "stopped"

/**
 * Void the approvals of a pull request, one `merge_approval_void` event each (`reason` says why).
 * `statuses` picks which: a new head sha voids pending and approved ones, a closed or merged pull
 * request only pending ones. `exceptHeadSha` spares the rows bound to that head. The caller holds
 * the item's lock. Returns how many were voided.
 */
export async function voidMergeApprovals(
  tx: Tx,
  input: {
    itemId: string
    pullRequestId: string
    statuses: readonly ("pending" | "approved")[]
    reason: VoidReason
    exceptHeadSha?: string
    cycle: number
    /** The instant of each event, asked for once per void (a caller keeps its own ordering). */
    at: () => Date
  },
): Promise<number> {
  const rows = await tx
    .select()
    .from(mergeApprovals)
    .where(
      and(
        eq(mergeApprovals.pullRequestId, input.pullRequestId),
        inArray(mergeApprovals.status, [...input.statuses]),
      ),
    )
  let voided = 0
  for (const row of rows) {
    if (input.exceptHeadSha !== undefined && row.headSha === input.exceptHeadSha) continue
    // Compare-and-set: a decision that landed first (pending to approved) is not overwritten here
    // with a stale reading, and one voided twice writes one event.
    const [done] = await tx
      .update(mergeApprovals)
      .set({ status: "void" })
      .where(and(eq(mergeApprovals.id, row.id), eq(mergeApprovals.status, row.status)))
      .returning({ id: mergeApprovals.id })
    if (!done) continue
    voided += 1
    await appendEvent(tx, {
      itemId: input.itemId,
      at: input.at(),
      kind: "merge_approval_void",
      actor: SYSTEM,
      reason: input.reason,
      detail: {
        approvalId: row.id,
        pullRequestId: row.pullRequestId,
        headSha: row.headSha,
        was: row.status,
      },
      cycle: input.cycle,
    })
  }
  return voided
}

/**
 * Ask for a merge approval iff everything it needs is true: the item is in `review`, its current
 * cycle's pull request is open, the newest fix attempt of the cycle finished `approved`, that
 * verdict was given on this pull request's branch and head (its `branch` is null or the pull
 * request's, and its `reviewed_head_sha` is null or equals the pull request's head)
 * and no pending or approved row exists for this head. It makes one `pending` row bound to the
 * head and one `merge_approval_requested` event at `now`. Both `finishAttempt` and
 * `recordPullRequest` call it inside the item's lock, so either order of the two facts gives the
 * same one row; a second call finds the row and does nothing.
 *
 * A verdict given before any pull request existed (`reviewed_head_sha` null) is bound to the first
 * head this function sees, and stored on the attempt: otherwise a push would find the verdict
 * "unbound" and ask for an approval of the new head, as if the reviewer had read it.
 */
export async function ensureMergeApproval(tx: Tx, itemId: string, now: Date): Promise<void> {
  const [item] = await tx
    .select({ id: workItems.id, state: workItems.state, cycle: workItems.cycle })
    .from(workItems)
    .where(eq(workItems.id, itemId))
  if (!item || item.state !== "review") return
  const pr = await currentPullRequest(tx, item)
  if (!pr || pr.state !== "open") return
  const [fix] = await tx
    .select()
    .from(attempts)
    .where(
      and(eq(attempts.itemId, item.id), eq(attempts.cycle, item.cycle), eq(attempts.kind, "fix")),
    )
    .orderBy(desc(attempts.number))
    .limit(1)
  if (!fix || fix.status !== "finished" || fix.result !== "approved") return
  // The reviewer read the branch the fix reported. A pull request on another branch (a push to the
  // first fix's branch, a close and reopen of an older pull request) is not what it read, so
  // nothing is asked for: fail closed.
  if (fix.branch !== null && fix.branch !== pr.branch) return
  if (fix.reviewedHeadSha !== null && fix.reviewedHeadSha !== pr.headSha) return
  const [held] = await tx
    .select({ id: mergeApprovals.id })
    .from(mergeApprovals)
    .where(
      and(
        eq(mergeApprovals.pullRequestId, pr.id),
        eq(mergeApprovals.headSha, pr.headSha),
        inArray(mergeApprovals.status, ["pending", "approved"]),
      ),
    )
    .limit(1)
  if (held) return
  if (fix.reviewedHeadSha === null) {
    await tx
      .update(attempts)
      .set({ reviewedHeadSha: pr.headSha })
      .where(and(eq(attempts.id, fix.id), isNull(attempts.reviewedHeadSha)))
  }
  // The partial unique index (one pending per pull request) is the last word if two callers race.
  const [row] = await tx
    .insert(mergeApprovals)
    .values({
      id: crypto.randomUUID(),
      itemId: item.id,
      pullRequestId: pr.id,
      headSha: pr.headSha,
      status: "pending",
      requestedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: mergeApprovals.id })
  if (!row) return
  await appendEvent(tx, {
    itemId: item.id,
    at: now,
    kind: "merge_approval_requested",
    actor: SYSTEM,
    detail: {
      approvalId: row.id,
      pullRequestId: pr.id,
      pullRequestNumber: pr.number,
      headSha: pr.headSha,
      attemptId: fix.id,
    },
    cycle: item.cycle,
  })
}
