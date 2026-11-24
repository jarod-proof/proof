// The factory's status: what the sidebar shows. Every query behind `get_factory_status` lives here.
//
// Honest data: hq has no heartbeat and no slots, so a runner here is only when its newest run
// started and how that run ended. Box-review runs never close (P4 learned item 5), so a box
// runner's outcome is never read: it is always null, whatever a row says.
import type { Database } from "@proof/db"
import { desc, eq, sql } from "drizzle-orm"

import { type Runner, RUNNERS, type RunOutcome, proposals, runs } from "../db/schema"
import { type Allowance, readAllowance } from "./spend"

export interface FactoryStatusRow {
  pendingProposals: number
  runners: { runner: Runner; lastStartedAt: Date | null; lastOutcome: RunOutcome | null }[]
  allowance: Allowance
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
  }
}
