// The digest: what the factory did in a window, read from runs, proposals and the spend ledger.
// Every query behind `get_digest` lives here.
//
// Honest data: nothing here is derived from `endedAt` or `outcome` of a `box` run. Box-review runs
// keep both null today and nothing reports their liveness, so a box run is only ever "started", at
// its start, and is never finished, failed or stuck.
import type { Database } from "@proof/db"
import {
  type AnyColumn,
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  max,
  or,
  sql,
} from "drizzle-orm"

import {
  type EntryKind,
  type Runner,
  type RunOutcome,
  proposals,
  runs,
  type SpendSource,
  spend,
} from "../db/schema"
import { type DigestPipelineRow, readDigestPipeline } from "./digest-pipeline"
import { parseUnits, type Units } from "./money"
import { dayOf } from "./spend"

/** A run still open after this long, on a runner that closes its runs, is stuck. */
export const STUCK_AFTER_MINUTES = 60
/**
 * The runners whose runs close (they set `endedAt` and `outcome`). Box-review runs do not, so
 * `box` is not here: an open box run is normal, never stuck.
 */
export const STUCK_RUNNERS: readonly Runner[] = ["eve", "sandbox"]
export const MAX_DECISIONS = 5
export const MAX_EVENTS = 30

export type DigestResult = "started" | RunOutcome | "proposed" | "approved" | "rejected"

export interface DigestRow {
  summary: { runsFinished: number; runsFailed: number; pendingProposals: number }
  decisions: {
    proposalId: string
    entryKind: EntryKind
    title: string
    reason: string
    createdAt: Date
  }[]
  events: {
    at: Date
    kind: "run" | "proposal"
    ref: string
    text: string
    result: DigestResult
    cost: Units | null
  }[]
  spend: {
    total: Units
    estimated: Units
    bySource: { source: SpendSource; amount: Units }[]
  }
  health: { stuckRuns: number; lastRunStartedAt: Date | null }
  /** The work pipeline's part; null when the work tables do not exist yet (data/digest-pipeline.ts). */
  pipeline: DigestPipelineRow | null
}

/** A run that closes its runs: its `endedAt` and `outcome` mean something. */
const closes = sql`${runs.runner} <> 'box'`

/** The window is `[since, until)`. */
const within = (column: AnyColumn, since: Date, until: Date) =>
  and(gte(column, since), lt(column, until))

