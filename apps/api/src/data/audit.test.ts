import type { Caller } from "@proof/api"
import {
  type CallerActsFor,
  callerActsFor,
  name,
  type Named,
  OrganizationId,
} from "@proof/auth-proofs"
import { personalSlug } from "@proof/auth"
import { auditEvent, member, organization, user } from "@proof/db"
import { createTestDb } from "@proof/db/testing"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { listAuditEvents, recordAuditEvent, recordAuthEvent } from "./audit"

const caller = (organizationId: string): Caller => ({
  organizationId,
  actor: { type: "user", userId: "user_1" },
  grants: [],
  via: "session",
})

/** Run `fn` with the org's name and a proof that the caller acts for it. */
function acting<R>(
  orgId: string,
  fn: <O>(org: Named<O, OrganizationId>, proof: CallerActsFor<O>) => Promise<R>,
): Promise<R> {
  return name(OrganizationId(orgId), async (org) => {
    const proof = callerActsFor(caller(orgId), org)
    if (!proof) throw new Error("caller does not act for the organization")
    return fn(org, proof)
  })
}

describe("audit events", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>
  beforeEach(async () => {
    t = await createTestDb()
    for (const id of ["org_a", "org_b"]) {
      await t.db.insert(organization).values({ id, name: id, slug: id, createdAt: new Date() })
    }
  })
  afterEach(() => t.close())

  const event = (operation: string, outcome: "ok" | "FORBIDDEN" = "ok") => ({
    actorType: "apiKey" as const,
    actorId: "key_1",
    clientId: "client_1",
    operation,
    outcome,
    requestId: `req-${operation}`,
  })

  it("lists the organization's events newest first, paginated without repeats", async () => {
    await acting("org_a", (org, proof) =>
      recordAuditEvent(t.db, org, proof, event("create_project")),
    )
    await acting("org_a", (org, proof) =>
      recordAuditEvent(t.db, org, proof, event("delete_project")),
    )
    await acting("org_a", (org, proof) =>
      recordAuditEvent(t.db, org, proof, event("create_api_key", "FORBIDDEN")),
    )

    const first = await acting("org_a", (org, proof) =>
      listAuditEvents(t.db, org, proof, { limit: 2 }),
    )
    expect(first).toHaveLength(2)
    expect(first.map((e) => e.operation)).toEqual(["create_api_key", "delete_project"])
    expect(first[0]).toMatchObject({
      actorType: "apiKey",
      actorId: "key_1",
      clientId: "client_1",
      outcome: "FORBIDDEN",
      requestId: "req-create_api_key",
    })

    const last = first[1]
    if (!last) throw new Error("expected a second event")
    const second = await acting("org_a", (org, proof) =>
      listAuditEvents(t.db, org, proof, {
        limit: 2,
        after: { at: last.at.toISOString(), id: last.id },
      }),
    )
    expect(second.map((e) => e.operation)).toEqual(["create_project"])
  })

  it("never returns another organization's events", async () => {
    await acting("org_b", (org, proof) =>
      recordAuditEvent(t.db, org, proof, event("create_project")),
    )

    const seen = await acting("org_a", (org, proof) =>
      listAuditEvents(t.db, org, proof, { limit: 50 }),
    )
    expect(seen).toEqual([])
  })

  it("only mints a proof for the organization the caller acts for", () => {
    name(OrganizationId("org_a"), (org) => {
      expect(callerActsFor(caller("org_b"), org)).toBeNull()
      expect(callerActsFor(caller("org_a"), org)).not.toBeNull()
    })
  })
})

