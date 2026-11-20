// The flag service's failure paths: evaluation falls back to the code default when the database is
// down (OpenFeature's rule), and counted exposures survive a failed write until the next flush.
import { featureFlag, featureFlagExposureDaily, organization } from "@proof/db"
import { createTestDb } from "@proof/db/testing"
import { setErrorReporter } from "@proof/errors"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createFlagService } from "./flags"

const catalog = {
  "on-by-default": { description: "d", owner: "o", default: true },
  "off-by-default": { description: "d", owner: "o", default: false },
}
const caller = (organizationId: string) => ({
  organizationId,
  actor: { type: "user" as const, userId: "u1" },
  grants: [],
  via: "session",
})

afterEach(() => setErrorReporter(undefined))

describe("createFlagService", () => {
  it("evaluates, caches rollouts until invalidated, and counts exposures by day", async () => {
    const t = await createTestDb()
    const now = new Date("2026-10-19T12:00:00Z")
    await t.db.insert(organization).values({ id: "org-a", name: "A", slug: "a", createdAt: now })
    const flags = createFlagService({ db: t.db, catalog, now: () => now, autoFlush: false })
    try {
      expect(await flags.isEnabled(caller("org-a"), "off-by-default" as never)).toBe(false)
      await t.db.insert(featureFlag).values({
        key: "off-by-default",
        organizationId: "org-a",
        percentage: 100,
        createdAt: now,
        updatedAt: now,
      })
      // Cached: the new rollout shows only after invalidate (a write here) or the TTL.
      expect(await flags.isEnabled(caller("org-a"), "off-by-default" as never)).toBe(false)
      flags.invalidate()
      expect(await flags.isEnabled(caller("org-a"), "off-by-default" as never)).toBe(true)
      expect(await flags.evaluate(caller("org-a"), "not-declared")).toBeNull()

      await flags.scope(async () => {
        await flags.evaluateAll(caller("org-a"))
        expect(flags.seen()).toEqual({ "on-by-default": true, "off-by-default": true })
        flags.failed()
      })
      await flags.flush()
      const rows = await t.db.select().from(featureFlagExposureDaily)
      expect(rows).toEqual(
        expect.arrayContaining([
          { flagKey: "off-by-default", day: "2026-10-19", value: false, count: 2, errors: 0 },
          { flagKey: "off-by-default", day: "2026-10-19", value: true, count: 2, errors: 1 },
          { flagKey: "on-by-default", day: "2026-10-19", value: true, count: 1, errors: 1 },
        ]),
      )
      expect(flags.seen()).toEqual({})
    } finally {
      await flags.close()
      await t.close()
    }
  })

  it("falls back to the code default when the database is down, and keeps counts to retry", async () => {
    const reports: unknown[] = []
    setErrorReporter((e) => void reports.push(e))
    const t = await createTestDb()
    const flags = createFlagService({ db: t.db, catalog, autoFlush: false })
    await t.close()
    expect(await flags.isEnabled(caller("org-a"), "on-by-default" as never)).toBe(true)
    expect(await flags.isEnabled(caller("org-a"), "off-by-default" as never)).toBe(false)
    await expect(flags.evaluateAll(caller("org-a"))).rejects.toBeDefined()
    expect(reports.length).toBeGreaterThan(0)

    // Counts from a run that could not be written are kept, not dropped.
    const up = await createTestDb()
    const recovering = createFlagService({ db: up.db, catalog, autoFlush: false })
    await up.db.insert(organization).values({
      id: "org-a",
      name: "A",
      slug: "a",
      createdAt: new Date(),
    })
    await recovering.evaluateAll(caller("org-a"))
    const write = vi.spyOn(up.db, "insert").mockImplementationOnce(() => {
      throw new Error("connection reset")
    })
    await recovering.flush()
    write.mockRestore()
    await recovering.flush()
    const rows = await up.db.select().from(featureFlagExposureDaily)
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(2)
    await recovering.close()
    await up.close()
  })
})
