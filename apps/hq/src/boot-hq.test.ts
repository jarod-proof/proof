import type { Database } from "@proof/db"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { createHqHarness, type TestPerson } from "./app.test.helpers"
import { FoundersOutOfDateError, publishFounders } from "./boot"
import { bootHq, bootVercel, type HqConfig } from "./boot-hq"
import { founders } from "./db/schema"
import { BOOT_REFUSED_BODY, createLazyHq } from "./lazy-hq"

// What both entries run: `bootHq`, on a real hq database (PGlite). The harness's own app signs the
// founder up; `bootHq` builds a second app on the same database and secret, the way an instance
// that has just started would, and the cookie the harness minted must work on it.
const BASE = "http://localhost:3100"
const SECRET = "a-test-secret-that-is-long-enough-123456" // gitleaks:allow
const at = new Date("2026-11-17T12:00:00Z")
const byText = (a: string, b: string) => a.localeCompare(b)
const ask = async (
  lazy: ReturnType<typeof createLazyHq>,
  path: string,
  headers: Record<string, string> = {},
) => lazy.request(`${BASE}${path}`, { headers })

describe("bootHq (real hq database on PGlite)", () => {
  let hq: Awaited<ReturnType<typeof createHqHarness>>
  let ann: TestPerson
  let bob: TestPerson

  const config = (over: Partial<HqConfig> = {}): HqConfig => ({
    databaseUrl: "postgres://unused.invalid/hq",
    port: 3100,
    baseURL: BASE,
    founders: [{ who: { userId: ann.userId }, slackUserId: "UANN" }],
    slack: { signingSecret: undefined, teamId: undefined, dailyGrantCapUsd: undefined },
    allowSignUp: false,
    nodeEnv: "production",
    secret: SECRET,
    emailFrom: "Test <auth@example.com>",
    ...over,
  })
  const boot = (over: Partial<HqConfig> = {}) =>
    bootHq({ config: config(over), db: hq.db, now: () => at })

  beforeAll(async () => {
    hq = await createHqHarness()
    ann = await hq.signUp("ann@example.com")
    bob = await hq.signUp("bob@example.com")
  })
  afterAll(() => hq.close())

  describe("a healthy boot, served the way Vercel serves it", () => {
    it("serves /v1/status once the table is this deployment's list, and writes nothing itself", async () => {
      const lazy = createLazyHq(async () => (await boot()).app)
      // pnpm hq:predeploy ran for this deploy: the table is its list. The boot only checks it.
      await publishFounders(config(), hq.db, at)
      const before = await hq.db.select().from(founders)

      const res = await lazy.request(`${BASE}/v1/status`, {
        headers: { cookie: ann.cookie, origin: BASE },
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, version: "0.0.0" })
      expect(await hq.db.select().from(founders)).toEqual(before)
      expect(before.map((f) => f.userId)).toEqual([ann.userId])

      // The trust rule holds on the booted app: no credential is a 401, a signed-in non-founder 403.
      expect((await lazy.request(`${BASE}/v1/status`)).status).toBe(401)
      const stranger = await lazy.request(`${BASE}/v1/status`, {
        headers: { cookie: bob.cookie, origin: BASE },
      })
      expect(stranger.status).toBe(403)
    })
  })

  describe("a boot that refuses", () => {
    it("with sign-up open in a deployed hq: every request is a 503 and no founder is touched", async () => {
      await hq.db.delete(founders)
      const attempt = vi.fn(async () => (await boot({ allowSignUp: true })).app)
      const lazy = createLazyHq(attempt)
      for (const path of ["/", "/v1/status", "/mcp", "/health", "/openapi.json", "/api/auth/ok"]) {
        for (const headers of [
          {} as Record<string, string>,
          { cookie: ann.cookie, origin: BASE },
        ]) {
          const res = await lazy.request(`${BASE}${path}`, { headers })
          expect(res.status, path).toBe(503)
          expect(await res.text()).toBe(BOOT_REFUSED_BODY)
        }
      }
      expect(attempt).toHaveBeenCalledTimes(1)
      // Refused before the sync, so the table is as it was: empty, and nobody can approve.
      expect(await hq.db.select().from(founders)).toEqual([])
    })

    it("with NODE_ENV unset (deployed all the same) and sign-up open", async () => {
      await expect(boot({ allowSignUp: true, nodeEnv: undefined })).rejects.toThrow(
        /HQ_ALLOW_SIGNUP is on in a deployed hq/,
      )
    })

    it("a deployment whose predeploy never ran: the table is empty, every request is 503, nothing is written", async () => {
      await hq.db.delete(founders)
      const lazy = createLazyHq(async () => (await boot()).app)
      for (const headers of [{} as Record<string, string>, { cookie: ann.cookie, origin: BASE }]) {
        expect((await ask(lazy, "/v1/status", headers)).status).toBe(503)
      }
      expect(await hq.db.select().from(founders)).toEqual([])
    })

    it("a stale deployment: the table was written by a newer list, so every request is 503 and the removed founder stays removed", async () => {
      const older: HqConfig["founders"] = [
        { who: { userId: ann.userId }, slackUserId: "UANN" },
        { who: { userId: bob.userId }, slackUserId: "UBOB" },
      ]
      const newer: HqConfig["founders"] = [{ who: { userId: ann.userId }, slackUserId: "UANN" }]
      await hq.db.delete(founders)
      await publishFounders(config({ founders: older }), hq.db, at)
      // The newest deploy runs predeploy with bob taken out.
      await publishFounders(config({ founders: newer }), hq.db, at)

      // Someone sends one request to the old deployment's URL: it cold starts with its old list.
      const attempt = vi.fn(async () => (await boot({ founders: older })).app)
      const stale = createLazyHq(attempt)
      for (const path of ["/v1/status", "/mcp", "/", "/health", "/api/auth/ok"]) {
        for (const headers of [
          {} as Record<string, string>,
          { cookie: ann.cookie, origin: BASE },
          { cookie: bob.cookie, origin: BASE },
        ]) {
          const res = await ask(stale, path, headers)
          expect(res.status, path).toBe(503)
          expect(await res.text()).toBe(BOOT_REFUSED_BODY)
        }
      }
      expect(attempt).toHaveBeenCalledTimes(1)
      // It wrote nothing: bob is still not a founder, and the newest deployment still serves.
      expect((await hq.db.select().from(founders)).map((f) => f.userId)).toEqual([ann.userId])
      const current = createLazyHq(async () => (await boot({ founders: newer })).app)
      expect((await ask(current, "/v1/status", { cookie: ann.cookie, origin: BASE })).status).toBe(
        200,
      )
      expect((await ask(current, "/v1/status", { cookie: bob.cookie, origin: BASE })).status).toBe(
        403,
      )
    })

    it("when the founder sync itself fails, nothing is served (never against an unsynced table)", async () => {
      const broken: Database = Object.assign(Object.create(hq.db), {
        transaction: () => Promise.reject(new Error("connection refused")),
      })
      const serving = vi.fn()
      const lazy = createLazyHq(async () => {
        const booted = await bootHq({ config: config(), db: broken, now: () => at })
        serving()
        return booted.app
      })
      for (const path of ["/v1/status", "/mcp", "/"]) {
        expect((await lazy.request(`${BASE}${path}`)).status, path).toBe(503)
      }
      expect(serving).not.toHaveBeenCalled()
    })
  })

  describe("the Vercel entry's boot", () => {
    it("is a deployed hq whatever NODE_ENV says: a development override neither writes nor opens sign-up", async () => {
      await hq.db.delete(founders)
      const overridden = (over: Partial<HqConfig> = {}) =>
        config({ nodeEnv: "development", ...over })
      // A table that is not its list: a local boot would write it, this one refuses and writes nothing.
      await expect(
        bootVercel({ config: overridden(), db: hq.db, now: () => at }),
      ).rejects.toBeInstanceOf(FoundersOutOfDateError)
      expect(await hq.db.select().from(founders)).toEqual([])
      // Sign-up open is refused as it is in production.
      await expect(
        bootVercel({ config: overridden({ allowSignUp: true }), db: hq.db, now: () => at }),
      ).rejects.toThrow(/HQ_ALLOW_SIGNUP is on in a deployed hq/)
      // Through the shell: every request 503, nothing written.
      const lazy = createLazyHq(
        async () => (await bootVercel({ config: overridden(), db: hq.db, now: () => at })).app,
      )
      expect((await ask(lazy, "/v1/status")).status).toBe(503)
      expect(await hq.db.select().from(founders)).toEqual([])
      // And the plain bootHq with the same config is a local boot: it does write (the contrast).
      await bootHq({ config: overridden(), db: hq.db, now: () => at })
      expect((await hq.db.select().from(founders)).map((f) => f.userId)).toEqual([ann.userId])
    })
  })

  describe("instances booting at once", () => {
    const bothFounders = (): HqConfig["founders"] => [
      { who: { userId: ann.userId }, slackUserId: "UANN" },
      { who: { userId: bob.userId }, slackUserId: "UBOB" },
    ]
    const rendered = (rows: { userId: string; slackUserId: string }[]) =>
      rows.map((f) => `${f.userId}=${f.slackUserId}`).sort(byText)

    it("deployed: three cold starts after one predeploy all serve, and none writes", async () => {
      await hq.db.delete(founders)
      await publishFounders(config({ founders: bothFounders() }), hq.db, at)
      const before = await hq.db.select().from(founders)
      const lazies = [0, 1, 2].map(() =>
        createLazyHq(async () => (await boot({ founders: bothFounders() })).app),
      )
      const replies = await Promise.all(
        lazies.flatMap((lazy) => [
          ask(lazy, "/v1/status", { cookie: ann.cookie, origin: BASE }),
          ask(lazy, "/v1/status", { cookie: bob.cookie, origin: BASE }),
        ]),
      )
      expect(replies.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200])
      expect(await hq.db.select().from(founders)).toEqual(before)
    })

    it("local: two boots at once both succeed and the table is the list", async () => {
      await hq.db.delete(founders)
      const booted = await Promise.all([
        boot({ nodeEnv: "test", founders: bothFounders() }),
        boot({ nodeEnv: "test", founders: bothFounders() }),
      ])
      expect(booted).toHaveLength(2)
      expect(rendered(await hq.db.select().from(founders))).toEqual(
        [`${ann.userId}=UANN`, `${bob.userId}=UBOB`].sort(byText),
      )
    })

    it("local: two different lists at once leave exactly one of them, never a mix", async () => {
      await hq.db.delete(founders)
      const one: HqConfig["founders"] = [
        { who: { userId: ann.userId }, slackUserId: "UONE" },
        { who: { userId: bob.userId }, slackUserId: "UTWO" },
      ]
      const two: HqConfig["founders"] = [
        { who: { userId: ann.userId }, slackUserId: "UTWO" },
        { who: { userId: bob.userId }, slackUserId: "UONE" },
      ]
      await Promise.all([one, two, one].map((founders) => boot({ nodeEnv: "test", founders })))
      const rows = rendered(await hq.db.select().from(founders))
      const fmt = (l: HqConfig["founders"]) =>
        l.map((f) => `${"userId" in f.who ? f.who.userId : ""}=${f.slackUserId}`).sort(byText)
      expect([fmt(one), fmt(two)]).toContainEqual(rows)
    })
  })
})
