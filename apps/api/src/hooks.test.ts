// Metering, idempotency, audit and permission hints, through the real REST and MCP surfaces.
import { type Caller, defineOperation } from "@proof/api"
import { idempotencyKey, user, auditEvent } from "@proof/db"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { createTestApp, SECRET } from "./app.test.helpers"
import { idempotencyLookup } from "./data/idempotency"
import { assertFreshSession, permissionHint, requestHash } from "./hooks"

// Fails on its first call only, so a retry after a failure can be checked.
let flakyCalls = 0
const flaky = defineOperation({
  name: "flaky",
  method: "POST",
  path: "/v1/flaky",
  summary: "Fails once",
  description: "Fails on the first call and succeeds after, to test idempotency retries.",
  permissions: { project: ["create"] },
  input: z.object({}),
  output: z.object({ call: z.number() }),
  examples: [{ input: {} }],
  handler: () => {
    flakyCalls++
    if (flakyCalls === 1) throw new Error("transient failure")
    return { call: flakyCalls }
  },
})

const json = async (res: Response) => ({ status: res.status, body: await res.json() })

describe("invocation hooks (real Postgres via PGlite)", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  beforeAll(async () => {
    t = await createTestApp([flaky])
  })
  afterAll(() => t.close())

  const createProject = (credential: string, name: string, key?: string) =>
    t.req(
      "/v1/projects",
      t.as(credential, {
        method: "POST",
        body: JSON.stringify({ name }),
        headers: key === undefined ? {} : { "idempotency-key": key },
      }),
    )

  describe("idempotency", () => {
    it("replays the first response for the same key and body, and runs the write once", async () => {
      const first = await json(await createProject(t.fullKey, "Replay me", "replay-1"))
      const again = await json(await createProject(t.fullKey, "Replay me", "replay-1"))
      expect(first.status).toBe(200)
      expect(again).toEqual(first)
      const listed = await json(await t.req("/v1/projects", t.as(t.readKey)))
      const matches = listed.body.projects.filter((p: { name: string }) => p.name === "Replay me")
      expect(matches).toHaveLength(1)
    })

    it("refuses a reused key with a different body", async () => {
      await createProject(t.fullKey, "Original", "reuse-1")
      const changed = await json(await createProject(t.fullKey, "Changed", "reuse-1"))
      expect(changed.status).toBe(409)
      expect(changed.body.error).toMatchObject({
        code: "CONFLICT",
        message: "This Idempotency-Key was already used for a different request",
      })
      expect(changed.body.error.hint).toContain("new Idempotency-Key")
    })

    it("does not replay another actor's response for the same key and body", async () => {
      const mine = await json(await createProject(t.fullKey, "Shared key", "actor-1"))
      expect(mine.status).toBe(200)
      const theirs = await json(await createProject(t.owner.cookie, "Shared key", "actor-1"))
      expect(theirs.status).toBe(409)
      expect(theirs.body.error).toMatchObject({ code: "CONFLICT" })
    })

    it("refuses a key whose first call is still running, with a retry hint", async () => {
      const who = await json(await t.req("/v1/whoami", t.as(t.fullKey)))
      const actor = { type: "apiKey" as const, keyId: who.body.actor.id as string }
      const now = new Date()
      await t.db.insert(idempotencyKey).values({
        id: crypto.randomUUID(),
        organizationId: t.owner.orgId,
        key: idempotencyLookup(SECRET, t.owner.orgId, "busy-1"),
        operation: "create_project",
        requestHash: requestHash("create_project", actor, { name: "Busy" }),
        status: "in_progress",
        response: null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      })
      const busy = await json(await createProject(t.fullKey, "Busy", "busy-1"))
      expect(busy.status).toBe(409)
      expect(busy.body.error).toMatchObject({ code: "CONFLICT" })
      expect(busy.body.error.hint).toContain("retry")
    })

    it("releases the key when the call fails, so the retry runs", async () => {
      flakyCalls = 0
      const post = (key: string) =>
        t.req(
          "/v1/flaky",
          t.as(t.fullKey, { method: "POST", body: "{}", headers: { "idempotency-key": key } }),
        )
      expect((await json(await post("flaky-1"))).status).toBe(500)
      const retry = await json(await post("flaky-1"))
      expect(retry).toEqual({ status: 200, body: { call: 2 } })
      // Completed: the same key now replays without running again.
      expect(await json(await post("flaky-1"))).toEqual({ status: 200, body: { call: 2 } })
      expect(flakyCalls).toBe(2)
    })

    it("stores neither the key nor the response readably, and still replays a new API key", async () => {
      const create = () =>
        t.req(
          "/v1/api-keys",
          t.as(t.owner.cookie, {
            method: "POST",
            body: JSON.stringify({ name: "Sealed", permissions: { project: ["read"] } }),
            headers: { "idempotency-key": "sealed-key-1" },
          }),
        )
      const first = await json(await create())
      expect(first.status).toBe(200)
      expect(first.body.key).toMatch(/^sk_/)
      expect(await json(await create())).toEqual(first)

      const rows = await t.db
        .select()
        .from(idempotencyKey)
        .where(eq(idempotencyKey.organizationId, t.owner.orgId))
      const stored = JSON.stringify(rows)
      // A database dump alone must not yield the secret key, nor the client's idempotency key. (Not a
      // check for "sk_" alone: three characters turn up by chance in the sealed, random bytes.)
      expect(stored).not.toContain(first.body.key)
      expect(stored).not.toContain("sealed-key-1")
    })

    it("ignores the key on readOnly operations", async () => {
      const a = await json(
        await t.req("/v1/whoami", t.as(t.readKey, { headers: { "idempotency-key": "ro-1" } })),
      )
      expect(a.status).toBe(200)
      const rows = await t.db
        .select()
        .from(idempotencyKey)
        .where(eq(idempotencyKey.key, idempotencyLookup(SECRET, t.owner.orgId, "ro-1")))
      expect(rows).toHaveLength(0)
    })

    it("rejects an empty Idempotency-Key header", async () => {
      const res = await json(await createProject(t.fullKey, "Empty", ""))
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe("BAD_REQUEST")
    })

    it("applies the key to MCP writes through the idempotencyKey argument", async () => {
      const client = await t.mcpClient(t.fullKey)
      try {
        const args = { name: "Via MCP", idempotencyKey: "mcp-1" }
        const first = await client.callTool({ name: "create_project", arguments: args })
        const again = await client.callTool({ name: "create_project", arguments: args })
        expect(again.structuredContent).toEqual(first.structuredContent)
      } finally {
        await client.close()
      }
    })
  })

  describe("audit", () => {
    it("records non-readOnly calls with actor, request id and outcome", async () => {
      const res = await t.req(
        "/v1/projects",
        t.as(t.fullKey, {
          method: "POST",
          body: JSON.stringify({ name: "Audited" }),
          headers: { "x-request-id": "req-audit-1" },
        }),
      )
      expect(res.status).toBe(200)
      const rows = await t.db
        .select()
        .from(auditEvent)
        .where(eq(auditEvent.requestId, "req-audit-1"))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        operation: "create_project",
        outcome: "ok",
        actorType: "apiKey",
        organizationId: t.owner.orgId,
      })
      // clientId names an OAuth client; an API key is the actor, not a client.
      expect(rows[0]?.clientId).toBeNull()
    })

    it("records a failed call with its error code", async () => {
      flakyCalls = 0 // the next call is the first, which fails
      await t.req(
        "/v1/flaky",
        t.as(t.fullKey, {
          method: "POST",
          body: "{}",
          headers: { "x-request-id": "req-flaky-audit" },
        }),
      )
      const rows = await t.db
        .select()
        .from(auditEvent)
        .where(eq(auditEvent.requestId, "req-flaky-audit"))
      expect(rows.map((r) => [r.operation, r.outcome])).toEqual([["flaky", "INTERNAL"]])
    })

    it("does not record readOnly calls", async () => {
      await t.req("/v1/whoami", t.as(t.readKey))
      const rows = await t.db.select().from(auditEvent).where(eq(auditEvent.operation, "whoami"))
      expect(rows).toHaveLength(0)
    })
  })

  describe("whoami", () => {
    it("reports usage against the limit and whether the owner has claimed the account", async () => {
      const body = (await json(await t.req("/v1/whoami", t.as(t.readKey)))).body
      expect(body.usage).toMatchObject({ limit: 500, total: expect.any(Number) })
      expect(body.usage.total).toBeGreaterThan(0)
      expect(body.claimed).toBe(false)
    })

    it("lifts to the claimed limit once the owner verifies their email", async () => {
      // acme is on Team in the test app, whose claimed limit is unlimited (null); put it on Free to
      // see a number, and put everything back whatever happens.
      await t.onPlan(t.owner.orgId, "free")
      try {
        // A raw write skips the claim hooks, which clear the cached plan; clear it as they would.
        await t.db.update(user).set({ emailVerified: true }).where(eq(user.id, t.owner.userId))
        await t.auth.entitlements.invalidate(t.owner.orgId)
        const body = (await json(await t.req("/v1/whoami", t.as(t.readKey)))).body
        expect(body).toMatchObject({ claimed: true, usage: { limit: 10_000 } })
      } finally {
        await t.db.update(user).set({ emailVerified: false }).where(eq(user.id, t.owner.userId))
        await t.onPlan(t.owner.orgId, "team")
        await t.auth.entitlements.invalidate(t.owner.orgId)
      }
    })

    it("sends RateLimit headers on success", async () => {
      const res = await t.req("/v1/whoami", t.as(t.readKey))
      expect(res.headers.get("ratelimit-limit")).toBe("500")
      expect(Number(res.headers.get("ratelimit-remaining"))).toBeGreaterThanOrEqual(0)
      expect(Number(res.headers.get("ratelimit-reset"))).toBeGreaterThan(0)
    })
  })

  describe("permission hints", () => {
    it("names the OAuth scopes and the API key permission that would allow the call", async () => {
      const res = await json(await createProject(t.readKey, "Denied"))
      expect(res.status).toBe(403)
      expect(res.body.error.hint).toBe(
        "Needs project:create. Use an OAuth token with scope `write`, or an API key with project:create.",
      )
    })

    it("says when no OAuth scope grants the missing permission", () => {
      // Team permissions are in the catalog but no scope grants them.
      expect(permissionHint({ team: ["create"] })).toBe(
        "Needs team:create. Use an API key with team:create (no OAuth scope grants it).",
      )
    })
  })
})

