import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { user } from "@proof/db"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createHqHarness, type TestPerson } from "../app.test.helpers"
import { founders } from "../db/schema"
import {
  checkFounderPrincipals,
  founderPrincipals,
  founderPrincipalsFromDb,
} from "../slack/principals"
import { founderForSlackUser, isFounder, mayUseHq, parseFounders, syncFounders } from "./founders"

describe("HQ_FOUNDERS", () => {
  it("parses emails and user ids with their Slack users", () => {
    expect(parseFounders("Ann@Example.com=U01, id:u-2=W02 ,")).toEqual([
      { who: { email: "ann@example.com" }, slackUserId: "U01" },
      { who: { userId: "u-2" }, slackUserId: "W02" },
    ])
    expect(parseFounders(undefined)).toEqual([])
    expect(parseFounders("")).toEqual([])
  })

  it("stops on a list it half understands rather than quietly shrinking it", () => {
    for (const bad of [
      "ann@example.com",
      "ann@example.com=",
      "=U01",
      "ann@example.com=u01",
      "ann@example.com=U01,ann@example.com=U02",
      "ann@example.com=U01,bob@example.com=U01",
      "id:=U01",
    ]) {
      expect(() => parseFounders(bad), bad).toThrow(/HQ_FOUNDERS/)
    }
  })
})

