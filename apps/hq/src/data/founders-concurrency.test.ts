import { createDb, user } from "@proof/db"
import { inArray } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { founders } from "../db/schema"
import { publishFounders } from "../boot"
import { type FounderSeed, syncFounders, verifyFounders } from "./founders"

// The founder sync runs at every boot, and on Vercel several instances boot at once. Its advisory
// lock (data/founders.ts) is what keeps them from colliding, and PGlite has one connection and
// cannot show two transactions interleaving: on it deleting the lock passes every test. So this
// needs real Postgres and real, separate connections: a worktree's database (`pnpm wt new` makes
// `proof_wt_<name>`, migrated with hq's tables) or HQ_TEST_DATABASE_URL, and only one named `*_wt_*`
// or `*_test`. It sets `hq.founders` to its own lists, so it puts the table back as it found it,
// and it writes three accounts of its own (ids `n31-sync-*`), deleted at the end. Anywhere else
// it is skipped, and the skip says so.
const dbName = (url: string | undefined) => (url ? new URL(url).pathname.slice(1) : "")
const explicitUrl = process.env.HQ_TEST_DATABASE_URL
const ambientUrl = process.env.DATABASE_URL
const realUrl = /(_wt_|_test$)/.test(dbName(explicitUrl))
  ? explicitUrl
  : /_wt_/.test(dbName(ambientUrl))
    ? ambientUrl
    : undefined
const REAL = realUrl !== undefined

const byText = (a: string, b: string) => a.localeCompare(b)
const IDS = ["n31-sync-a", "n31-sync-b", "n31-sync-c"] as const
const at = new Date("2026-11-17T12:00:00Z")
const pinned = (userId: string, slackUserId: string): FounderSeed => ({
  who: { userId },
  slackUserId,
})

describe.skipIf(!REAL)(
  `the founder sync under real concurrency (real Postgres: ${dbName(realUrl)})`,
  () => {
    // Separate clients, each with its own pool: no shared connection or transaction.
    const clients = REAL && realUrl ? Array.from({ length: 4 }, () => createDb(realUrl)) : []
    const [admin] = clients as [ReturnType<typeof createDb>]
    let saved: (typeof founders.$inferSelect)[] = []
    const table = async () =>
      (
        await admin
          .select()
          .from(founders)
          .where(inArray(founders.userId, [...IDS]))
      )
        .map((f) => `${f.userId}=${f.slackUserId}`)
        .sort(byText)
    const render = (list: readonly FounderSeed[]) =>
      list.map((s) => `${"userId" in s.who ? s.who.userId : ""}=${s.slackUserId}`).sort(byText)
    const sync = (i: number, list: readonly FounderSeed[]) =>
      syncFounders(clients[i % clients.length] as typeof admin, list, at, { pinnedOnly: true })

    beforeAll(async () => {
      saved = await admin.select().from(founders)
      await admin.delete(user).where(inArray(user.id, [...IDS]))
      await admin.insert(user).values(
        IDS.map((id) => ({
          id,
          name: id,
          email: `${id}@example.invalid`,
          emailVerified: true,
        })),
      )
    })
    afterAll(async () => {
      await admin.delete(founders)
      if (saved.length > 0) await admin.insert(founders).values(saved)
      await admin.delete(user).where(inArray(user.id, [...IDS]))
      await Promise.all(clients.map((c) => c.$client.end()))
    })

    it("eight syncs of one list from an empty table: all succeed, the table is the list", async () => {
      const list = IDS.map((id, i) => pinned(id, `UN31${i}`))
      // Several rounds, because one lucky interleaving proves nothing. Without the lock the second
      // insert of the same founder fails on the primary key and its boot is refused.
      for (let round = 0; round < 15; round++) {
        await admin.delete(founders)
        const results = await Promise.all(Array.from({ length: 8 }, (_, i) => sync(i, list)))
        expect(
          await admin
            .select()
            .from(founders)
            .then((rows) => rows.length),
        ).toBe(IDS.length)
        expect(await table()).toEqual(render(list))
        // Exactly one sync did the adding; the rest read the committed table and changed nothing.
        expect(results.filter((r) => r.added.length > 0)).toHaveLength(1)
      }
    })

    it("two different lists at once: one wins whole, never a mix, nobody fails", async () => {
      const one = [pinned(IDS[0], "UN31A"), pinned(IDS[1], "UN31B")]
      const two = [pinned(IDS[0], "UN31B"), pinned(IDS[2], "UN31A")]
      for (let round = 0; round < 15; round++) {
        await admin.delete(founders)
        await Promise.all([0, 1, 2, 3].map((i) => sync(i, i % 2 === 0 ? one : two)))
        expect([render(one), render(two)]).toContainEqual(await table())
      }
    })

    it("a sync that keeps a founder never makes the row disappear for a reader", async () => {
      const list = [pinned(IDS[0], "UN31X"), pinned(IDS[1], "UN31Y")]
      await admin.delete(founders)
      await sync(0, list)
      let stop = false
      let missing = 0
      const watch = (async () => {
        const reader = clients[3] as typeof admin
        while (!stop) {
          const rows = await reader
            .select()
            .from(founders)
            .where(inArray(founders.userId, [...IDS]))
          if (rows.length !== list.length) missing++
        }
      })()
      // The same list again, and again with a Slack user changed and changed back: a founder moves
      // inside one transaction, so a reader never sees the table short.
      const moved = [pinned(IDS[0], "UN31Z"), pinned(IDS[1], "UN31Y")]
      for (let i = 0; i < 20; i++) {
        await Promise.all([
          sync(0, i % 2 === 0 ? moved : list),
          sync(1, i % 2 === 0 ? moved : list),
        ])
      }
      stop = true
      await watch
      expect(missing).toBe(0)
    })

    it("six predeploys at once (publishFounders, deployed): all succeed, the table is the list", async () => {
      const list = IDS.map((id, i) => pinned(id, `UN31P${i}`))
      for (let round = 0; round < 10; round++) {
        await admin.delete(founders)
        const config = { nodeEnv: "production", allowSignUp: false, founders: list }
        await Promise.all(
          Array.from({ length: 6 }, (_, i) =>
            publishFounders(config, clients[i % clients.length] as typeof admin, at),
          ),
        )
        expect(await table()).toEqual(render(list))
      }
    })

    it("a boot's check during a deploy's writes sees the old table or the new one, never a torn one", async () => {
      const one = [pinned(IDS[0], "UN31V0"), pinned(IDS[1], "UN31V1")]
      const two = [pinned(IDS[0], "UN31V0")]
      await admin.delete(founders)
      await sync(0, one)
      let stop = false
      const seen: string[] = []
      const watch = (async () => {
        const reader = clients[3] as typeof admin
        while (!stop) {
          const v = await verifyFounders(reader, one, { pinnedOnly: true })
          seen.push(`${v.missing}/${v.extra}`)
        }
      })()
      for (let i = 0; i < 25; i++) await sync(i % 2, i % 2 === 0 ? two : one)
      stop = true
      await watch
      // Against `one`: the table is `one` (0 missing) or `two` (bob missing, 1). An empty or
      // half-written table would show 2 missing, or an extra row.
      expect(seen.length).toBeGreaterThan(0)
      expect([...new Set(seen)].sort(byText).filter((x) => x !== "0/0" && x !== "1/0")).toEqual([])
    })
  },
)
