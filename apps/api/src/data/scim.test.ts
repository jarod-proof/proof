// The organization's SCIM tokens: only live tokens of this organization, with no secrets, and a
// revoked or another organization's token is not in the list.
import type { Caller } from "@proof/api"
import {
  type CallerActsFor,
  callerActsFor,
  name,
  type Named,
  OrganizationId,
} from "@proof/auth-proofs"
import { organization, scimManagedConnection, scimManagedCredential, user } from "@proof/db"
import { createTestDb } from "@proof/db/testing"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { listScimTokens } from "./scim"

const caller = (organizationId: string): Caller => ({
  organizationId,
  actor: { type: "user", userId: "user_owner" },
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

describe("SCIM tokens (real Postgres via PGlite)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>
  beforeEach(async () => {
    t = await createTestDb()
    const now = new Date("2026-01-01T00:00:00Z")
    for (const id of ["org_a", "org_b"]) {
      await t.db.insert(organization).values({ id, name: id, slug: id, createdAt: now })
    }
    await t.db.insert(user).values({
      id: "user_owner",
      name: "Olive Owner",
      email: "owner@example.com",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
  })
  afterEach(() => t.close())

  /** A managed connection with one credential, created by `createdBy`. */
  async function token(
    id: string,
    org: string,
    opts: {
      status?: string
      credentialStatus?: string
      lastUsedAt?: Date
      createdAt?: Date
    } = {},
  ) {
    const now = opts.createdAt ?? new Date("2026-01-02T00:00:00Z")
    await t.db.insert(scimManagedConnection).values({
      id: `rec_${id}`,
      creationRequestId: `req_${id}`,
      connectionId: id,
      provisioningDomainId: org,
      status: opts.status ?? "active",
      revision: 1,
      createdAt: now,
      createdBy: "user_owner",
    })
    await t.db.insert(scimManagedCredential).values({
      id: `cred_row_${id}`,
      connectionRecordId: `rec_${id}`,
      credentialId: `cred_${id}`,
      tokenDigest: "digest",
      hashVersion: "v1",
      activeSlotKey: `slot_${id}`,
      status: opts.credentialStatus ?? "active",
      serializedScopes: "[]",
      expiresAt: new Date("2027-01-02T00:00:00Z"),
      createdAt: now,
      createdBy: "user_owner",
      lastUsedAt: opts.lastUsedAt ?? null,
    })
  }

  it("lists the organization's live tokens with the minting person and last use, and no secrets", async () => {
    await token("conn_old", "org_a", {
      lastUsedAt: new Date("2026-03-01T00:00:00Z"),
      createdAt: new Date("2026-01-01T00:00:00Z"),
    })
    await token("conn_new", "org_a", { createdAt: new Date("2026-01-03T00:00:00Z") })
    const rows = await acting("org_a", (org, proof) => listScimTokens(t.db, org, proof))
    expect(rows.map((r) => r.id)).toEqual(["conn_new", "conn_old"])
    expect(rows[1]).toMatchObject({
      id: "conn_old",
      credentialIds: ["cred_conn_old"],
      createdBy: { id: "user_owner", name: "Olive Owner" },
      lastUsedAt: new Date("2026-03-01T00:00:00Z"),
    })
    expect(rows[0]?.lastUsedAt).toBeNull()
    expect(JSON.stringify(rows)).not.toContain("digest")
  })

  it("leaves out revoked and decommissioned tokens and another organization's", async () => {
    await token("conn_live", "org_a")
    await token("conn_revoked", "org_a", { credentialStatus: "revoked" })
    await token("conn_gone", "org_a", { status: "decommissioned" })
    await token("conn_other", "org_b")
    const rows = await acting("org_a", (org, proof) => listScimTokens(t.db, org, proof))
    expect(rows.map((r) => r.id)).toEqual(["conn_live"])
  })
})