describe("the founders table (real Postgres via PGlite)", () => {
  let hq: Awaited<ReturnType<typeof createHqHarness>>
  let ann: TestPerson
  let bob: TestPerson
  let squatter: TestPerson
  const at = new Date("2026-11-17T12:00:00Z")

  beforeAll(async () => {
    hq = await createHqHarness()
    ann = await hq.signUp("ann@example.com")
    bob = await hq.signUp("bob@example.com")
    // Signed up with an address they don't own: never verified.
    squatter = await hq.signUp("squatter@example.com", { verified: false })
  })
  afterAll(() => hq.close())

  it("adds the listed, skips an unverified or unknown address, and says why", async () => {
    const result = await syncFounders(
      hq.db,
      parseFounders("ann@example.com=UANN,squatter@example.com=USQUAT,nobody@example.com=UNOBODY"),
      at,
    )
    expect(result.added).toEqual([ann.userId])
    // Which entry of the list and why: never the address itself, which would end up in a log.
    expect(result.skipped).toEqual([
      { entry: 2, kind: "email", why: "the address is not verified" },
      { entry: 3, kind: "email", why: "no such account yet" },
    ])
    expect(JSON.stringify(result.skipped)).not.toContain("example.com")
    expect(await isFounder(hq.db, ann.userId)).toBe(true)
    expect(await isFounder(hq.db, squatter.userId)).toBe(false)
    expect(await founderForSlackUser(hq.db, "UANN")).toEqual({ userId: ann.userId })
    expect(await founderForSlackUser(hq.db, "USQUAT")).toBeNull()
  })

  it("sets the table to match the list: a founder dropped from it is removed, an empty list leaves none", async () => {
    await syncFounders(hq.db, parseFounders("ann@example.com=UANN,bob@example.com=UBOB"), at)
    expect(await isFounder(hq.db, bob.userId)).toBe(true)

    const dropped = await syncFounders(hq.db, parseFounders("ann@example.com=UANN"), at)
    expect(dropped.removed).toEqual([bob.userId])
    expect(await isFounder(hq.db, bob.userId)).toBe(false)
    // Bob's session is then turned away at hq's front door, and his Slack click is refused.
    expect((await hq.call({ cookie: bob.cookie }, "GET", "/v1/entries")).status).toBe(403)
    expect(await founderForSlackUser(hq.db, "UBOB")).toBeNull()

    const none = await syncFounders(hq.db, [], at)
    expect(none.removed).toEqual([ann.userId])
    expect(await hq.db.select().from(founders)).toEqual([])
    expect((await hq.call({ cookie: ann.cookie }, "GET", "/v1/entries")).status).toBe(403)
  })

  it("moves a Slack user between people, and changes a person's Slack user, in one sync", async () => {
    await syncFounders(hq.db, parseFounders("ann@example.com=UANN,bob@example.com=UBOB"), at)
    await syncFounders(hq.db, parseFounders("ann@example.com=UBOB,bob@example.com=UANN"), at)
    expect(await founderForSlackUser(hq.db, "UBOB")).toEqual({ userId: ann.userId })
    expect(await founderForSlackUser(hq.db, "UANN")).toEqual({ userId: bob.userId })
    await syncFounders(hq.db, [], at)
  })

  it("a banned account is no founder, though it has a row", async () => {
    await syncFounders(hq.db, parseFounders("ann@example.com=UANN"), at)
    await hq.db.update(user).set({ banned: true }).where(eq(user.id, ann.userId))
    expect(await isFounder(hq.db, ann.userId)).toBe(false)
    expect(await founderForSlackUser(hq.db, "UANN")).toBeNull()
    await hq.db.update(user).set({ banned: false }).where(eq(user.id, ann.userId))
    expect(await isFounder(hq.db, ann.userId)).toBe(true)
    await syncFounders(hq.db, [], at)
  })

  it("a key reaches hq only through a founder's organization, read from the table", async () => {
    const key = (orgId: string) => ({
      organizationId: orgId,
      actor: { type: "apiKey" as const, keyId: "k" },
      via: "api-key",
    })
    expect(await mayUseHq(hq.db, key(ann.orgId))).toBe(false)
    await syncFounders(hq.db, parseFounders("ann@example.com=UANN"), at)
    expect(await mayUseHq(hq.db, key(ann.orgId))).toBe(true)
    expect(await mayUseHq(hq.db, key(bob.orgId))).toBe(false)
    await syncFounders(hq.db, [], at)
  })

  describe("there is no way to add a founder but the boot sync", () => {
    it("no operation in the OpenAPI document or MCP tools/list is about founders", async () => {
      await syncFounders(hq.db, parseFounders("ann@example.com=UANN"), at)
      const doc = (await (await hq.app.request("http://localhost:3100/openapi.json")).json()) as {
        paths: Record<string, Record<string, { operationId?: string }>>
      }
      const names = Object.entries(doc.paths).flatMap(([path, methods]) =>
        Object.values(methods).map((m) => `${path} ${m.operationId ?? ""}`),
      )
      expect(names.filter((n) => /founder/i.test(n))).toEqual([])

      const client = new Client({ name: "test", version: "1.0.0" })
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://localhost:3100/mcp"), {
          fetch: async (url, init) => {
            const headers = new Headers(init?.headers)
            headers.set("cookie", ann.cookie)
            headers.set("origin", "http://localhost:3100")
            return hq.app.request(String(url), { ...init, headers })
          },
        }),
      )
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name).filter((n) => /founder/i.test(n))).toEqual([])
      await client.close()
    })

    it("a founder, a key and a stranger all get a 404 or 405 trying to write one", async () => {
      const agent = {
        key: await hq.keyFor(ann, {
          hq_entry: ["read"],
          hq_proposal: ["read", "create"],
          hq_spend: ["read", "record"],
        }),
      }
      const stranger = await hq.signUp("stranger@example.com")
      for (const as of [{ cookie: ann.cookie }, agent, { cookie: stranger.cookie }]) {
        for (const path of ["/v1/founders", `/v1/founders/${bob.userId}`, "/admin/founders"]) {
          for (const method of ["POST", "GET"] as const) {
            const body =
              method === "POST" ? { slackUserId: "UEVIL", userId: bob.userId } : undefined
            const res = await hq.call(as, method, path, body)
            expect([404, 405, 401, 403], `${method} ${path}`).toContain(res.status)
          }
        }
      }
      // And the table is as it was.
      expect((await hq.db.select().from(founders)).map((f) => f.userId)).toEqual([ann.userId])
      await syncFounders(hq.db, [], at)
    })
  })

  describe("the agent's founder list, derived from the table", () => {
    it("is slack:<team>:<user> for each founder, and a drift is reported", async () => {
      await syncFounders(hq.db, parseFounders("ann@example.com=UANN,bob@example.com=UBOB"), at)
      const derived = await founderPrincipalsFromDb(hq.db, "T0TEST")
      expect(derived).toEqual(["slack:T0TEST:UANN", "slack:T0TEST:UBOB"])
      expect(founderPrincipals("T1", ["UB", "UA", "UA"])).toEqual(["slack:T1:UA", "slack:T1:UB"])

      expect(checkFounderPrincipals(derived, "slack:T0TEST:UBOB, slack:T0TEST:UANN").ok).toBe(true)
      // The agent lists someone hq does not know: they could approve in eve what hq would refuse.
      expect(
        checkFounderPrincipals(derived, "slack:T0TEST:UANN,slack:T0TEST:UBOB,slack:T0TEST:UEVIL"),
      ).toEqual({ ok: false, missing: [], extra: ["slack:T0TEST:UEVIL"] })
      // The agent lacks a founder.
      expect(checkFounderPrincipals(derived, "slack:T0TEST:UANN")).toEqual({
        ok: false,
        missing: ["slack:T0TEST:UBOB"],
        extra: [],
      })
      // Nothing configured while founders exist, and the wrong workspace, both drift.
      expect(checkFounderPrincipals(derived, undefined).ok).toBe(false)
      expect(checkFounderPrincipals(derived, "slack:T9:UANN,slack:T9:UBOB").ok).toBe(false)
      // No founders and nothing listed agree: nobody can approve anywhere.
      expect(checkFounderPrincipals([], "").ok).toBe(true)
      await syncFounders(hq.db, [], at)
    })
  })
})