describe("metering limits", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  beforeAll(async () => {
    t = await createTestApp([], { limits: { unclaimed: 3 } })
  })
  afterAll(() => t.close())

  it("refuses calls over the unclaimed daily limit with a hint and Retry-After", async () => {
    const statuses: number[] = []
    for (let i = 0; i < 3; i++) statuses.push((await t.req("/v1/whoami", t.as(t.readKey))).status)
    expect(statuses).toEqual([200, 200, 200])

    const over = await t.req("/v1/whoami", t.as(t.readKey))
    expect(over.status).toBe(429)
    const retryAfter = Number(over.headers.get("retry-after"))
    expect(retryAfter).toBeGreaterThanOrEqual(1)
    expect(retryAfter).toBeLessThanOrEqual(86_400)
    expect(over.headers.get("ratelimit-remaining")).toBe("0")
    const body = (await over.json()) as { error: { code: string; hint: string } }
    expect(body.error.code).toBe("RATE_LIMITED")
    expect(body.error.hint).toContain("Verify it")
  })

  it("audits a write refused by the limit", async () => {
    const res = await t.req(
      "/v1/projects",
      t.as(t.fullKey, { method: "POST", body: JSON.stringify({ name: "Over" }) }),
    )
    expect(res.status).toBe(429)
    const rows = await t.db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.operation, "create_project"))
    expect(rows.map((r) => r.outcome)).toEqual(["RATE_LIMITED"])
  })
})

