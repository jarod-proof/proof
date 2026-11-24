// Pull requests: what GitHub says about the pull request of an item's fix, as the agent reports it
// (hq calls nothing). A pull request is found by the item or by the branch of the item's newest
// attempt that has it, its url must be that item's own repo's, and its state drives the item:
// opened takes `attempt` to `review`, merged takes `review` to `deploy`, closed takes `review` to
// `stopped`. A new head sha voids a merge approval; so does a close or a merge. The item's row is
// locked first and every state move goes through `transitionItem`.
import type { Database } from "@proof/db"
import { AppError } from "@proof/errors"
import { and, desc, eq, sql } from "drizzle-orm"

import { attempts, pullRequests, workItems } from "../db/schema"
import {
  HEAD_SHA_PATTERN,
  PULL_REQUEST_STATES,
  type PullRequestCheck,
  type RecordPullRequestInput,
} from "../work/types"
import type { WorkState } from "../work/machine"
import { BRANCH_MAX_CHARS } from "./attempts"
import { ensureMergeApproval, voidMergeApprovals } from "./merge-approvals"
import { appendEvent } from "./work-events"
import {
  type Actor,
  checkText,
  currentPullRequest,
  lockItem,
  resolveItem,
  transitionItem,
  type Tx,
  URL_MAX_CHARS,
  type WorkItemRow,
} from "./work-items"

export const BASE_MAX_CHARS = 200
export const CHECK_NAME_MAX_CHARS = 200
export const CHECKS_MAX = 100
export const MERGED_BY_MAX_CHARS = 100
const INT_MAX = 2_147_483_647
/** The shape every pull request url has, whatever the item: https, github.com, owner/name/pull/n. */
const GITHUB_PULL_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*$/i

const SYSTEM: Actor = { type: "system", id: "hq" }

/**
 * A merge ends what was still waiting for a start: the item's `requested` attempts (a founder's
 * request made while it was in `review`) end as `abandoned` with the note `merged`, one
 * `attempt_abandoned` event each, oldest first, at `next()` (after the move's own event). Left
 * alone they would count as the item's active attempt for good (`assertNoActive`, `loadFacts`), so a
 * reopened item could never be worked again. A `running` attempt is not touched: its lease ends it.
 */
async function abandonRequestedAttempts(
  tx: Tx,
  item: Pick<WorkItemRow, "id" | "cycle">,
  next: () => Date,
): Promise<void> {
  const waiting = await tx
    .select({ id: attempts.id })
    .from(attempts)
    .where(and(eq(attempts.itemId, item.id), eq(attempts.status, "requested")))
  // No tick is spent when nothing waits: the events after this keep the instants they had.
  if (waiting.length === 0) return
  const ended = await tx
    .update(attempts)
    .set({ status: "finished", result: "abandoned", finishedAt: next(), note: "merged" })
    .where(and(eq(attempts.itemId, item.id), eq(attempts.status, "requested")))
    .returning({ id: attempts.id, number: attempts.number, kind: attempts.kind })
  for (const a of ended.sort((x, y) => x.number - y.number)) {
    await appendEvent(tx, {
      itemId: item.id,
      at: next(),
      kind: "attempt_abandoned",
      actor: SYSTEM,
      note: "merged",
      detail: { attemptId: a.id, number: a.number, kind: a.kind, reason: "merged" },
      cycle: item.cycle,
    })
  }
}

const bad = (message: string, field: string) =>
  new AppError("BAD_REQUEST", message, { context: { field } })

function checkInt(field: string, value: unknown, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > INT_MAX) {
    throw bad(`${field} must be a whole number of at least ${min}`, field)
  }
  return value
}

const optionalInt = (field: string, value: unknown): number | undefined =>
  value === undefined ? undefined : checkInt(field, value, 0)

function checkChecks(value: unknown): PullRequestCheck[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw bad("checks must be a list", "checks")
  if (value.length > CHECKS_MAX) throw bad(`checks is over ${CHECKS_MAX} entries`, "checks")
  return value.map((c: unknown) => {
    const check = (c ?? {}) as Partial<PullRequestCheck>
    if (check.state !== "passed" && check.state !== "failed" && check.state !== "pending") {
      throw bad("a check's state must be passed, failed or pending", "checks")
    }
    return {
      name: checkText("checks.name", check.name, { max: CHECK_NAME_MAX_CHARS }),
      state: check.state,
    }
  })
}