describe("auth events", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>
  const now = new Date()
  beforeEach(async () => {
    t = await createTestDb()
    await t.db.insert(user).values([
      { id: "u_ann", name: "Ann", email: "ann@example.com" },
      { id: "u_bob", name: "Bob", email: "bob@example.com" },
    ])
    // Each person's personal organization (slug personal-<id>), and one shared organization.
    await t.db.insert(organization).values([
      { id: "org_ann", name: "Ann", slug: personalSlug("u_ann"), createdAt: now },
      { id: "org_bob", name: "Bob", slug: personalSlug("u_bob"), createdAt: now },
      { id: "org_shared", name: "Shared", slug: "shared", createdAt: now },
    ])
    await t.db.insert(member).values([
      { id: "m1", organizationId: "org_ann", userId: "u_ann", role: "owner", createdAt: now },
      { id: "m2", organizationId: "org_bob", userId: "u_bob", role: "owner", createdAt: now },
      { id: "m3", organizationId: "org_shared", userId: "u_ann", role: "member", createdAt: now },
    ])
  })
  afterEach(() => t.close())

  const rows = () => t.db.select().from(auditEvent)
  const authEvent = (over: Partial<Parameters<typeof recordAuthEvent>[1]> = {}) => ({
    name: "auth.sign_in",
    userId: "u_ann",
    organizationId: null,
    outcome: "ok",
    path: "/sign-in/email",
    ...over,
  })

  it("writes an account event to the user's personal organization as a user actor", async () => {
    expect(await recordAuthEvent(t.db, authEvent({ name: "auth.password_changed" }))).toBe(true)
    const [row] = await rows()
    expect(row).toMatchObject({
      organizationId: "org_ann",
      actorType: "user",
      actorId: "u_ann",
      operation: "auth.password_changed",
      outcome: "ok",
      clientId: null,
      requestId: null,
    })
  })

  it("writes into the event's organization when the person is a member of it", async () => {
    await recordAuthEvent(
      t.db,
      authEvent({
        name: "auth.member_removed",
        organizationId: "org_shared",
        outcome: "FORBIDDEN",
      }),
    )
    const [row] = await rows()
    expect(row).toMatchObject({ organizationId: "org_shared", outcome: "FORBIDDEN" })
  })

  it("falls back to the personal organization when the person isn't a member of the named one", async () => {
    await recordAuthEvent(
      t.db,
      authEvent({ name: "auth.api_key_created", organizationId: "org_bob" }),
    )
    const [row] = await rows()
    expect(row).toMatchObject({ organizationId: "org_ann", operation: "auth.api_key_created" })
  })

  it("writes nothing for an unknown account", async () => {
    expect(
      await recordAuthEvent(t.db, authEvent({ name: "auth.sign_in_failed", userId: null })),
    ).toBe(false)
    expect(await rows()).toEqual([])
  })

  it("writes nothing when the person has no personal organization and isn't a member of the named one", async () => {
    await t.db.insert(user).values({ id: "u_cy", name: "Cy", email: "cy@example.com" })
    expect(
      await recordAuthEvent(
        t.db,
        authEvent({ userId: "u_cy", name: "auth.sign_out", organizationId: "org_shared" }),
      ),
    ).toBe(false)
    expect(await rows()).toEqual([])
  })

  it("stores a failed sign-in for a known account with the error code as the outcome", async () => {
    await recordAuthEvent(
      t.db,
      authEvent({
        name: "auth.sign_in_failed",
        outcome: "INVALID_EMAIL_OR_PASSWORD",
        ip: "10.0.0.1",
      }),
    )
    const [row] = await rows()
    expect(row).toMatchObject({
      organizationId: "org_ann",
      operation: "auth.sign_in_failed",
      outcome: "INVALID_EMAIL_OR_PASSWORD",
    })
  })

  it("keeps the events visible to the organization's own list", async () => {
    await recordAuthEvent(t.db, authEvent({ name: "auth.sign_out" }))
    await recordAuthEvent(t.db, authEvent({ userId: "u_bob", name: "auth.sign_out" }))
    const seen = await acting("org_ann", (org, proof) =>
      listAuditEvents(t.db, org, proof, { limit: 10 }),
    )
    expect(seen.map((e) => e.actorId)).toEqual(["u_ann"])
  })
})
