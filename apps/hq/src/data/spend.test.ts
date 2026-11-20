import { createDb } from "@proof/db"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { spend, spendGrants, spendHolds } from "../db/schema"
import { createHqTestDb } from "../testing"
import { toUnits } from "./money"
import {
  dayOf,
  grantSpend,
  readAllowance,
  recordSpend,
  reserveSpend,
  settleSpend,
  spendSummary,
} from "./spend"

const usd = (n: number) => toUnits(n)
const minutes = (from: Date, m: number) => new Date(from.getTime() + m * 60_000)

describe("the spend ledger and the daily cap (in-process Postgres)", () => {
  let test: Awaited<ReturnType<typeof createHqTestDb>>
  beforeAll(async () => {
    test = await createHqTestDb()
  })
  afterAll(async () => {
    await test.close()
  })
  // Each test works on its own UTC day, so no test sees another's rows.
  let n = 0
  const freshDay = () => new Date(Date.UTC(2100, 0, ++n, 12))

  it("remaining is 10 minus today's eve spend plus today's grants", async () => {
    const now = freshDay()
    await recordSpend(test.db, { source: "eve", amount: usd(3.25), model: "m", now })
    await recordSpend(test.db, { source: "eve", amount: usd(0.0001), model: "m", now })
    await grantSpend(test.db, { amount: usd(2), reason: "launch", grantedBy: "u1", now })
    const a = await readAllowance(test.db, now)
    expect(a.spent).toBe(usd(3.2501))
    expect(a.granted).toBe(usd(2))
    expect(a.remaining).toBe(usd(10 - 3.2501 + 2))
    expect(a.remaining).toBe(87_499)
  })

  it("a grant raises today's remaining, and only today's", async () => {
    const now = freshDay()
    const before = await readAllowance(test.db, now)
    await grantSpend(test.db, { amount: usd(5), reason: "r", grantedBy: "u1", now })
    expect((await readAllowance(test.db, now)).remaining).toBe(before.remaining + usd(5))
    expect((await readAllowance(test.db, minutes(now, 24 * 60))).remaining).toBe(usd(10))
  })

  it("build and box spend don't count toward the eve cap", async () => {
    const now = freshDay()
    await recordSpend(test.db, { source: "build", amount: usd(4), model: "m", now })
    await recordSpend(test.db, { source: "box", amount: usd(5), model: "m", now })
    expect((await readAllowance(test.db, now)).remaining).toBe(usd(10))
    // Not even a 9.99 reservation notices them.
    expect(await reserveSpend(test.db, { estimate: usd(9.99), now })).toHaveProperty("holdId")
    // But they are recorded.
    const rows = await spendSummary(test.db, { days: 1, now })
    expect(
      rows
        .map((r) => [r.source, r.amount])
        .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    ).toEqual([
      ["box", usd(5)],
      ["build", usd(4)],
    ])
  })

  it("a record with no amount stores the estimate and marks it estimated", async () => {
    const now = freshDay()
    const missing = await recordSpend(test.db, {
      source: "eve",
      estimate: usd(0.3),
      model: "m",
      now,
    })
    expect(missing).toMatchObject({ amount: usd(0.3), estimated: true })
    const reported = await recordSpend(test.db, {
      source: "eve",
      amount: usd(0.2),
      estimate: usd(0.3),
      model: "m",
      now,
    })
    expect(reported).toMatchObject({ amount: usd(0.2), estimated: false })
    const [stored] = await test.db.select().from(spend).where(eq(spend.id, missing.id))
    expect(stored).toMatchObject({ amountUsd: "0.3000", estimated: true })
    // An estimate counts toward the cap like any spend.
    expect((await readAllowance(test.db, now)).spent).toBe(usd(0.5))
    await expect(recordSpend(test.db, { source: "eve", model: "m", now })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
  })

  it("spend on the previous UTC day doesn't count", async () => {
    const midnight = new Date(Date.UTC(2101, 5, 1, 0, 0, 0))
    const lastMoment = new Date(midnight.getTime() - 1) // 23:59:59.999 the day before
    await recordSpend(test.db, { source: "eve", amount: usd(9), model: "m", now: lastMoment })
    expect(dayOf(lastMoment)).toBe("2101-05-31")
    expect((await readAllowance(test.db, lastMoment)).remaining).toBe(usd(1))
    expect((await readAllowance(test.db, midnight)).remaining).toBe(usd(10))
    await recordSpend(test.db, { source: "eve", amount: usd(2), model: "m", now: midnight })
    expect((await readAllowance(test.db, midnight)).spent).toBe(usd(2))
    expect(dayOf(new Date("2026-11-17T23:30:00-05:00"))).toBe("2026-11-18") // UTC, not local
  })

  it("refuses at exactly 10.00 spent, and allows an estimate of exactly the remaining", async () => {
    const now = freshDay()
    await recordSpend(test.db, { source: "eve", amount: usd(9.8), model: "m", now })
    expect(await reserveSpend(test.db, { estimate: usd(0.2), now })).toHaveProperty("holdId")
    expect(await reserveSpend(test.db, { estimate: usd(0.0001), now })).toEqual({
      refused: true,
      remaining: 0,
    })
    const closed = freshDay()
    await recordSpend(test.db, { source: "eve", amount: usd(10), model: "m", now: closed })
    expect(await reserveSpend(test.db, { estimate: usd(0.0001), now: closed })).toEqual({
      refused: true,
      remaining: 0,
    })
  })

  it("at 9.90 spent two 0.20 estimates are both refused; remaining is 0.10", async () => {
    const now = freshDay()
    await recordSpend(test.db, { source: "eve", amount: usd(9.9), model: "m", now })
    const results = [
      await reserveSpend(test.db, { estimate: usd(0.2), now }),
      await reserveSpend(test.db, { estimate: usd(0.2), now }),
    ]
    expect(results).toEqual([
      { refused: true, remaining: usd(0.1) },
      { refused: true, remaining: usd(0.1) },
    ])
  })

  it("an unsettled hold older than 15 minutes counts at its estimate", async () => {
    const now = freshDay()
    await recordSpend(test.db, { source: "eve", amount: usd(9.5), model: "m", now })
    const hold = await reserveSpend(test.db, { estimate: usd(0.3), now })
    if (!("holdId" in hold)) throw new Error("expected a hold")

    // Fresh: reserved, not spent. Remaining is the same either way.
    const early = await readAllowance(test.db, minutes(now, 14))
    expect(early).toMatchObject({ spent: usd(9.5), reserved: usd(0.3), remaining: usd(0.2) })
    // Stale: it is spent at its estimate, and it is NOT released.
    const late = await readAllowance(test.db, minutes(now, 16))
    expect(late).toMatchObject({ spent: usd(9.8), reserved: 0, remaining: usd(0.2) })
    // A reservation that would fit only if the hold had been released is refused.
    expect(await reserveSpend(test.db, { estimate: usd(0.25), now: minutes(now, 16) })).toEqual({
      refused: true,
      remaining: usd(0.2),
    })
    // Settling it late replaces the estimate with the real cost; nothing counts twice.
    await settleSpend(test.db, {
      holdId: hold.holdId,
      amount: usd(0.1),
      model: "m",
      now: minutes(now, 30),
    })
    expect(await readAllowance(test.db, minutes(now, 30))).toMatchObject({
      spent: usd(9.6),
      reserved: 0,
    })
  })

  it("settles at the estimate, marked estimated, when no cost was reported", async () => {
    const now = freshDay()
    const hold = await reserveSpend(test.db, { estimate: usd(0.4), runId: "run-1", now })
    if (!("holdId" in hold)) throw new Error("expected a hold")
    const row = await settleSpend(test.db, { holdId: hold.holdId, model: "haiku", now })
    expect(row).toMatchObject({ amount: usd(0.4), estimated: true, runId: "run-1", source: "eve" })
    expect(await readAllowance(test.db, now)).toMatchObject({ spent: usd(0.4), reserved: 0 })
    const real = await reserveSpend(test.db, { estimate: usd(0.4), now })
    if (!("holdId" in real)) throw new Error("expected a hold")
    expect(
      await settleSpend(test.db, { holdId: real.holdId, amount: usd(0.07), model: "m", now }),
    ).toMatchObject({ amount: usd(0.07), estimated: false })
  })

  it("settling twice is a CONFLICT and records nothing more; an unknown hold is NOT_FOUND", async () => {
    const now = freshDay()
    const hold = await reserveSpend(test.db, { estimate: usd(1), now })
    if (!("holdId" in hold)) throw new Error("expected a hold")
    await settleSpend(test.db, { holdId: hold.holdId, amount: usd(0.5), model: "m", now })
    await expect(
      settleSpend(test.db, { holdId: hold.holdId, amount: usd(0.5), model: "m", now }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect((await readAllowance(test.db, now)).spent).toBe(usd(0.5))
    await expect(settleSpend(test.db, { holdId: "nope", model: "m", now })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("a settle that went past its estimate can take the day below zero; the day then refuses", async () => {
    const now = freshDay()
    await recordSpend(test.db, { source: "eve", amount: usd(9.9), model: "m", now })
    const hold = await reserveSpend(test.db, { estimate: usd(0.05), now })
    if (!("holdId" in hold)) throw new Error("expected a hold")
    await settleSpend(test.db, { holdId: hold.holdId, amount: usd(0.4), model: "m", now })
    const a = await readAllowance(test.db, now)
    expect(a.remaining).toBe(-usd(0.3))
    expect(await reserveSpend(test.db, { estimate: usd(0.0001), now })).toEqual({
      refused: true,
      remaining: 0,
    })
  })

  it("a hold settles into the day it was reserved against", async () => {
    const reserved = new Date(Date.UTC(2102, 0, 1, 23, 59))
    const hold = await reserveSpend(test.db, { estimate: usd(1), now: reserved })
    if (!("holdId" in hold)) throw new Error("expected a hold")
    const row = await settleSpend(test.db, {
      holdId: hold.holdId,
      amount: usd(1),
      model: "m",
      now: minutes(reserved, 5),
    })
    expect(row.day).toBe("2102-01-01")
    expect((await readAllowance(test.db, minutes(reserved, 5))).spent).toBe(0)
  })

  it("the database refuses a negative amount and a hold of nothing", async () => {
    const now = freshDay()
    await expect(
      test.db.insert(spend).values({
        id: "neg",
        day: dayOf(now),
        source: "eve",
        amountUsd: "-1.0000",
        model: "m",
        estimated: false,
        createdAt: now,
      }),
    ).rejects.toThrow()
    await expect(
      test.db
        .insert(spendHolds)
        .values({ id: "zero", day: dayOf(now), estimateUsd: "0.0000", createdAt: now }),
    ).rejects.toThrow()
    await expect(
      test.db.insert(spendGrants).values({
        id: "g",
        day: dayOf(now),
        amountUsd: "0.0000",
        grantedBy: "u",
        reason: "r",
        createdAt: now,
      }),
    ).rejects.toThrow()
  })
})

// The race itself needs real Postgres and real, separate connections: PGlite has one connection
// and cannot show two transactions interleaving. These run against a worktree's database
// (`pnpm wt new` makes `proof_wt_<name>`, migrated with hq's tables) or HQ_TEST_DATABASE_URL, and only
// a database named `*_wt_*` or `*_test`: they write (then delete) rows on days in the year 2200.
// Anywhere else they are skipped, and the skip says so.
const dbName = (url: string | undefined) => (url ? new URL(url).pathname.slice(1) : "")
const explicitUrl = process.env.HQ_TEST_DATABASE_URL
const ambientUrl = process.env.DATABASE_URL
// HQ_TEST_DATABASE_URL may name a worktree's or a `*_test` database; the ambient DATABASE_URL only
// counts when it is a worktree's (`*_wt_*`), so a dev or CI `lab` database is never written to.
const realUrl = /(_wt_|_test$)/.test(dbName(explicitUrl))
  ? explicitUrl
  : /_wt_/.test(dbName(ambientUrl))
    ? ambientUrl
    : undefined
const REAL = realUrl !== undefined

describe.skipIf(!REAL)(
  `the daily cap under real concurrency (real Postgres: ${dbName(realUrl)})`,
  () => {
    // Two clients, each with its own pool of connections: no shared connection or transaction.
    const clients = REAL && realUrl ? [createDb(realUrl), createDb(realUrl)] : []
    const [a, b] = clients
    const dayStart = new Date(Date.UTC(2200, 0, 1))
    const cleanup = async () => {
      for (const table of ["spend", "spend_grants", "spend_holds"]) {
        await a?.$client.unsafe(
          `delete from hq.${table} where day >= '2200-01-01' and day < '2201-01-01'`,
        )
      }
    }
    beforeAll(cleanup)
    afterAll(async () => {
      await cleanup()
      await Promise.all(clients.map((c) => c.$client.end()))
    })

    const at = (round: number) =>
      new Date(dayStart.getTime() + round * 24 * 60 * 60_000 + 12 * 3_600_000)
    /** `callers` reservations at once, spread over both clients. */
    const race = (round: number, estimate: number, callers: number) =>
      Promise.all(
        Array.from({ length: callers }, (_, i) =>
          reserveSpend((i % 2 === 0 ? a : b) as NonNullable<typeof a>, {
            estimate: usd(estimate),
            now: at(round),
          }),
        ),
      )
    const holds = (results: Awaited<ReturnType<typeof race>>) =>
      results.filter((r) => "holdId" in r).length

    it("two concurrent reserve_spend calls at 9.90 spent with 0.20 estimates: exactly one gets a hold", async () => {
      // Review Focus 3's day: 9.90 spent, so 0.10 left. Estimates of 0.20 would both be refused (the
      // test above), so the race uses 0.06: one fits (0.04 left), a second cannot. Several rounds
      // and several callers per round, because one lucky interleaving proves nothing.
      for (let round = 0; round < 6; round++) {
        await recordSpend(a as NonNullable<typeof a>, {
          source: "eve",
          amount: usd(9.9),
          model: "m",
          now: at(round),
        })
        const results = await race(round, 0.06, 8)
        expect(holds(results), `round ${round}`).toBe(1)
        const allowance = await readAllowance(a as NonNullable<typeof a>, at(round))
        expect(allowance.reserved).toBe(usd(0.06))
        expect(allowance.remaining).toBe(usd(0.04))
      }
    })

    it("with a 0.10 grant on top of 9.90 spent, two 0.15 estimates at once: exactly one gets a hold", async () => {
      for (let round = 10; round < 16; round++) {
        await recordSpend(a as NonNullable<typeof a>, {
          source: "eve",
          amount: usd(9.9),
          model: "m",
          now: at(round),
        })
        await grantSpend(a as NonNullable<typeof a>, {
          amount: usd(0.1),
          reason: "race",
          grantedBy: "u",
          now: at(round),
        })
        // Remaining is 10 + 0.10 - 9.90 = 0.20: one 0.15 fits, a second does not. (Two 0.10 would
        // both fit.)
        expect(holds(await race(round, 0.15, 2)), `round ${round}`).toBe(1)
      }
    })

    it("a settle racing reserves never lets the day go past its cap", async () => {
      const round = 20
      const first = await reserveSpend(a as NonNullable<typeof a>, {
        estimate: usd(9.5),
        now: at(round),
      })
      if (!("holdId" in first)) throw new Error("expected a hold")
      // While the 9.5 hold settles at 9.5, many reserve 0.3: only one 0.3 fits in the last 0.5.
      const [, ...results] = await Promise.all([
        settleSpend(b as NonNullable<typeof b>, {
          holdId: first.holdId,
          amount: usd(9.5),
          model: "m",
          now: at(round),
        }),
        ...Array.from({ length: 6 }, (_, i) =>
          reserveSpend((i % 2 === 0 ? a : b) as NonNullable<typeof a>, {
            estimate: usd(0.3),
            now: at(round),
          }),
        ),
      ])
      expect(holds(results)).toBe(1)
      const allowance = await readAllowance(a as NonNullable<typeof a>, at(round))
      expect(allowance.spent + allowance.reserved).toBe(usd(9.8))
    })
  },
)