/** Existing checks keep their place; a check of the same name is replaced; new ones are appended. */
function upsertChecks(
  existing: readonly PullRequestCheck[],
  incoming: readonly PullRequestCheck[],
): PullRequestCheck[] {
  const merged = new Map(existing.map((c) => [c.name, c]))
  for (const c of incoming) merged.set(c.name, c)
  if (merged.size > CHECKS_MAX) throw bad(`checks is over ${CHECKS_MAX} entries`, "checks")
  return [...merged.values()]
}

/**
 * The item a call is about: `itemId`; else the item that already holds this pull request (its repo
 * and number, newest first), because a recorded pull request belongs to the item it was recorded
 * on whatever branch another item's attempt has since reported (two items can pick one branch
 * slug); else, for a number not yet recorded, the item of the newest attempt that reported the
 * branch.
 */
async function findItem(
  db: Database,
  itemRef: string | undefined,
  branch: string,
  number: number,
  repo: string,
): Promise<WorkItemRow | null> {
  if (itemRef !== undefined) return resolveItem(db, checkText("itemId", itemRef, { max: 200 }))
  const [recorded] = await db
    .select({ itemId: pullRequests.itemId })
    .from(pullRequests)
    .innerJoin(workItems, eq(workItems.id, pullRequests.itemId))
    .where(and(eq(workItems.repo, repo), eq(pullRequests.number, number)))
    .orderBy(desc(pullRequests.openedAt), desc(pullRequests.id))
    .limit(1)
  if (recorded) return resolveItem(db, recorded.itemId)
  const [byAttempt] = await db
    .select({ itemId: attempts.itemId })
    .from(attempts)
    .where(eq(attempts.branch, branch))
    .orderBy(desc(attempts.createdAt), desc(attempts.number), desc(attempts.id))
    .limit(1)
  return byAttempt ? resolveItem(db, byAttempt.itemId) : null
}

/**
 * Record (create or update) the pull request `number` of an item. The call is idempotent: the
 * agent sends the full set on every pull request event, and a repeat changes nothing. Rules:
 *
 * - `url` is `https://github.com/<item repo>/pull/<number>` (repo compared lower-cased), else
 *   BAD_REQUEST; the stored url is that canonical form.
 * - No item for the branch is `matched: false`, not an error.
 * - A new row needs `base`, `headSha`, `isDraft` and `state`; an existing row keeps what is not sent.
 * - `mergedAt` and `mergedBy` are accepted only with `state: "merged"`, are set once (`mergedAt`
 *   is clamped to `now` and defaults to it). `merged` is final: another state, or another head, is CONFLICT.
 * - A move is driven by news (a new row, a state change or, for `open`, a new head sha): the agent
 *   re-sends the whole set on every check or label event, and that must not pull an item whose retry
 *   is running back to review, nor move it again on a redelivered merge. `open` takes `attempt` to
 *   `review`; `merged` takes `review` to `deploy`, and from `attempt` takes both hops; `closed`
 *   takes `review` to `stopped`.
 * - The item is the one that already holds the pull request (repo and number), else the item of the
 *   newest attempt that reported the branch (`findItem`).
 * - Only the item's pull request for its current cycle moves it (`currentPullRequest`): a
 *   redelivered merge of an earlier cycle's pull request, or an older pull request of this cycle,
 *   is recorded and moves nothing.
 * - A new head sha voids a pending or approved merge approval; closed and merged void a pending one.
 *
 * Every event of one call is written one millisecond after the last, so ordering by (at, id) tells
 * the story: the pull request, the voids, the moves, the new approval.
 */
