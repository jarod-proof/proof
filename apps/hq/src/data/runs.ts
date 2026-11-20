// The run log: what the factory ran, how it ended, and what it cost (the sum of the run's spend).
import type { Database } from "@proof/db"
import { AppError } from "@proof/errors"
import { and, desc, eq, lt, or, sql } from "drizzle-orm"

import { type Runner, type RunOutcome, type RunSummary, runs, spend } from "../db/schema"
import { parseUnits, type Units } from "./money"

export interface RunRow {
  id: string
  task: string
  trigger: string
  runner: Runner
  startedAt: Date
  endedAt: Date | null
  outcome: RunOutcome | null
  link: string | null
  summary: RunSummary | null
  /** The sum of this run's spend rows. */
  cost: Units
  /** Whether any of that cost is an estimate rather than a reported cost. */
  costEstimated: boolean
}

const columns = {
  id: runs.id,
  task: runs.task,
  trigger: runs.trigger,
  runner: runs.runner,
  startedAt: runs.startedAt,
  endedAt: runs.endedAt,
  outcome: runs.outcome,
  link: runs.link,
  summary: runs.summary,
  cost: sql<string>`coalesce(sum(${spend.amountUsd}), 0)::text`,
  costEstimated: sql<boolean>`coalesce(bool_or(${spend.estimated}), false)`,
}

function selectRuns(db: Database) {
  return db.select(columns).from(runs).leftJoin(spend, eq(spend.runId, runs.id)).groupBy(runs.id)
}

const withUnits = (r: Awaited<ReturnType<typeof selectRuns>>[number]): RunRow => ({
  id: r.id,
  task: r.task,
  trigger: r.trigger,
  runner: r.runner,
  startedAt: r.startedAt,
  endedAt: r.endedAt,
  outcome: r.outcome,
  link: r.link,
  summary: r.summary,
  cost: parseUnits(r.cost),
  costEstimated: r.costEstimated,
})

export async function recordRun(
  db: Database,
  input: { task: string; trigger: string; runner: Runner; link?: string; now: Date },
): Promise<{ id: string }> {
  const id = crypto.randomUUID()
  await db.insert(runs).values({
    id,
    task: input.task,
    trigger: input.trigger,
    runner: input.runner,
    startedAt: input.now,
    link: input.link ?? null,
  })
  return { id }
}

export async function getRun(db: Database, id: string): Promise<RunRow> {
  const [row] = await selectRuns(db).where(eq(runs.id, id))
  if (!row) throw new AppError("NOT_FOUND", "Run not found")
  return withUnits(row)
}

/** Close a run. A run ends once: finishing it again is a CONFLICT and changes nothing. */
export async function finishRun(
  db: Database,
  input: { id: string; outcome: RunOutcome; summary: RunSummary; now: Date },
): Promise<RunRow> {
  const updated = await db
    .update(runs)
    .set({ endedAt: input.now, outcome: input.outcome, summary: input.summary })
    .where(and(eq(runs.id, input.id), sql`${runs.endedAt} is null`))
    .returning({ id: runs.id })
  if (updated.length === 0) {
    await getRun(db, input.id) // NOT_FOUND when there is no such run
    throw new AppError("CONFLICT", "The run was already finished")
  }
  return getRun(db, input.id)
}

/** Newest first, one page after `after`. */
export async function listRuns(
  db: Database,
  opts: { after?: { at: Date; id: string }; limit: number },
): Promise<RunRow[]> {
  const { after } = opts
  const rows = await selectRuns(db)
    .where(
      after
        ? or(lt(runs.startedAt, after.at), and(eq(runs.startedAt, after.at), lt(runs.id, after.id)))
        : undefined,
    )
    .orderBy(desc(runs.startedAt), desc(runs.id))
    .limit(opts.limit)
  return rows.map(withUnits)
}