export async function readDigest(
  db: Database,
  input: { since: Date; until: Date },
): Promise<DigestRow> {
  const { since, until } = input

  const finishedInWindow = and(closes, within(runs.endedAt, since, until))
  const finished = await db
    .select({
      finished: sql<number>`count(*)::int`,
      failed: sql<number>`(count(*) filter (where ${runs.outcome} = 'failed'))::int`,
    })
    .from(runs)
    .where(finishedInWindow)

  const [pending] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(proposals)
    .where(eq(proposals.status, "pending"))

  const decisions = await db
    .select({
      proposalId: proposals.id,
      entryKind: proposals.kind,
      title: proposals.title,
      reason: proposals.reason,
      createdAt: proposals.createdAt,
    })
    .from(proposals)
    .where(eq(proposals.status, "pending"))
    .orderBy(asc(proposals.createdAt), asc(proposals.id))
    .limit(MAX_DECISIONS)

  // A run once: at its end when it ended in the window, else at its start. A box run is always at
  // its start, "started", and only when it started in the window.
  const runAt = sql<Date>`case when ${finishedInWindow} then ${runs.endedAt} else ${runs.startedAt} end`
  const runEvents = await db
    .select({
      id: runs.id,
      task: runs.task,
      at: runAt,
      result: sql<RunOutcome | null>`case when ${finishedInWindow} then ${runs.outcome} else null end`,
      cost: sql<string>`coalesce(sum(${spend.amountUsd}), 0)::text`,
    })
    .from(runs)
    .leftJoin(spend, eq(spend.runId, runs.id))
    .where(
      or(
        finishedInWindow,
        and(
          within(runs.startedAt, since, until),
          // a closing run that also ended in the window is the first branch's
          sql`not coalesce(${finishedInWindow}, false)`,
        ),
      ),
    )
    .groupBy(runs.id)
    .orderBy(desc(runAt), desc(runs.id))
    .limit(MAX_EVENTS)

  const proposed = await db
    .select({ id: proposals.id, title: proposals.title, at: proposals.createdAt })
    .from(proposals)
    .where(within(proposals.createdAt, since, until))
    .orderBy(desc(proposals.createdAt), desc(proposals.id))
    .limit(MAX_EVENTS)
  const decided = await db
    .select({
      id: proposals.id,
      title: proposals.title,
      at: proposals.decidedAt,
      status: proposals.status,
    })
    .from(proposals)
    .where(
      and(
        inArray(proposals.status, ["approved", "rejected"]),
        within(proposals.decidedAt, since, until),
      ),
    )
    .orderBy(desc(proposals.decidedAt), desc(proposals.id))
    .limit(MAX_EVENTS)

  const events: DigestRow["events"] = [
    ...runEvents.map((r) => ({
      at: new Date(r.at),
      kind: "run" as const,
      ref: r.id,
      text: r.task,
      result: (r.result ?? "started") as DigestResult,
      cost: parseUnits(r.cost),
    })),
    ...proposed.map((p) => ({
      at: p.at,
      kind: "proposal" as const,
      ref: p.id,
      text: p.title,
      result: "proposed" as const,
      cost: null,
    })),
    ...decided.flatMap((p) =>
      p.at && (p.status === "approved" || p.status === "rejected")
        ? [
            {
              at: p.at,
              kind: "proposal" as const,
              ref: p.id,
              text: p.title,
              result: p.status,
              cost: null,
            },
          ]
        : [],
    ),
  ]
    // Newest first; a tie falls back to the ref and the result so the order never wobbles.
    .sort(
      (a, b) =>
        b.at.getTime() - a.at.getTime() ||
        b.ref.localeCompare(a.ref) ||
        b.result.localeCompare(a.result),
    )
    .slice(0, MAX_EVENTS)

  // The ledger is per UTC day: every day the window touches, in full.
  const spendRows = await db
    .select({
      source: spend.source,
      amount: sql<string>`coalesce(sum(${spend.amountUsd}), 0)::text`,
      estimated: sql<string>`coalesce(sum(${spend.amountUsd}) filter (where ${spend.estimated}), 0)::text`,
    })
    .from(spend)
    .where(and(gte(spend.day, dayOf(since)), sql`${spend.day} <= ${dayOf(until)}`))
    .groupBy(spend.source)
    .orderBy(spend.source)
  const bySource = spendRows.map((r) => ({ source: r.source, amount: parseUnits(r.amount) }))

  const stuckBefore = new Date(until.getTime() - STUCK_AFTER_MINUTES * 60_000)
  const [stuck] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(runs)
    .where(
      and(
        isNull(runs.endedAt),
        inArray(runs.runner, [...STUCK_RUNNERS]),
        lt(runs.startedAt, stuckBefore),
      ),
    )
  const [last] = await db.select({ at: max(runs.startedAt) }).from(runs)

  return {
    summary: {
      runsFinished: finished[0]?.finished ?? 0,
      runsFailed: finished[0]?.failed ?? 0,
      pendingProposals: pending?.count ?? 0,
    },
    decisions,
    events,
    spend: {
      total: bySource.reduce((sum, r) => sum + r.amount, 0),
      estimated: spendRows.reduce((sum, r) => sum + parseUnits(r.estimated), 0),
      bySource,
    },
    health: { stuckRuns: stuck?.count ?? 0, lastRunStartedAt: last?.at ?? null },
    pipeline: await readDigestPipeline(db, { since, until }),
  }
}