export async function recordPullRequest(
  db: Database,
  input: RecordPullRequestInput & { actor: Actor; now: Date },
): Promise<{ matched: boolean; itemId: string | null; state: WorkState | null }> {
  const { actor, now } = input
  const branch = checkText("branch", input.branch, { max: BRANCH_MAX_CHARS })
  const number = checkInt("number", input.number, 1)
  const url = checkText("url", input.url, { max: URL_MAX_CHARS })
  if (!GITHUB_PULL_URL.test(url)) {
    throw bad("url must be https://github.com/<owner>/<repo>/pull/<number>", "url")
  }
  const base =
    input.base === undefined ? undefined : checkText("base", input.base, { max: BASE_MAX_CHARS })
  if (input.headSha !== undefined) {
    checkText("headSha", input.headSha, { max: 64 })
    if (!HEAD_SHA_PATTERN.test(input.headSha)) throw bad("headSha must be a commit id", "headSha")
  }
  const headSha = input.headSha?.toLowerCase()
  if (input.isDraft !== undefined && typeof input.isDraft !== "boolean") {
    throw bad("isDraft must be true or false", "isDraft")
  }
  if (
    input.state !== undefined &&
    !(PULL_REQUEST_STATES as readonly unknown[]).includes(input.state)
  ) {
    throw bad("state must be open, merged or closed", "state")
  }
  const additions = optionalInt("additions", input.additions)
  const deletions = optionalInt("deletions", input.deletions)
  const files = optionalInt("files", input.files)
  const checks = checkChecks(input.checks)
  const mergedBy =
    input.mergedBy === undefined
      ? undefined
      : checkText("mergedBy", input.mergedBy, { max: MERGED_BY_MAX_CHARS })
  if ((input.mergedAt !== undefined || mergedBy !== undefined) && input.state !== "merged") {
    throw bad("mergedAt and mergedBy are accepted only with state merged", "mergedAt")
  }
  let mergedAtInput: Date | undefined
  if (input.mergedAt !== undefined) {
    mergedAtInput = new Date(checkText("mergedAt", input.mergedAt, { max: 64 }))
    if (Number.isNaN(mergedAtInput.getTime())) throw bad("mergedAt is not a date", "mergedAt")
  }

  const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\//i.exec(url)?.[1]?.toLowerCase() ?? ""
  const found = await findItem(db, input.itemId, branch, number, repo)
  if (!found) return { matched: false, itemId: null, state: null }

  return db.transaction(async (tx) => {
    let item = await lockItem(tx, found.id)
    if (url.toLowerCase() !== `https://github.com/${item.repo}/pull/${number}`) {
      throw bad(`url must be a pull request of ${item.repo}`, "url")
    }
    const canonicalUrl = `https://github.com/${item.repo}/pull/${number}`
    const [existing] = await tx
      .select()
      .from(pullRequests)
      .where(and(eq(pullRequests.itemId, item.id), eq(pullRequests.number, number)))
    if (existing?.state === "merged") {
      if (input.state !== undefined && input.state !== "merged") {
        throw new AppError(
          "CONFLICT",
          `Pull request #${number} is merged and cannot be ${input.state}.`,
        )
      }
      if (headSha !== undefined && headSha !== existing.headSha) {
        throw new AppError("CONFLICT", `Pull request #${number} is merged: its head cannot change.`)
      }
    }
    if (!existing) {
      for (const [field, value] of [
        ["base", base],
        ["headSha", headSha],
        ["isDraft", input.isDraft],
        ["state", input.state],
      ] as const) {
        if (value === undefined)
          throw bad(`${field} is required for a pull request not yet recorded`, field)
      }
    }

    const state = input.state ?? existing?.state ?? "open"
    const nextHead = headSha ?? existing?.headSha ?? ""
    const headChanged = existing !== undefined && nextHead !== existing.headSha
    const stateChanged = existing === undefined || state !== existing.state
    const draftChanged =
      existing !== undefined && input.isDraft !== undefined && input.isDraft !== existing.isDraft
    const mergedAt =
      existing?.mergedAt ??
      (state === "merged"
        ? new Date(Math.min((mergedAtInput ?? now).getTime(), now.getTime()))
        : null)
    const closedAt =
      state === "closed"
        ? existing?.state === "closed"
          ? (existing.closedAt ?? now)
          : now
        : state === "open"
          ? null
          : (existing?.closedAt ?? null)

    const values = {
      state,
      headSha: nextHead,
      base: base ?? existing?.base ?? "",
      isDraft: input.isDraft ?? existing?.isDraft ?? false,
      additions: additions ?? existing?.additions ?? null,
      deletions: deletions ?? existing?.deletions ?? null,
      files: files ?? existing?.files ?? null,
      checks: checks ? upsertChecks(existing?.checks ?? [], checks) : (existing?.checks ?? []),
      mergedAt,
      mergedBy: existing?.mergedBy ?? mergedBy ?? null,
      closedAt,
      updatedAt: now,
    }
    let row: typeof pullRequests.$inferSelect | undefined
    if (existing) {
      ;[row] = await tx
        .update(pullRequests)
        .set(values)
        .where(eq(pullRequests.id, existing.id))
        .returning()
    } else {
      const [attempt] = await tx
        .select({ id: attempts.id })
        .from(attempts)
        .where(and(eq(attempts.itemId, item.id), eq(attempts.branch, branch)))
        // The current cycle's attempt first: a reused branch must tie the pull request to this
        // cycle (`currentPullRequest` reads the cycle through this attempt).
        .orderBy(
          desc(sql`(${attempts.cycle} = ${item.cycle})`),
          desc(attempts.createdAt),
          desc(attempts.number),
          desc(attempts.id),
        )
        .limit(1)
      ;[row] = await tx
        .insert(pullRequests)
        .values({
          id: crypto.randomUUID(),
          itemId: item.id,
          attemptId: attempt?.id ?? null,
          number,
          url: canonicalUrl,
          branch,
          // `openedAt` orders the item's pull requests (`currentPullRequest`: the newest is the
          // current one). A row first seen already merged was opened no later than its merge, and
          // `mergedAt` is the agent's word: an old one must not make a stale merge the item's
          // newest pull request, so it sorts where the merge happened, not where it was reported.
          openedAt: state === "merged" && mergedAt ? mergedAt : now,
          ...values,
        })
        .returning()
    }
    if (!row) throw new AppError("INTERNAL", "The pull request was not stored")
    const pull = row

    let tick = 0
    const next = () => new Date(now.getTime() + tick++)
    if (stateChanged || headChanged || draftChanged) {
      await appendEvent(tx, {
        itemId: item.id,
        at: next(),
        kind: "pull_request",
        actor,
        detail: {
          pullRequestId: pull.id,
          number,
          state,
          headSha: nextHead,
          isDraft: pull.isDraft,
          created: existing === undefined,
        },
        cycle: item.cycle,
      })
    }

    // Approvals that no longer mean what they said.
    if (headChanged) {
      await voidMergeApprovals(tx, {
        itemId: item.id,
        pullRequestId: pull.id,
        statuses: ["pending", "approved"],
        reason: "head_sha_changed",
        exceptHeadSha: nextHead,
        cycle: item.cycle,
        at: next,
      })
    }
    if (input.state === "closed" || input.state === "merged") {
      await voidMergeApprovals(tx, {
        itemId: item.id,
        pullRequestId: pull.id,
        statuses: ["pending"],
        reason: input.state === "closed" ? "pull_request_closed" : "merged",
        cycle: item.cycle,
        at: next,
      })
    }

    // The moves: only the item's pull request of its current cycle drives it.
    const current = await currentPullRequest(tx, item)
    if (current?.id === pull.id) {
      // A move is driven by news: a merge or a close is new only when the row's state changed, so
      // a redelivered merge (or any later event on a merged pull request) moves nothing.
      const newMerge = input.state === "merged" && stateChanged
      const newClose = input.state === "closed" && stateChanged
      const opened =
        item.state === "attempt" &&
        (newMerge || (state === "open" && (stateChanged || headChanged)))
      if (opened) {
        item = await transitionItem(tx, {
          item,
          to: "review",
          actor,
          reason: "pull_request_opened",
          now: next(),
        })
      }
      // The second hop of a merge from `attempt` is one millisecond after the first (`next`), so
      // its event orders after it; its `state_changed_at` is that instant too.
      if (newMerge && item.state === "review") {
        item = await transitionItem(tx, {
          item,
          to: "deploy",
          actor,
          reason: "pull_request_merged",
          now: next(),
        })
        await abandonRequestedAttempts(tx, item, next)
      }
      if (newClose && item.state === "review") {
        item = await transitionItem(tx, {
          item,
          to: "stopped",
          actor,
          reason: "pull_request_closed",
          now: next(),
        })
      }
    }

    await ensureMergeApproval(tx, item.id, next())
    return { matched: true, itemId: item.id, state: item.state }
  })
}
