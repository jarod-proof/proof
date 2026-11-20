import type { Caller } from "@proof/api"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { createTestApp } from "./app.test.helpers"
import { organizationRef } from "./data/organizations"
import { inCallerOrg } from "./tenant"
import { createApiNotifier } from "./notifications"

/** The caller a request from `userId` acting in `organizationId` would have (a session). */
const callerOf = (organizationId: string, userId: string): Caller => ({
  organizationId,
  actor: { type: "user", userId },
  grants: [],
  via: "session",
})

describe("createApiNotifier", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>

  beforeAll(async () => {
    t = await createTestApp()
  })

  afterAll(async () => {
    await t.close()
  })

  const inboxOf = async (cookie: string) =>
    (
      await t.auth.api.listNotifications({
        headers: new Headers({ cookie }),
        query: { filter: "all" },
      })
    ).notifications

  it("an org event lands for the org's eligible members, linked to the org's own slug", async () => {
    const errors: unknown[] = []
    const notifier = createApiNotifier({ auth: t.auth, db: t.db, onError: (e) => errors.push(e) })
    const ref = await organizationRef(t.db, t.owner.orgId)
    expect(ref).not.toBeNull()

    await inCallerOrg(callerOf(t.owner.orgId, t.owner.userId), (org, proof) =>
      notifier.inOrg(org, proof, {
        type: "approval.requested",
        agentName: "Mail agent",
        action: "send an email",
        runId: "run_api",
      }),
    )

    expect(errors).toEqual([])
    const rows = (await inboxOf(t.owner.cookie)).filter((n) => n.type === "approval.requested")
    expect(rows).toEqual([
      expect.objectContaining({
        organizationId: t.owner.orgId,
        href: `/${ref?.slug}/runs/run_api`,
        title: "Approval needed",
      }),
    ])
    // A viewer can't approve, so the event reaches no viewer.
    expect((await inboxOf(t.viewer.cookie)).filter((n) => n.type === "approval.requested")).toEqual(
      [],
    )
  })

  it("an org that no longer exists sends nothing and does not throw", async () => {
    const errors: unknown[] = []
    const notifier = createApiNotifier({ auth: t.auth, db: t.db, onError: (e) => errors.push(e) })
    await expect(
      inCallerOrg(callerOf("org_gone", t.owner.userId), (org, proof) =>
        notifier.inOrg(org, proof, { type: "billing.payment_failed" }),
      ),
    ).resolves.toBeUndefined()
    expect(errors).toEqual([])
  })

  it("a failing org lookup is reported through the same onError and does not throw", async () => {
    const errors: string[] = []
    const broken = createApiNotifier({
      auth: t.auth,
      db: t.db,
      onError: (error, type) =>
        errors.push(`${type}:${error instanceof Error ? error.message : ""}`),
    })
    const lookup = vi.spyOn(t.db, "select").mockImplementationOnce(() => {
      throw new Error("db down")
    })
    await expect(
      inCallerOrg(callerOf(t.owner.orgId, t.owner.userId), (org, proof) =>
        broken.inOrg(org, proof, { type: "billing.payment_failed" }),
      ),
    ).resolves.toBeUndefined()
    lookup.mockRestore()
    expect(errors).toEqual(["billing.payment_failed:db down"])
  })

  it("a personal event for a missing person is reported, and the caller is not failed", async () => {
    const errors: { message: string; type: string }[] = []
    const notifier = createApiNotifier({
      auth: t.auth,
      db: t.db,
      onError: (error, type) =>
        errors.push({ message: error instanceof Error ? error.message : "", type }),
    })
    await expect(
      notifier.personal({ type: "account.password_changed", userId: "user_missing" }),
    ).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
    expect(errors[0]?.type).toBe("account.password_changed")
  })

  it("a personal event reaches the person, with no organization stamp", async () => {
    const notifier = createApiNotifier({ auth: t.auth, db: t.db, onError: () => {} })
    await notifier.personal({ type: "account.two_factor_enabled", userId: t.viewer.userId })
    const rows = (await inboxOf(t.viewer.cookie)).filter(
      (n) => n.type === "account.two_factor_enabled",
    )
    expect(rows).toEqual([
      expect.objectContaining({ userId: t.viewer.userId, organizationId: null }),
    ])
  })
})
