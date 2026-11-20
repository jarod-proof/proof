// Feature flags end to end: the operator operations over REST, evaluation over OFREP for each
// organization (targets, percentage, kill switch, reclaim), exposures and the 5xx errors counted
// against the values a request saw, and the lifecycle's guards (reclaimed is final; a rollout is
// deleted only once the code no longer declares it). acme is the operator organization.
import { defineOperation } from "@proof/api"
import { featureFlag } from "@proof/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"

import { createTestApp } from "./app.test.helpers"
import type { FlagService } from "./flags"

type Json = Record<string, unknown>

// Its own catalog, so the product's flags can come and go without touching this test.
const catalog = {
  "new-checkout": { description: "Checkout v2", owner: "payments", default: false },
  "beta-search": { description: "Search v2", owner: "search", default: false },
}

// Reads a flag, then fails: its 5xx is counted against the value the request saw.
let service: FlagService | undefined
const flaky = defineOperation({
  name: "flaky_search",
  method: "GET",
  path: "/v1/flaky-search",
  summary: "Fails after reading a flag",
  description: "Test only.",
  permissions: {},
  input: z.object({}),
  output: z.object({}),
  handler: async (_input, { caller }) => {
    // A key of this test's catalog, not the product's FlagKey.
    await service?.isEnabled(caller, "new-checkout" as never)
    throw new Error("search backend down")
  },
})

