// The factory's status: what the sidebar shows. Every query behind `get_factory_status` lives here.
//
// Honest data: hq has no heartbeat and no slots, so a runner here is only when its newest run
// started and how that run ended. Box-review runs never close (P4 learned item 5), so a box
// runner's outcome is never read: it is always null, whatever a row says.
import type { Database } from "@proof/db"
import { and, desc, eq, inArray, sql } from "drizzle-orm"

import {
  agentQuestions,
  proposals,
  type Runner,
  RUNNERS,
  type RunOutcome,
  runs,
  workItems,
} from "../db/schema"
import { WORK_STAGES } from "../work/machine"
import { type Allowance, readAllowance } from "./spend"
import { workTablesExist } from "./work-available"
import { workBoard } from "./work-board"

/** What waits in the work pipeline, for the sidebar badge and the Work screen's header. */
export interface WorkCounts {
  inFlight: number
  needsYou: number
  pendingMergeApprovals: number
  openQuestions: number
}

export interface FactoryStatusRow {
  pendingProposals: number
  runners: { runner: Runner; lastStartedAt: Date | null; lastOutcome: RunOutcome | null }[]
  allowance: Allowance
  /** Null when the work tables do not exist yet (an hq deployed before step 05). */
  work: WorkCounts | null
}

/**
 * The pipeline's counts, from the board's own rules (`workBoard`: what an item needs from a
 * founder is derived from its facts, never from raw pending rows). `openQuestions` counts every
 * open question of an item in flight, including one the item's card hides behind a merge approval.
 */
async function workCounts(db: Database, now: Date): Promise<WorkCounts | null> {
  if (!(await workTablesExist(db))) return null
  const board = await workBoard(db, now)
  const [questions] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentQuestions)
    .innerJoin(workItems, eq(workItems.id, agentQuestions.itemId))
    .where(and(eq(agentQuestions.status, "open"), inArray(workItems.state, [...WORK_STAGES])))
  return {
    inFlight: board.stats.inFlight,
    needsYou: board.stats.needsYou,
    pendingMergeApprovals: board.needsYou.filter((n) => n.kind === "merge_approval").length,
    openQuestions: questions?.count ?? 0,
  }
}

export async function factoryStatus(db: Database, now: Date): Promise<FactoryStatusRow> {
  const [pending] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(proposals)
    .where(eq(proposals.status, "pending"))

  const runners: FactoryStatusRow["runners"] = []
  for (const runner of RUNNERS) {
    const [last] = await db
      .select({ startedAt: runs.startedAt, outcome: runs.outcome })
      .from(runs)
      .where(eq(runs.runner, runner))
      .orderBy(desc(runs.startedAt), desc(runs.id))
      .limit(1)
    runners.push({
      runner,
      lastStartedAt: last?.startedAt ?? null,
      lastOutcome: runner === "box" ? null : (last?.outcome ?? null),
    })
  }

  return {
    pendingProposals: pending?.count ?? 0,
    runners,
    allowance: await readAllowance(db, now),
    work: await workCounts(db, now),
  }
}
