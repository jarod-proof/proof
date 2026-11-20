// The spend ledger and the daily cap. Every query on spend lives here. Money is integer units of
// $0.0001 (money.ts); the database sums numeric exactly and hands text back.
//
// The cap: $10.00 per UTC day on Eve chat and schedules (source `eve`). Builds and box runs are
// recorded but are outside it. A turn first RESERVES its estimate (a hold); hq refuses when the
// day's remaining is less than the estimate. Reserving is one transaction under a per-day advisory
// lock, so two turns that arrive together cannot both fit into the last of the day.
import type { Database } from "@proof/db"
import { AppError } from "@proof/errors"
import { and, desc, eq, gte, isNull, type SQLWrapper, sql } from "drizzle-orm"

import { runs, type SpendSource, spend, spendGrants, spendHolds } from "../db/schema"
import { columnText, DAILY_CAP, parseUnits, type Units } from "./money"

/** An unsettled hold older than this is treated as spent at its estimate. */
export const STALE_HOLD_MS = 15 * 60 * 1000

/** The UTC day of an instant, `YYYY-MM-DD`: the cap's day, whatever the server's time zone. */
export const dayOf = (at: Date): string => at.toISOString().slice(0, 10)

export interface Allowance {
  day: string
  /** Settled Eve spend, plus holds nobody settled in 15 minutes at their estimates. */
  spent: Units
  /** Fresh holds (turns in flight) at their estimates. */
  reserved: Units
  granted: Units
  /** cap + granted - spent - reserved; negative when a settled cost went past its estimate. */
  remaining: Units
}

const total = (column: SQLWrapper) => sql<string>`coalesce(sum(${column}), 0)::text`

/** The day's cap position for source `eve`. Call inside the reserve transaction to act on it. */
export async function readAllowance(db: Database, now: Date): Promise<Allowance> {
  const day = dayOf(now)
  const staleBefore = new Date(now.getTime() - STALE_HOLD_MS)
  const [settled] = await db
    .select({ amount: total(spend.amountUsd) })
    .from(spend)
    .where(and(eq(spend.day, day), eq(spend.source, "eve")))
  const [grants] = await db
    .select({ amount: total(spendGrants.amountUsd) })
    .from(spendGrants)
    .where(eq(spendGrants.day, day))
  const [stale] = await db
    .select({ amount: total(spendHolds.estimateUsd) })
    .from(spendHolds)
    .where(
      and(
        eq(spendHolds.day, day),
        isNull(spendHolds.settledAt),
        sql`${spendHolds.createdAt} <= ${staleBefore.toISOString()}::timestamptz`,
      ),
    )
  const [fresh] = await db
    .select({ amount: total(spendHolds.estimateUsd) })
    .from(spendHolds)
    .where(
      and(
        eq(spendHolds.day, day),
        isNull(spendHolds.settledAt),
        sql`${spendHolds.createdAt} > ${staleBefore.toISOString()}::timestamptz`,
      ),
    )
  const spent = parseUnits(settled?.amount ?? "0") + parseUnits(stale?.amount ?? "0")
  const reserved = parseUnits(fresh?.amount ?? "0")
  const granted = parseUnits(grants?.amount ?? "0")
  return { day, spent, reserved, granted, remaining: DAILY_CAP + granted - spent - reserved }
}

