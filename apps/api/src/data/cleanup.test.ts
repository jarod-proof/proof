import {
  featureFlagExposureDaily,
  idempotencyKey,
  organization,
  signupAttempt,
  verification,
} from "@proof/db"
import { createTestDb } from "@proof/db/testing"
import { count } from "drizzle-orm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { EXPOSURE_RETENTION_DAYS, pruneExpired, SIGNUP_RETENTION_MS } from "./cleanup"

const NOW = new Date("2026-06-01T12:00:00.000Z")
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000)
const HOUR = 60 * 60 * 1000

describe("pruneExpired", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>
  beforeEach(async () => {
    t = await createTestDb()
    await t.db.insert(organization).values({ id: "org_a", name: "A", slug: "a", createdAt: NOW })
  })
  afterEach(() => t.close())

  const countRows = async (
    table:
      | typeof signupAttempt
      | typeof idempotencyKey
      | typeof verification
      | typeof featureFlagExposureDaily,
  ) => {
    const [row] = await t.db.select({ n: count() }).from(table)
    return row?.n ?? 0
  }

  it("deletes signup attempts older than the retention window and keeps recent ones", async () => {
    const old = new Date(NOW.getTime() - SIGNUP_RETENTION_MS - 1)
    const edge = new Date(NOW.getTime() - SIGNUP_RETENTION_MS + 1)
    await t.db.insert(signupAttempt).values([
      { id: "old", ip: "1.1.1.1", emailDomain: "x.com", createdAt: old },
      { id: "edge", ip: "1.1.1.1", emailDomain: "x.com", createdAt: edge },
      { id: "new", ip: "1.1.1.1", emailDomain: "x.com", createdAt: NOW },
    ])

    const counts = await pruneExpired(t.db, NOW)

    expect(counts.signupAttempts).toBe(1)
    const left = await t.db.select({ id: signupAttempt.id }).from(signupAttempt)
    expect(left.map((r) => r.id).sort()).toEqual(["edge", "new"])
  })

  it("deletes expired idempotency keys and keeps live ones, including an in-progress reservation", async () => {
    const row = (id: string, status: string, expiresAt: Date) => ({
      id,
      organizationId: "org_a",
      key: `k-${id}`,
      operation: "create_project",
      requestHash: "h",
      status,
      response: null,
      createdAt: NOW,
      expiresAt,
    })
    await t.db
      .insert(idempotencyKey)
      .values([
        row("done-expired", "done", minutes(-1)),
        row("lease-expired", "in_progress", minutes(-1)),
        row("done-live", "done", minutes(60 * 24)),
        row("lease-live", "in_progress", minutes(5)),
      ])

    const counts = await pruneExpired(t.db, NOW)

    expect(counts.idempotencyKeys).toBe(2)
    const left = await t.db.select({ id: idempotencyKey.id }).from(idempotencyKey)
    expect(left.map((r) => r.id).sort()).toEqual(["done-live", "lease-live"])
  })

  it("deletes expired device-org approvals and keeps live ones and other verification rows", async () => {
    await t.db.insert(verification).values([
      { id: "v1", identifier: "device-org:dc_old", value: "org_a", expiresAt: minutes(-1) },
      { id: "v2", identifier: "device-org:dc_live", value: "org_a", expiresAt: minutes(10) },
      // Expired, but not a device approval: email verification and password reset rows are not ours.
      { id: "v3", identifier: "reset-password:tok", value: "u1", expiresAt: minutes(-1) },
    ])

    const counts = await pruneExpired(t.db, NOW)

    expect(counts.deviceOrgVerifications).toBe(1)
    const left = await t.db.select({ id: verification.id }).from(verification)
    expect(left.map((r) => r.id).sort()).toEqual(["v2", "v3"])
  })

  it("loops past one batch and reports the full count", async () => {
    await t.db.insert(signupAttempt).values(
      Array.from({ length: 5 }, (_, i) => ({
        id: `s${i}`,
        ip: "1.1.1.1",
        emailDomain: "x.com",
        createdAt: new Date(NOW.getTime() - SIGNUP_RETENTION_MS - HOUR - i),
      })),
    )
    await t.db.insert(idempotencyKey).values(
      Array.from({ length: 4 }, (_, i) => ({
        id: `i${i}`,
        organizationId: "org_a",
        key: `k${i}`,
        operation: "op",
        requestHash: "h",
        status: "done",
        response: null,
        createdAt: NOW,
        expiresAt: minutes(-1 - i),
      })),
    )
    await t.db.insert(verification).values(
      Array.from({ length: 3 }, (_, i) => ({
        id: `d${i}`,
        identifier: `device-org:dc${i}`,
        value: "org_a",
        expiresAt: minutes(-1),
      })),
    )

    // Batch size 2: 5 rows take three statements (2, 2, 1); 4 rows take three (2, 2, 0).
    const counts = await pruneExpired(t.db, NOW, { batchSize: 2 })

    expect(counts).toEqual({
      signupAttempts: 5,
      idempotencyKeys: 4,
      deviceOrgVerifications: 3,
      flagExposureDays: 0,
    })
    expect(await countRows(signupAttempt)).toBe(0)
    expect(await countRows(idempotencyKey)).toBe(0)
    expect(await countRows(verification)).toBe(0)
  })

  it("returns zero counts when nothing has expired", async () => {
    await t.db.insert(verification).values({
      id: "v_live",
      identifier: "device-org:dc_live",
      value: "org_a",
      expiresAt: minutes(10),
    })

    expect(await pruneExpired(t.db, NOW)).toEqual({
      signupAttempts: 0,
      idempotencyKeys: 0,
      deviceOrgVerifications: 0,
      flagExposureDays: 0,
    })
    expect(await countRows(verification)).toBe(1)
  })

  it("deletes flag exposure days past the retention, keeping the recent ones", async () => {
    const day = (days: number) =>
      new Date(NOW.getTime() - days * 86_400_000).toISOString().slice(0, 10)
    await t.db.insert(featureFlagExposureDaily).values([
      { flagKey: "f", day: day(EXPOSURE_RETENTION_DAYS + 1), value: true, count: 1 },
      { flagKey: "f", day: day(EXPOSURE_RETENTION_DAYS - 1), value: true, count: 1 },
    ])
    expect((await pruneExpired(t.db, NOW)).flagExposureDays).toBe(1)
    expect(await countRows(featureFlagExposureDaily)).toBe(1)
  })

  it("rejects a batch size that would never make progress", async () => {
    await expect(pruneExpired(t.db, NOW, { batchSize: 0 })).rejects.toThrow(RangeError)
  })

  it("is idempotent: a second run finds nothing", async () => {
    await t.db.insert(verification).values({
      id: "v1",
      identifier: "device-org:dc1",
      value: "org_a",
      expiresAt: minutes(-1),
    })
    await pruneExpired(t.db, NOW)
    expect(await pruneExpired(t.db, NOW)).toEqual({
      signupAttempts: 0,
      idempotencyKeys: 0,
      deviceOrgVerifications: 0,
      flagExposureDays: 0,
    })
  })
})
