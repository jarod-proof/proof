import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { createHqHarness, type TestPerson } from "./app.test.helpers"
import { FoundersOutOfDateError, prepareBoot, publishFounders } from "./boot"
import { isFounder, parseFounders } from "./data/founders"
import { founders } from "./db/schema"

// What a boot decides is `prepareBoot` (a local hq syncs the founders table, a deployed one only
// checks it) and `publishFounders` (what `pnpm hq:predeploy` writes), so these are the tests of what
// a deployed hq refuses and ignores. Deleting any of those decisions reopens the N5 squatter or
// lets an old deployment put back a founder the newest one removed.
describe("prepareBoot and publishFounders (real hq database on PGlite)", () => {
  let hq: Awaited<ReturnType<typeof createHqHarness>>
  let ann: TestPerson
  let bob: TestPerson
  const at = new Date("2026-11-17T12:00:00Z")

  beforeAll(async () => {
    hq = await createHqHarness()
    // A verified account for the address the list names: by email it would be taken as a founder.
    ann = await hq.signUp("ann@example.com")
    bob = await hq.signUp("bob@example.com")
  })
  afterAll(() => hq.close())
  afterEach(() => hq.db.delete(founders))

  const config = (nodeEnv: string | undefined, allowSignUp: boolean, list: string) => ({
    nodeEnv,
    allowSignUp,
    founders: parseFounders(list),
  })
  const boot = (nodeEnv: string | undefined, allowSignUp: boolean, list: string) =>
    prepareBoot(config(nodeEnv, allowSignUp, list), hq.db, at)
  const publish = (nodeEnv: string | undefined, allowSignUp: boolean, list: string) =>
    publishFounders(config(nodeEnv, allowSignUp, list), hq.db, at)
  const table = async () => (await hq.db.select().from(founders)).map((f) => f.userId).sort()

  for (const nodeEnv of ["production", undefined] as const) {
    describe(`a deployed hq (NODE_ENV ${nodeEnv === undefined ? "unset" : nodeEnv})`, () => {
      it("refuses to start with public sign-up on, and touches no founder", async () => {
        const list = `id:${ann.userId}=UANN`
        await expect(boot(nodeEnv, true, list)).rejects.toThrow(
          /HQ_ALLOW_SIGNUP is on in a deployed hq/,
        )
        await expect(publish(nodeEnv, true, list)).rejects.toThrow(
          /HQ_ALLOW_SIGNUP is on in a deployed hq/,
        )
        expect(await table()).toEqual([])
      })

      it("never writes the table at boot: an empty table is refused and stays empty", async () => {
        await expect(boot(nodeEnv, false, `id:${ann.userId}=UANN`)).rejects.toBeInstanceOf(
          FoundersOutOfDateError,
        )
        expect(await table()).toEqual([])
      })

      it("publish skips an email= entry even for a verified account, and says which entry", async () => {
        const synced = await publish(nodeEnv, false, "ann@example.com=UANN")
        expect(synced.added).toEqual([])
        expect(synced.skipped).toEqual([
          { entry: 1, kind: "email", why: expect.stringMatching(/by id/) },
        ])
        expect(await isFounder(hq.db, ann.userId)).toBe(false)
        expect(await table()).toEqual([])
      })

      it("publish adds an id: entry, and then a boot of the same list serves", async () => {
        const list = `id:${ann.userId}=UANN,bob@example.com=UBOB`
        const synced = await publish(nodeEnv, false, list)
        expect(synced.added).toEqual([ann.userId])
        expect(synced.skipped).toHaveLength(1)
        expect(await isFounder(hq.db, ann.userId)).toBe(true)
        // The boot checks and changes nothing, however often it runs.
        for (const _ of [1, 2]) {
          const booted = await boot(nodeEnv, false, list)
          expect(booted).toEqual({ added: [], removed: [], skipped: synced.skipped })
        }
        expect(await table()).toEqual([ann.userId])
      })

      it("an older deployment, booted after a newer deploy removed a founder, is refused and puts nobody back", async () => {
        const older = `id:${ann.userId}=UANN,id:${bob.userId}=UBOB`
        const newer = `id:${ann.userId}=UANN`
        await publish(nodeEnv, false, older)
        expect(await boot(nodeEnv, false, older)).toMatchObject({ added: [], removed: [] })
        // The newest deploy runs predeploy with bob taken out.
        expect((await publish(nodeEnv, false, newer)).removed).toEqual([bob.userId])
        // The old deployment's cold start: its list says bob, the table does not.
        await expect(boot(nodeEnv, false, older)).rejects.toBeInstanceOf(FoundersOutOfDateError)
        expect(await table()).toEqual([ann.userId])
        expect(await isFounder(hq.db, bob.userId)).toBe(false)
        // The newest still serves.
        await expect(boot(nodeEnv, false, newer)).resolves.toBeDefined()
      })

      it("is refused when the table has a founder the list lacks, or another Slack user for one", async () => {
        await publish(nodeEnv, false, `id:${ann.userId}=UANN,id:${bob.userId}=UBOB`)
        await expect(boot(nodeEnv, false, `id:${ann.userId}=UANN`)).rejects.toThrow(/1 not listed/)
        await expect(
          boot(nodeEnv, false, `id:${ann.userId}=UANN2,id:${bob.userId}=UBOB`),
        ).rejects.toThrow(/1 missing or changed/)
        expect(await table()).toEqual([ann.userId, bob.userId].sort())
      })

      it("an empty list publishes no founders, and a boot of it serves with nobody to approve", async () => {
        await publish(nodeEnv, false, `id:${ann.userId}=UANN`)
        expect((await publish(nodeEnv, false, "")).removed).toEqual([ann.userId])
        await expect(boot(nodeEnv, false, "")).resolves.toBeDefined()
        expect(await table()).toEqual([])
      })

      it("two predeploys at once leave the table as the list and both succeed", async () => {
        const list = `id:${ann.userId}=UANN,id:${bob.userId}=UBOB`
        const results = await Promise.all([1, 2, 3].map(() => publish(nodeEnv, false, list)))
        expect(results.flatMap((r) => r.added).sort()).toEqual([ann.userId, bob.userId].sort())
        expect(await table()).toEqual([ann.userId, bob.userId].sort())
        await expect(boot(nodeEnv, false, list)).resolves.toBeDefined()
      })
    })
  }

  describe("a local stack (NODE_ENV development or test)", () => {
    for (const nodeEnv of ["development", "test"]) {
      it(`${nodeEnv}: keeps sign-up as configured and honours an email= entry for a verified account`, async () => {
        const synced = await boot(nodeEnv, true, "ann@example.com=UANN")
        expect(synced).toEqual({ added: [ann.userId], removed: [], skipped: [] })
        expect(await isFounder(hq.db, ann.userId)).toBe(true)
        // A local hq still syncs at every boot: dropping the entry removes her.
        expect((await boot(nodeEnv, true, "")).removed).toEqual([ann.userId])
      })
    }
  })
})
