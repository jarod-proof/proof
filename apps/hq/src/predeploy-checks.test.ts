import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { createHqHarness, type TestPerson } from "./app.test.helpers"
import { parseFounders } from "./data/founders"
import { founders } from "./db/schema"
import { runPredeploy } from "./predeploy-checks"

// `pnpm hq:predeploy` does every check before it writes anything, and it checks the agent's founder
// list against the list it is about to publish (the table still holds the last deploy's). So a
// founder added or removed passes once the vault's list was minted from the new HQ_FOUNDERS, and a
// refusal changes nothing: a refused deploy must not leave production on a table its instances
// refuse.
describe("runPredeploy (real hq database on PGlite)", () => {
  let hq: Awaited<ReturnType<typeof createHqHarness>>
  let ann: TestPerson
  let bob: TestPerson
  const at = new Date("2026-11-17T12:00:00Z")
  const TEAM = "T0TEST"
  const principals = (...slack: string[]) => slack.map((s) => `slack:${TEAM}:${s}`).join(",")

  beforeAll(async () => {
    hq = await createHqHarness()
    ann = await hq.signUp("ann@example.com")
    bob = await hq.signUp("bob@example.com")
  })
  afterAll(() => hq.close())
  afterEach(() => hq.db.delete(founders))

  const config = (list: string, over: Record<string, unknown> = {}) => ({
    nodeEnv: "production" as string | undefined,
    allowSignUp: false,
    founders: parseFounders(list),
    slack: { teamId: TEAM as string | undefined },
    ...over,
  })
  const rows = () => hq.db.select().from(founders)
  const predeploy = (list: string, agent: string | undefined, over = {}) =>
    runPredeploy(config(list, over), hq.db, agent, at)
  const both = () => `id:${ann.userId}=UANN,id:${bob.userId}=UBOB`
  const justAnn = () => `id:${ann.userId}=UANN`

  it("publishes when every check passes, and says what it published", async () => {
    const result = await predeploy(justAnn(), principals("UANN"))
    expect(result).toMatchObject({ ok: true, principals: [`slack:${TEAM}:UANN`] })
    expect((await rows()).map((f) => f.userId)).toEqual([ann.userId])
  })

  it("an accepted founder change passes: the agent list was minted from the new list, the table is the old one", async () => {
    await predeploy(justAnn(), principals("UANN"))
    // bob is added: the vault's list was minted from the new HQ_FOUNDERS before predeploy, while the
    // table still holds only ann. Checking against the table would refuse this.
    const added = await predeploy(both(), principals("UANN", "UBOB"))
    expect(added).toMatchObject({ ok: true })
    expect((await rows()).map((f) => f.userId).sort()).toEqual([ann.userId, bob.userId].sort())
    // And removed again.
    const removed = await predeploy(justAnn(), principals("UANN"))
    expect(removed).toMatchObject({ ok: true })
    expect((await rows()).map((f) => f.userId)).toEqual([ann.userId])
  })

  describe("a refused predeploy leaves the founders table exactly as it was", () => {
    const refusals: [string, () => ReturnType<typeof predeploy>, RegExp][] = [
      [
        "the agent's list is the old one (a founder was added)",
        () => predeploy(both(), principals("UANN")),
        /missing from the agent: slack:T0TEST:UBOB/,
      ],
      [
        "the agent's list still names a removed founder",
        () => predeploy(justAnn(), principals("UANN", "UBOB")),
        /listed by the agent but not founders: slack:T0TEST:UBOB/,
      ],
      [
        "the agent's list is unset",
        () => predeploy(justAnn(), undefined),
        /missing from the agent/,
      ],
      [
        "NODE_ENV is not production",
        () => predeploy(justAnn(), principals("UANN"), { nodeEnv: "development" }),
        /NODE_ENV is "development"/,
      ],
      [
        "NODE_ENV is unset",
        () => predeploy(justAnn(), principals("UANN"), { nodeEnv: undefined }),
        /NODE_ENV is unset/,
      ],
      [
        "public sign-up is on",
        () => predeploy(justAnn(), principals("UANN"), { allowSignUp: true }),
        /HQ_ALLOW_SIGNUP is on/,
      ],
      [
        "an email= entry is listed",
        () => predeploy("ann@example.com=UANN", principals("UANN")),
        /email= entry/,
      ],
      [
        "HQ_SLACK_TEAM_ID is unset",
        () => predeploy(justAnn(), principals("UANN"), { slack: {} }),
        /HQ_SLACK_TEAM_ID is not set/,
      ],
    ]
    for (const [name, run, why] of refusals) {
      it(name, async () => {
        // The table holds the previous deploy's founders: both of them, with real creation times.
        await predeploy(both(), principals("UANN", "UBOB"))
        const before = await rows()
        expect(before).toHaveLength(2)

        const result = await run()
        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.problems.join("\n")).toMatch(why)
        // Byte for byte: the same rows, with the same values, in the same order.
        expect(await rows()).toEqual(before)
      })
    }

    it("a founder entry whose account does not exist is not in the published list, so the agent must not list it", async () => {
      const list = `id:${ann.userId}=UANN,id:nobody=UGHOST`
      const wrong = await predeploy(list, principals("UANN", "UGHOST"))
      expect(wrong.ok).toBe(false)
      expect(await rows()).toEqual([])
      const right = await predeploy(list, principals("UANN"))
      expect(right).toMatchObject({ ok: true })
      if (right.ok) expect(right.synced.skipped).toHaveLength(1)
    })
  })
})