describe("feature flags", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  let otherSlug: string

  beforeAll(async () => {
    t = await createTestApp([flaky], { flagCatalog: catalog })
    service = t.flags
    const other = await t.req("/v1/whoami", t.as(t.other.cookie))
    expect(((await other.json()) as Json).operator).toBe(false)
    const org = await t.auth.api.getFullOrganization({
      headers: new Headers({ cookie: t.other.cookie }),
    })
    otherSlug = org?.slug ?? ""
  })
  afterAll(() => t.close())

  const send = async (credential: string, path: string, method: string, body?: unknown) => {
    const res = await t.req(
      path,
      t.as(credential, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
    )
    return { status: res.status, body: (await res.json()) as Json, headers: res.headers }
  }
  const owner = (path: string, method = "GET", body?: unknown) =>
    send(t.owner.cookie, path, method, body)
  /** The flag's OFREP evaluation for the organization behind `credential`. */
  const ofrep = async (credential: string, key: string, context: Json = {}) =>
    (await send(credential, `/ofrep/v1/evaluate/flags/${key}`, "POST", { context })).body

  it("tells the operator organization it is one", async () => {
    expect((await owner("/v1/whoami")).body.operator).toBe(true)
  })

  it("names the operator organization to its members, whatever organization they are on", async () => {
    const path = "/v1/me/operator-organization"
    expect((await owner(path)).body).toEqual({ organizationId: t.owner.orgId })
    // The viewer's session moves to their own organization; acme is still theirs to manage.
    const setActive = (organizationId: string) =>
      t.auth.api.setActiveOrganization({
        headers: new Headers({ cookie: t.viewer.cookie }),
        body: { organizationId },
      })
    await setActive(t.viewer.orgId)
    try {
      expect((await send(t.viewer.cookie, path, "GET")).body).toEqual({
        organizationId: t.owner.orgId,
      })
    } finally {
      await setActive(t.owner.orgId)
    }
    expect((await send(t.other.cookie, path, "GET")).body).toEqual({ organizationId: null })
    // A person's question: keys are refused before the handler.
    expect((await send(t.fullKey, path, "GET")).status).toBe(403)
  })

  it("lists every declared flag, off with no rollout", async () => {
    const { status, body } = await owner("/v1/feature-flags")
    expect(status).toBe(200)
    const flags = body.flags as Json[]
    expect(flags.map((f) => f.key)).toEqual(["new-checkout", "beta-search"])
    expect(flags[1]).toMatchObject({
      status: "off",
      inCatalog: true,
      enabled: true,
      percentage: 0,
      updatedAt: null,
      stale: [],
    })
    expect(await ofrep(t.other.cookie, "beta-search")).toEqual({
      key: "beta-search",
      value: false,
      variant: "off",
      reason: "DISABLED",
      metadata: {},
    })
  })

  it("targets one organization by slug, and only it gets the flag", async () => {
    const res = await owner("/v1/feature-flags/beta-search/targets", "POST", {
      organizations: [otherSlug],
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ status: "targeting", targetsOn: 1 })
    expect(await ofrep(t.other.cookie, "beta-search")).toMatchObject({
      value: true,
      reason: "TARGETING_MATCH",
    })
    // The operator's own organization is not a target, and a context can't claim to be one.
    expect(
      await ofrep(t.owner.cookie, "beta-search", { targetingKey: t.other.orgId }),
    ).toMatchObject({ value: false })
    const got = await owner("/v1/feature-flags/beta-search")
    expect(got.body.targets).toEqual([
      expect.objectContaining({ organizationId: t.other.orgId, slug: otherSlug, value: true }),
    ])
  })

  it("names organizations that don't exist", async () => {
    const res = await owner("/v1/feature-flags/beta-search/targets", "POST", {
      organizations: ["no-such-org", t.other.orgId],
    })
    expect(res.status).toBe(400)
    expect(JSON.stringify(res.body)).toContain("no-such-org")
  })

  it("ramps by percentage, and the kill switch serves the default to everyone", async () => {
    expect(
      (await owner("/v1/feature-flags/beta-search", "PATCH", { percentage: 100 })).body,
    ).toMatchObject({ status: "on", percentage: 100 })
    expect(await ofrep(t.owner.cookie, "beta-search")).toMatchObject({
      value: true,
      reason: "STATIC",
    })
    // A deny target takes one organization out of the ramp.
    await owner("/v1/feature-flags/beta-search/targets", "POST", {
      organizations: [t.other.orgId],
      value: false,
    })
    expect(await ofrep(t.other.cookie, "beta-search")).toMatchObject({ value: false })
    expect(
      (await owner("/v1/feature-flags/beta-search", "PATCH", { enabled: false })).body,
    ).toMatchObject({ status: "paused" })
    expect(await ofrep(t.owner.cookie, "beta-search")).toMatchObject({
      value: false,
      reason: "DISABLED",
    })
    await owner("/v1/feature-flags/beta-search", "PATCH", { enabled: true, percentage: 50 })
    const untarget = await owner(`/v1/feature-flags/beta-search/targets/${otherSlug}`, "DELETE")
    expect(untarget.body).toMatchObject({ removed: true, targetsOff: 0, status: "ramping" })
  })

  it("serves OFREP in bulk with an ETag, and 404s an undeclared key", async () => {
    const first = await send(t.other.cookie, "/ofrep/v1/evaluate/flags", "POST", { context: {} })
    expect(first.status).toBe(200)
    expect((first.body.flags as Json[]).map((f) => f.key)).toEqual(["new-checkout", "beta-search"])
    const etag = first.headers.get("etag") ?? ""
    expect(etag).toMatch(/^W\/"[0-9a-f]+"$/)
    const again = await t.req(
      "/ofrep/v1/evaluate/flags",
      t.as(t.other.cookie, { method: "POST", body: "{}", headers: { "if-none-match": etag } }),
    )
    expect(again.status).toBe(304)
    const missing = await send(t.other.cookie, "/ofrep/v1/evaluate/flags/not-a-flag", "POST", {})
    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ key: "not-a-flag", errorCode: "FLAG_NOT_FOUND" })
    const anonymous = await t.req("/ofrep/v1/evaluate/flags", { method: "POST", body: "{}" })
    expect(anonymous.status).toBe(401)
  })

  it("counts evaluations, and the 5xx errors that followed them, per value", async () => {
    await t.flags.flush()
    const before = (await owner("/v1/feature-flags/new-checkout")).body.exposures as Json
    const failed = await t.req("/v1/flaky-search", t.as(t.other.cookie))
    expect(failed.status).toBe(500)
    await t.flags.flush()
    const after = (await owner("/v1/feature-flags/new-checkout")).body as Json
    expect(after.exposures).toEqual({
      ...before,
      off: (before.off as number) + 1,
      errorsOff: (before.errorsOff as number) + 1,
    })
    expect(after.days).toEqual([expect.objectContaining({ value: false, errors: 1 })])
  })

  it("refuses a key the code doesn't declare", async () => {
    const res = await owner("/v1/feature-flags/not-declared", "PATCH", { percentage: 5 })
    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ error: { hint: expect.stringContaining("defineFlags") } })
  })

  it("reclaims once: one value for everyone, then the rollout is frozen", async () => {
    const reclaimed = await owner("/v1/feature-flags/beta-search/reclaim", "POST", { value: true })
    expect(reclaimed.body).toMatchObject({
      status: "reclaimed",
      reclaimedValue: true,
      stale: ["reclaimed-in-code"],
    })
    expect(await ofrep(t.other.cookie, "beta-search")).toMatchObject({
      value: true,
      reason: "STATIC",
    })
    for (const [path, method, body] of [
      ["/v1/feature-flags/beta-search", "PATCH", { percentage: 0 }],
      ["/v1/feature-flags/beta-search/targets", "POST", { organizations: [otherSlug] }],
      [`/v1/feature-flags/beta-search/targets/${otherSlug}`, "DELETE", undefined],
      ["/v1/feature-flags/beta-search/reclaim", "POST", { value: false }],
    ] as const) {
      expect((await owner(path, method, body)).status, `${method} ${path}`).toBe(409)
    }
    // Still declared: deleting the rollout now would drop everyone back to the default.
    const early = await owner("/v1/feature-flags/beta-search", "DELETE")
    expect(early.status).toBe(409)
  })

  it("reports a rollout the code no longer declares as orphaned, and deletes it", async () => {
    const now = new Date()
    await t.db.insert(featureFlag).values({
      key: "retired-flag",
      organizationId: t.owner.orgId,
      reclaimedValue: true,
      reclaimedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    const stale = await owner("/v1/feature-flags?stale=true")
    expect((stale.body.flags as Json[]).find((f) => f.key === "retired-flag")).toMatchObject({
      status: "orphaned",
      inCatalog: false,
      description: null,
      stale: ["orphaned"],
    })
    expect((await owner("/v1/feature-flags/retired-flag", "DELETE")).body).toEqual({
      deleted: true,
    })
    expect((await owner("/v1/feature-flags/retired-flag")).status).toBe(404)
    expect((await owner("/v1/feature-flags/retired-flag", "DELETE")).status).toBe(404)
  })

  it("refuses other organizations' owners, though their role holds featureFlag", async () => {
    const res = await send(t.other.cookie, "/v1/feature-flags", "GET")
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({
      error: { hint: expect.stringContaining("operator organization") },
    })
  })
})

describe("feature flags with no operator organization", () => {
  it("refuses every operator operation, and still evaluates", async () => {
    const t = await createTestApp([], { operator: false, flagCatalog: catalog })
    try {
      expect((await t.req("/v1/feature-flags", t.as(t.owner.cookie))).status).toBe(403)
      const me = await t.req("/v1/me/operator-organization", t.as(t.owner.cookie))
      expect(await me.json()).toEqual({ organizationId: null })
      const res = await t.req(
        "/ofrep/v1/evaluate/flags/new-checkout",
        t.as(t.owner.cookie, { method: "POST", body: "{}" }),
      )
      expect(await res.json()).toMatchObject({ value: false, reason: "DISABLED" })
    } finally {
      await t.close()
    }
  })
})