describe("metering the web app", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  beforeAll(async () => {
    t = await createTestApp([], { limits: { unclaimed: 3 } })
  })
  afterAll(() => t.close())

  it("doesn't spend the agents' daily budget on a person's requests", async () => {
    // The shell polls the inbox and the running count; none of it counts.
    for (let i = 0; i < 5; i++) {
      expect((await t.req("/v1/inbox", t.as(t.owner.cookie))).status).toBe(200)
    }
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) statuses.push((await t.req("/v1/whoami", t.as(t.readKey))).status)
    expect(statuses).toEqual([200, 200, 200, 429])
    // And a person still gets an answer once the agents are over the limit.
    expect((await t.req("/v1/inbox", t.as(t.owner.cookie))).status).toBe(200)
  })

  it("still counts a person's writes", async () => {
    const res = await t.req(
      "/v1/projects",
      t.as(t.owner.cookie, { method: "POST", body: JSON.stringify({ name: "Over" }) }),
    )
    expect(res.status).toBe(429)
  })
})

// Sensitive and ordinary writes, to compare a stale session on each.
const enrol = defineOperation({
  name: "enrol_thing",
  method: "POST",
  path: "/v1/things/enrol",
  summary: "Enrol a sensitive thing",
  description: "A sensitive write: needs a recent sign-in.",
  permissions: { project: ["create"] },
  fresh: true,
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  examples: [{ input: {} }],
  handler: () => ({ ok: true }),
})
const plain = defineOperation({
  ...enrol,
  name: "plain_thing",
  path: "/v1/things/plain",
  summary: "An ordinary write",
  description: "An ordinary write.",
  fresh: undefined,
})

