import type { Caller } from "@proof/api"
import {
  type CallerActsFor,
  callerActsFor,
  name,
  type Named,
  OrganizationId,
} from "@proof/auth-proofs"
import { idempotencyKey, organization } from "@proof/db"
import { createTestDb } from "@proof/db/testing"
import { eq } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  completeIdempotencyKey,
  idempotencyLookup,
  releaseIdempotencyKey,
  reserveIdempotencyKey,
} from "./idempotency"

const secret = "a-test-secret-that-is-long-enough-123456" // gitleaks:allow

const caller = (organizationId: string): Caller => ({
  organizationId,
  actor: { type: "user", userId: "user_1" },
  grants: [],
  via: "session",
})

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

describe("idempotency keys", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>
  beforeEach(async () => {
    t = await createTestDb()
    for (const id of ["org_a", "org_b"]) {
      await t.db.insert(organization).values({ id, name: id, slug: id, createdAt: new Date() })
    }
  })
  afterEach(() => t.close())

  const reserve = (
    key: string,
    operation = "create_project",
    requestHash = "hash-1",
    org = "org_a",
  ) =>
    acting(org, (o, proof) =>
      reserveIdempotencyKey(t.db, o, proof, { secret, key, operation, requestHash }),
    )

  it("runs once: a retry while in progress waits, and after completion replays the response", async () => {
    expect(await reserve("k1")).toEqual({ state: "new" })
    // A concurrent retry sees the reservation, so the handler can't run twice.
    expect(await reserve("k1")).toEqual({ state: "in_progress" })

    await acting("org_a", (o, proof) =>
      completeIdempotencyKey(t.db, o, proof, { secret, key: "k1", response: { id: "p1" } }),
    )
    expect(await reserve("k1")).toEqual({ state: "done", response: { id: "p1" } })
  })

  it("refuses a key reused with a different request body or operation", async () => {
    await reserve("k2", "create_project", "hash-1")
    expect(await reserve("k2", "create_project", "hash-2")).toEqual({ state: "mismatch" })
    expect(await reserve("k2", "delete_project", "hash-1")).toEqual({ state: "mismatch" })
  })

  it("lets a retry run again after the failed attempt released its key", async () => {
    await reserve("k3")
    await acting("org_a", (o, proof) =>
      releaseIdempotencyKey(t.db, o, proof, { secret, key: "k3" }),
    )
    expect(await reserve("k3")).toEqual({ state: "new" })
  })

  it("keeps a completed key on release", async () => {
    await reserve("k4")
    await acting("org_a", (o, proof) =>
      completeIdempotencyKey(t.db, o, proof, { secret, key: "k4", response: { ok: true } }),
    )
    await acting("org_a", (o, proof) =>
      releaseIdempotencyKey(t.db, o, proof, { secret, key: "k4" }),
    )
    expect(await reserve("k4")).toEqual({ state: "done", response: { ok: true } })
  })

  it("reclaims an expired key", async () => {
    await reserve("k5", "create_project", "old")
    await t.db
      .update(idempotencyKey)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(idempotencyKey.key, idempotencyLookup(secret, "org_a", "k5")))
    expect(await reserve("k5", "create_project", "new")).toEqual({ state: "new" })
  })

  it("keeps keys per organization", async () => {
    await reserve("k6", "create_project", "hash-1", "org_a")
    expect(await reserve("k6", "create_project", "hash-1", "org_b")).toEqual({ state: "new" })
  })

  it("stores the response sealed, under a lookup only the server secret produces", async () => {
    await reserve("k7")
    await acting("org_a", (o, proof) =>
      completeIdempotencyKey(t.db, o, proof, { secret, key: "k7", response: { key: "sk_x" } }),
    )
    const [row] = await t.db
      .select()
      .from(idempotencyKey)
      .where(eq(idempotencyKey.key, idempotencyLookup(secret, "org_a", "k7")))
    // Sealed: the response is ciphertext, and a different secret can't find or open it.
    expect(JSON.stringify(row?.response)).not.toContain("sk_x")
    expect(idempotencyLookup("another-secret", "org_a", "k7")).not.toBe(row?.key)
  })

  it("holds a reservation for a short lease, and a completed key for 24 hours", async () => {
    const expiresIn = async (key: string) => {
      const [row] = await t.db
        .select()
        .from(idempotencyKey)
        .where(eq(idempotencyKey.key, idempotencyLookup(secret, "org_a", key)))
      return (row?.expiresAt.getTime() ?? 0) - Date.now()
    }
    await reserve("k8")
    // If completing the key fails after the handler ran, a retry isn't refused for a day.
    expect(await expiresIn("k8")).toBeLessThanOrEqual(5 * 60_000)
    await acting("org_a", (o, proof) =>
      completeIdempotencyKey(t.db, o, proof, { secret, key: "k8", response: { ok: true } }),
    )
    expect(await expiresIn("k8")).toBeGreaterThan(23 * 60 * 60_000)
  })
})
