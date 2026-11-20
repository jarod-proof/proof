import { createDb } from "@proof/db"
import { AppError } from "@proof/errors"
import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { spendGrantRequests, spendGrants } from "../db/schema"
import { createHqTestDb } from "../testing"
import {
  decideGrantRequest,
  MAX_GRANT_REQUEST_USD,
  MAX_GRANT_REQUESTS_PER_DAY,
  requestSpendGrant,
} from "./grant-requests"
import { toUnits } from "./money"

const usd = (n: number) => toUnits(n)

describe("the $25 limit on a grant request, below the operation's own check (in-process Postgres)", () => {
  let test: Awaited<ReturnType<typeof createHqTestDb>>
  const now = new Date("2030-05-05T12:00:00Z")
  beforeAll(async () => {
    test = await createHqTestDb()
  })
  afterAll(() => test.close())

  it("requestSpendGrant itself refuses more than $25, with no zod in front of it", async () => {
    for (const amount of [usd(25.01), usd(26), usd(1000)]) {
      const error = await requestSpendGrant(test.db, {
        amount,
        reason: "too much",
        requestedBy: "k",
        now,
      }).catch((e: unknown) => e)
      expect(error, String(amount)).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe("BAD_REQUEST")
    }
    expect(await test.db.select().from(spendGrantRequests)).toEqual([])
    const ok = await requestSpendGrant(test.db, {
      amount: usd(MAX_GRANT_REQUEST_USD),
      reason: "the most",
      requestedBy: "k",
      now,
    })
    expect(ok.amount).toBe(usd(25))
  })

  it("and the table refuses a row over $25 whoever writes it", async () => {
    const row = {
      reason: "r",
      status: "pending" as const,
      requestedBy: "k",
      createdAt: now,
    }
    await test.db
      .insert(spendGrantRequests)
      .values({ ...row, id: "at-the-limit", amountUsd: "25.0000" })
    const error = await test.db
      .insert(spendGrantRequests)
      .values({ ...row, id: "over-the-limit", amountUsd: "25.0001" })
      .then(
        () => null,
        (e: unknown) => e,
      )
    expect(String((error as { cause?: unknown })?.cause ?? error)).toMatch(
      /spend_grant_requests_amount_max/,
    )
    expect(
      await test.db
        .select()
        .from(spendGrantRequests)
        .where(eq(spendGrantRequests.id, "over-the-limit")),
    ).toEqual([])
  })

  it("the day's count of requests has an upper bound: rows dated after the day are not its own", async () => {
    const day = new Date("2031-03-03T12:00:00Z")
    // Ten requests dated a day LATER than `day`: they must not use up `day`'s ten.
    const later = new Date("2031-03-04T12:00:00Z")
    for (let i = 0; i < MAX_GRANT_REQUESTS_PER_DAY; i++) {
      await requestSpendGrant(test.db, {
        amount: usd(1),
        reason: "later",
        requestedBy: "k",
        now: later,
      })
    }
    for (let i = 0; i < MAX_GRANT_REQUESTS_PER_DAY; i++) {
      await requestSpendGrant(test.db, {
        amount: usd(1),
        reason: "own",
        requestedBy: "k",
        now: day,
      })
    }
    const eleventh = await requestSpendGrant(test.db, {
      amount: usd(1),
      reason: "one too many",
      requestedBy: "k",
      now: day,
    }).catch((e: unknown) => e)
    expect((eleventh as AppError).code).toBe("RATE_LIMITED")
  })
})

// The locks need real Postgres and real, separate connections: PGlite has one connection and cannot
// show two transactions interleaving, so on it deleting either advisory lock passes every test.
// These run against a worktree's database (`pnpm wt new` makes `proof_wt_<name>`, migrated with hq's
// tables; `pnpm wt reset-db` after pulling in a migration) or HQ_TEST_DATABASE_URL, and only a
// database named `*_wt_*` or `*_test`: they write (then delete) rows dated in the year 2300, which
// is this file's own: spend.test.ts's real block owns 2200 and runs in parallel on the same
// database, so neither may write or delete in the other's year. Anywhere else they are skipped,
// and the skip says so.
const YEAR: number = 2300
const SPEND_TEST_YEAR: number = 2200
const dbName = (url: string | undefined) => (url ? new URL(url).pathname.slice(1) : "")
const explicitUrl = process.env.HQ_TEST_DATABASE_URL
const ambientUrl = process.env.DATABASE_URL
const realUrl = /(_wt_|_test$)/.test(dbName(explicitUrl))
  ? explicitUrl
  : /_wt_/.test(dbName(ambientUrl))
    ? ambientUrl
    : undefined
const REAL = realUrl !== undefined

