// The pipeline's part of the digest: what the work items did in a window, counted from rows.
// `readDigest` (data/digest.ts) calls this after its own reads; it is read-only.
//
// Honest data: every number is a count of rows. An item is "resolved" when the sweep moved it to
// `done`, which the machine allows only once its verification window passed with every contract
// item passing; a verifier that is not connected (`sentry`, `posthog`) can never pass, so it is
// never counted. The state of an item is no source for any count: only its history (the
// `work_item_events` rows) says what happened in a window. What waits for a founder is hq's own
// board rule (`workBoard`), not a second count.
//
// An hq deployed before the work migrations has no work tables: `workTablesExist` answers that in
// one query first, and the pipeline is `null`.
import type { Database } from "@proof/db"
import { and, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm"

import { attempts, pullRequests, workItemEvents, workItems } from "../db/schema"
import { type Attention, displayId, type WorkState, WORK_STAGES } from "../work/machine"
import { workTablesExist } from "./work-available"
import { pullRequestUrl, workBoard } from "./work-board"

export const MAX_NEEDS_YOU = 5
export const MAX_MERGED = 10
export const MAX_PIPELINE_EVENTS = 30

export type DigestMergedState = "merged" | "verifying" | "verified" | "reopened"
export type DigestEventResult = "opened" | "merged" | "reopened" | "verified" | "stopped"

export interface DigestPipelineRow {
  opened: number
  resolved: number
  reopened: number
  stuckAttempts: number
  needsYou: {
    kind: Attention
    itemId: string
    displayId: string
    title: string
    reason: string
    since: Date
  }[]
  needsYouTotal: number
  merged: {
    at: Date
    displayId: string
    title: string
    pullRequestUrl: string
    /** The item's repo and the pull request's number: what a link check needs. */
    repo: string
    number: number
    state: DigestMergedState
  }[]
  events: { at: Date; displayId: string; text: string; result: DigestEventResult }[]
}

/**
 * What the digest says of a merged pull request. `reopened` needs a row: a reopen transition of
 * the item at or after the merge (`reopenedSince`). The item's state alone is no proof (another
 * pull request of the cycle can be the current one, so merging this one moves nothing). Without
 * that row, an end state says what it knows (`verify`, `done`), and any other state says only that
 * the pull request merged. A founder's stop after the merge stays `merged`: nothing else is known.
 */
function mergedState(state: WorkState, reopenedSince: boolean): DigestMergedState {
  if (reopenedSince) return "reopened"
  if (state === "verify") return "verifying"
  if (state === "done") return "verified"
  return "merged"
}

/** Which of an item's moves the digest tells, by the state it moved to (and why, for deploy). */
const RESULT_BY_STATE: Partial<Record<WorkState, DigestEventResult>> = {
  triage: "opened",
  deploy: "merged",
  reopened: "reopened",
  done: "verified",
  stopped: "stopped",
}

/** The moves the digest tells; any other transition is not an event of the window. */
const TOLD = sql`(
  (${workItemEvents.toState} = 'triage' and ${workItemEvents.reason} = 'ingested')
  or (${workItemEvents.toState} = 'deploy' and ${workItemEvents.reason} = 'pull_request_merged')
  or ${workItemEvents.toState} in ('reopened', 'done', 'stopped')
)`

export async function readDigestPipeline(
  db: Database,
  input: { since: Date; until: Date },
): Promise<DigestPipelineRow | null> {
  if (!(await workTablesExist(db))) return null
  const { since, until } = input
  const inWindow = and(
    eq(workItemEvents.kind, "transition"),
    gte(workItemEvents.at, since),
    lt(workItemEvents.at, until),
  )

  const [counts] = await db
    .select({
      opened: sql<number>`(count(distinct ${workItemEvents.itemId}) filter (where ${workItemEvents.toState} = 'triage' and ${workItemEvents.reason} = 'ingested'))::int`,
      resolved: sql<number>`(count(distinct ${workItemEvents.itemId}) filter (where ${workItemEvents.toState} = 'done'))::int`,
      reopened: sql<number>`(count(distinct ${workItemEvents.itemId}) filter (where ${workItemEvents.toState} = 'reopened'))::int`,
    })
    .from(workItemEvents)
    .where(inWindow)

  // A running attempt whose lease has run out (the sweep's `listStaleAttempts` rule) on an item in
  // flight. A requested or finished attempt has no lease to lose.
  const [stuck] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(attempts)
    .innerJoin(workItems, eq(workItems.id, attempts.itemId))
    // Items in flight only, as the board counts: a stop leaves its running attempt to the lease, and
    // the attempt is on no card and asks nothing of a founder (the sweep still abandons it).
    .where(
      and(
        eq(attempts.status, "running"),
        lte(attempts.leaseExpiresAt, until),
        inArray(workItems.state, [...WORK_STAGES]),
      ),
    )

  const board = await workBoard(db, until)

  const mergedRows = await db
    .select({
      at: pullRequests.mergedAt,
      number: pullRequests.number,
      url: pullRequests.url,
      itemNumber: workItems.number,
      repo: workItems.repo,
      title: workItems.title,
      state: workItems.state,
      reopenedSince: sql<boolean>`exists (
        select 1 from ${workItemEvents}
        where ${workItemEvents.itemId} = ${pullRequests.itemId}
          and ${workItemEvents.kind} = 'transition'
          and ${workItemEvents.toState} = 'reopened'
          and ${workItemEvents.at} >= ${pullRequests.mergedAt})`,
    })
    .from(pullRequests)
    .innerJoin(workItems, eq(workItems.id, pullRequests.itemId))
    .where(
      and(
        eq(pullRequests.state, "merged"),
        gte(pullRequests.mergedAt, since),
        lt(pullRequests.mergedAt, until),
      ),
    )
    .orderBy(desc(pullRequests.mergedAt), desc(pullRequests.id))
    .limit(MAX_MERGED)

  const eventRows = await db
    .select({
      at: workItemEvents.at,
      toState: workItemEvents.toState,
      itemNumber: workItems.number,
      title: workItems.title,
    })
    .from(workItemEvents)
    .innerJoin(workItems, eq(workItems.id, workItemEvents.itemId))
    .where(and(inWindow, TOLD))
    .orderBy(desc(workItemEvents.at), desc(workItemEvents.id))
    .limit(MAX_PIPELINE_EVENTS)

  return {
    opened: counts?.opened ?? 0,
    resolved: counts?.resolved ?? 0,
    reopened: counts?.reopened ?? 0,
    stuckAttempts: stuck?.n ?? 0,
    needsYou: board.needsYou.slice(0, MAX_NEEDS_YOU).map((n) => ({
      kind: n.kind,
      itemId: n.itemId,
      displayId: n.displayId,
      title: n.title,
      reason: n.reason,
      since: n.since,
    })),
    needsYouTotal: board.needsYou.length,
    merged: mergedRows.flatMap((r) =>
      r.at === null
        ? []
        : [
            {
              at: r.at,
              displayId: displayId(r.itemNumber),
              title: r.title,
              pullRequestUrl: pullRequestUrl(r.repo, r.number, r.url),
              repo: r.repo,
              number: r.number,
              state: mergedState(r.state, r.reopenedSince),
            },
          ],
    ),
    events: eventRows.flatMap((e) => {
      const result = e.toState === null ? undefined : RESULT_BY_STATE[e.toState]
      return result === undefined
        ? []
        : [{ at: e.at, displayId: displayId(e.itemNumber), text: e.title, result }]
    }),
  }
}