describe("fresh sessions (assertFreshSession)", () => {
  const now = new Date("2026-10-18T12:00:00Z")
  const caller = (over: Partial<Caller>): Caller => ({
    organizationId: "org1",
    actor: { type: "user", userId: "u1" },
    grants: [{ project: ["create"] }],
    via: "session",
    sessionCreatedAt: new Date(now.getTime() - 60_000),
    ...over,
  })
  const at = (seconds: number) => new Date(now.getTime() - seconds * 1000)

  it("passes a fresh session and refuses one an hour or more old", () => {
    expect(() => assertFreshSession(enrol, caller({}), now)).not.toThrow()
    expect(() => assertFreshSession(enrol, caller({ sessionCreatedAt: at(3600) }), now)).toThrow(
      expect.objectContaining({ code: "SESSION_NOT_FRESH", status: 403 }),
    )
  })

  it("refuses a session whose age is unknown", () => {
    expect(() => assertFreshSession(enrol, caller({ sessionCreatedAt: undefined }), now)).toThrow(
      expect.objectContaining({ code: "SESSION_NOT_FRESH" }),
    )
  })

  it("exempts API keys and OAuth tokens, which have no sign-in age", () => {
    const key = caller({
      via: "api-key",
      actor: { type: "apiKey", keyId: "k1" },
      sessionCreatedAt: undefined,
    })
    const oauth = caller({ via: "oauth", clientId: "c1", sessionCreatedAt: undefined })
    expect(() => assertFreshSession(enrol, key, now)).not.toThrow()
    expect(() => assertFreshSession(enrol, oauth, now)).not.toThrow()
  })

  it("leaves operations that are not marked fresh alone", () => {
    expect(() =>
      assertFreshSession(plain, caller({ sessionCreatedAt: at(7200) }), now),
    ).not.toThrow()
  })
})

describe("fresh sessions over REST (real Postgres via PGlite)", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  beforeAll(async () => {
    t = await createTestApp([enrol, plain])
  })
  afterAll(() => t.close())

  /** Make the owner's session look two hours old. */
  const ageOwnerSession = async (seconds: number) =>
    (await t.auth.$context).adapter.update({
      model: "session",
      where: [{ field: "userId", value: t.owner.userId }],
      update: { createdAt: new Date(Date.now() - seconds * 1000) },
    })

  it("runs a fresh operation for a fresh session", async () => {
    const res = await t.req(
      "/v1/things/enrol",
      t.as(t.owner.cookie, { method: "POST", body: "{}" }),
    )
    expect(res.status).toBe(200)
  })

  it("refuses a fresh operation for a stale session with SESSION_NOT_FRESH", async () => {
    await ageOwnerSession(2 * 60 * 60)
    const res = await t.req(
      "/v1/things/enrol",
      t.as(t.owner.cookie, { method: "POST", body: "{}" }),
    )
    const body = await res.json()
    expect(res.status).toBe(403)
    expect(body.error.code).toBe("SESSION_NOT_FRESH")
    expect(body.error.hint).toMatch(/Sign in again/)
  })

  it("still runs an ordinary write for the same stale session", async () => {
    const res = await t.req(
      "/v1/things/plain",
      t.as(t.owner.cookie, { method: "POST", body: "{}" }),
    )
    expect(res.status).toBe(200)
  })

  it("runs a fresh operation with an API key, which has no sign-in age", async () => {
    const res = await t.req("/v1/things/enrol", t.as(t.fullKey, { method: "POST", body: "{}" }))
    expect(res.status).toBe(200)
  })
})