/** Serialises everything that decides against a day's cap. Held until the transaction ends. */
async function lockDay(db: Database, day: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`hq_spend:${day}`}, 0))`)
}

export type Reservation = { holdId: string } | { refused: true; remaining: Units }

/**
 * Reserve a turn's estimate against today's Eve cap. In one transaction, under the day's advisory
 * lock: remaining = 10 + grants - settled spend - open holds; a hold is inserted only if remaining
 * covers the estimate. A day at or past its cap refuses everything.
 */
export function reserveSpend(
  db: Database,
  input: { estimate: Units; runId?: string; now: Date },
): Promise<Reservation> {
  return db.transaction(async (tx) => {
    await lockDay(tx, dayOf(input.now))
    const allowance = await readAllowance(tx, input.now)
    if (allowance.remaining <= 0 || allowance.remaining < input.estimate) {
      return { refused: true as const, remaining: Math.max(0, allowance.remaining) }
    }
    const holdId = crypto.randomUUID()
    await tx.insert(spendHolds).values({
      id: holdId,
      day: allowance.day,
      estimateUsd: columnText(input.estimate),
      runId: input.runId ?? null,
      createdAt: input.now,
    })
    return { holdId }
  })
}

export interface SpendRow {
  id: string
  runId: string | null
  day: string
  source: SpendSource
  amount: Units
  model: string
  estimated: boolean
}

/**
 * Close a hold and write its spend row, dated the hold's own day (the day it was reserved
 * against). No amount means the provider reported none: the hold's estimate stands, marked
 * estimated. A hold is settled once; a second settle is a CONFLICT (hooks aren't exactly-once).
 */
export function settleSpend(
  db: Database,
  input: { holdId: string; amount?: Units; model: string; now: Date },
): Promise<SpendRow> {
  return db.transaction(async (tx) => {
    const [peek] = await tx.select().from(spendHolds).where(eq(spendHolds.id, input.holdId))
    if (!peek) throw new AppError("NOT_FOUND", "Hold not found")
    // The day lock first (as reserve takes it), then the hold's row: a settle can't commit
    // between a reserve's reads and leave the hold counted in neither sum.
    await lockDay(tx, peek.day)
    const [hold] = await tx
      .select()
      .from(spendHolds)
      .where(eq(spendHolds.id, input.holdId))
      .for("update")
    if (!hold) throw new AppError("NOT_FOUND", "Hold not found")
    if (hold.settledAt) throw new AppError("CONFLICT", "The hold was already settled")
    await tx.update(spendHolds).set({ settledAt: input.now }).where(eq(spendHolds.id, hold.id))
    const estimated = input.amount === undefined
    const amount = input.amount ?? parseUnits(hold.estimateUsd)
    const row = {
      id: crypto.randomUUID(),
      runId: hold.runId,
      day: hold.day,
      source: "eve" as const,
      amountUsd: columnText(amount),
      model: input.model,
      estimated,
      createdAt: input.now,
    }
    await tx.insert(spend).values(row)
    return {
      id: row.id,
      runId: row.runId,
      day: row.day,
      source: "eve",
      amount,
      model: input.model,
      estimated,
    }
  })
}

/**
 * Record spend that had no hold: a build or a box run (outside the cap), or Eve spend from a
 * caller that didn't reserve. Missing `amount` stores `estimate` marked estimated.
 */
export async function recordSpend(
  db: Database,
  input: {
    runId?: string
    source: SpendSource
    amount?: Units
    estimate?: Units
    model: string
    now: Date
  },
): Promise<SpendRow> {
  const estimated = input.amount === undefined
  const amount = input.amount ?? input.estimate
  if (amount === undefined) {
    throw new AppError("BAD_REQUEST", "Send amountUsd, or estimatedUsd when the cost is unknown")
  }
  const row = {
    id: crypto.randomUUID(),
    runId: input.runId ?? null,
    day: dayOf(input.now),
    source: input.source,
    amountUsd: columnText(amount),
    model: input.model,
    estimated,
    createdAt: input.now,
  }
  await db.insert(spend).values(row)
  return {
    id: row.id,
    runId: row.runId,
    day: row.day,
    source: row.source,
    amount,
    model: row.model,
    estimated,
  }
}

/** A founder's extra allowance for today. */
export async function grantSpend(
  db: Database,
  input: { amount: Units; reason: string; grantedBy: string; now: Date },
): Promise<{ id: string; day: string }> {
  const row = {
    id: crypto.randomUUID(),
    day: dayOf(input.now),
    amountUsd: columnText(input.amount),
    grantedBy: input.grantedBy,
    reason: input.reason,
    createdAt: input.now,
  }
  await db.insert(spendGrants).values(row)
  return { id: row.id, day: row.day }
}

/** The UTC day before the one `now` is in. */
export const previousDay = (now: Date): string => dayOf(new Date(now.getTime() - 86_400_000))

export interface DaySpend {
  day: string
  /** Every source, estimates included. */
  total: Units
  /** The part of the total that is an estimate (no provider cost was reported). */
  estimated: Units
  bySource: { source: SpendSource; amount: Units }[]
}

/** What one UTC day spent, by source: the ledger's rows for that day, nothing held or granted. */
export async function spendOnDay(db: Database, day: string): Promise<DaySpend> {
  const rows = await db
    .select({
      source: spend.source,
      amount: total(spend.amountUsd),
      estimated: sql<string>`coalesce(sum(${spend.amountUsd}) filter (where ${spend.estimated}), 0)::text`,
    })
    .from(spend)
    .where(eq(spend.day, day))
    .groupBy(spend.source)
    .orderBy(spend.source)
  const bySource = rows.map((r) => ({ source: r.source, amount: parseUnits(r.amount) }))
  return {
    day,
    total: bySource.reduce((sum, r) => sum + r.amount, 0),
    estimated: rows.reduce((sum, r) => sum + parseUnits(r.estimated), 0),
    bySource,
  }
}

export interface SpendSummaryRow {
  day: string
  source: SpendSource
  task: string | null
  amount: Units
  estimated: Units
}

/** Spend per day, source and task for the last `days` UTC days (today included), newest first. */
export async function spendSummary(
  db: Database,
  input: { days: number; now: Date },
): Promise<SpendSummaryRow[]> {
  const since = dayOf(new Date(input.now.getTime() - (input.days - 1) * 24 * 60 * 60 * 1000))
  const rows = await db
    .select({
      day: spend.day,
      source: spend.source,
      task: runs.task,
      amount: total(spend.amountUsd),
      estimated: sql<string>`coalesce(sum(${spend.amountUsd}) filter (where ${spend.estimated}), 0)::text`,
    })
    .from(spend)
    .leftJoin(runs, eq(runs.id, spend.runId))
    .where(gte(spend.day, since))
    .groupBy(spend.day, spend.source, runs.task)
    .orderBy(desc(spend.day), spend.source)
  return rows.map((r) => ({
    day: r.day,
    source: r.source,
    task: r.task,
    amount: parseUnits(r.amount),
    estimated: parseUnits(r.estimated),
  }))
}