describe.skipIf(!REAL)(
  `grant requests under real concurrency (real Postgres: ${dbName(realUrl)})`,
  () => {
    // Two clients, each with its own pool of connections: no shared connection or transaction.
    const clients = REAL && realUrl ? [createDb(realUrl), createDb(realUrl)] : []
    const [a, b] = clients as [ReturnType<typeof createDb>, ReturnType<typeof createDb>]
    const either = (i: number) => (i % 2 === 0 ? a : b)
    const dayStart = new Date(Date.UTC(YEAR, 0, 1))
    const from = `${YEAR}-01-01`
    const to = `${YEAR + 1}-01-01`
    const cleanup = async () => {
      // Never the range spend.test.ts's own real block writes and deletes: vitest may run the two
      // files at the same moment, on the same database.
      if (YEAR === SPEND_TEST_YEAR) throw new Error(`the year ${YEAR} belongs to spend.test.ts`)
      await a?.$client.unsafe(
        `delete from hq.spend_grant_requests where created_at >= '${from}' and created_at < '${to}'`,
      )
      // Only the grants a redeem wrote (their reason says so), and only in this year.
      await a?.$client.unsafe(
        `delete from hq.spend_grants where day >= '${from}' and day < '${to}' and reason like 'Slack approval %'`,
      )
    }
    beforeAll(cleanup)
    afterAll(async () => {
      await cleanup()
      await Promise.all(clients.map((c) => c.$client.end()))
    })

    /** Noon UTC of day `round` of this block's year. */
    const at = (round: number) => new Date(dayStart.getTime() + round * 86_400_000 + 12 * 3_600_000)
    const ask = (client: typeof a, round: number, amount: number) =>
      requestSpendGrant(client, {
        amount: usd(amount),
        reason: "race",
        requestedBy: "t",
        now: at(round),
      })
    const redeem = (client: typeof a, round: number, id: string, cap: number) =>
      decideGrantRequest(client, {
        id,
        approve: true,
        decidedBy: "founder",
        now: at(round),
        dailyCap: usd(cap),
      })

    it("four $25 requests redeemed at once with a $50 cap: exactly two granted, two capped and still pending", async () => {
      // Several rounds, because one lucky interleaving proves nothing. Each round is its own day.
      for (let round = 0; round < 10; round++) {
        const ids: string[] = []
        for (let i = 0; i < 4; i++) ids.push((await ask(either(i), round, 25)).id)
        const results = await Promise.all(ids.map((id, i) => redeem(either(i), round, id, 50)))
        const outcomes = results.map((r) => r.outcome).sort()
        expect(outcomes, `round ${round}`).toEqual(["capped", "capped", "granted", "granted"])
        const rows = await a
          .select()
          .from(spendGrantRequests)
          .where(and(eq(spendGrantRequests.requestedBy, "t")))
        const mine = rows.filter((r) => ids.includes(r.id))
        expect(mine.filter((r) => r.status === "granted")).toHaveLength(2)
        const pending = mine.filter((r) => r.status === "pending")
        expect(pending, `round ${round}`).toHaveLength(2)
        expect(pending.every((r) => r.decidedBy === null && r.decidedAt === null)).toBe(true)
        const grants = (await a.select().from(spendGrants)).filter(
          (g) => g.day === at(round).toISOString().slice(0, 10),
        )
        expect(
          grants.reduce((sum, g) => sum + Number(g.amountUsd), 0),
          `round ${round}`,
        ).toBe(50)
      }
    })

    it("one request redeemed by eight callers at once: exactly one spend_grants row", async () => {
      for (let round = 20; round < 26; round++) {
        const { id } = await ask(a, round, 25)
        const results = await Promise.all(
          Array.from({ length: 8 }, (_, i) => redeem(either(i), round, id, 1000)),
        )
        expect(
          results.filter((r) => r.outcome === "granted"),
          `round ${round}`,
        ).toHaveLength(1)
        expect(
          results.filter((r) => r.outcome === "unavailable" && r.why === "decided"),
          `round ${round}`,
        ).toHaveLength(7)
        const grants = (await a.select().from(spendGrants)).filter((g) =>
          g.reason.startsWith(`Slack approval ${id}`),
        )
        expect(grants, `round ${round}`).toHaveLength(1)
      }
    })

    it("twelve requests at once on one day: exactly ten recorded and two RATE_LIMITED", async () => {
      for (let round = 30; round < 36; round++) {
        const results = await Promise.allSettled(
          Array.from({ length: 12 }, (_, i) => ask(either(i), round, 1)),
        )
        const ok = results.filter((r) => r.status === "fulfilled")
        const refused = results.filter(
          (r) => r.status === "rejected" && (r.reason as AppError).code === "RATE_LIMITED",
        )
        expect(ok, `round ${round}`).toHaveLength(MAX_GRANT_REQUESTS_PER_DAY)
        expect(refused, `round ${round}`).toHaveLength(2)
        const day = at(round).toISOString().slice(0, 10)
        const rows = (await a.select().from(spendGrantRequests)).filter(
          (r) => r.createdAt.toISOString().slice(0, 10) === day,
        )
        expect(rows, `round ${round}`).toHaveLength(MAX_GRANT_REQUESTS_PER_DAY)
      }
    })
  },
)
