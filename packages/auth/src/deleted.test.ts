// onDeleted: reported once the user or organization row is gone, on every deletion path, and never
// a failure for the deletion itself. The HTTP flows (with the file sweep) are in
// apps/api/src/auth-flows.test.ts.
import { setErrorReporter } from "@proof/errors"
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest"

import { createTestAuth } from "./auth.test.helpers"
import type { DeletedEvent } from "./index"

describe("onDeleted", () => {
  let h: Awaited<ReturnType<typeof createTestAuth>>
  /** Each event, with whether its row still existed when it was reported. */
  const seen: { event: DeletedEvent; rowLeft: boolean }[] = []
  /** "async": the callback's promise rejects. "sync": it throws before returning a promise. */
  let fail: false | "async" | "sync" = false
  const record = async (event: DeletedEvent) => {
    const db = (await h.auth.$context).adapter
    const [model, id] =
      "userId" in event ? ["user", event.userId] : ["organization", event.organizationId]
    const row = await db.findOne({ model, where: [{ field: "id", value: id }] })
    seen.push({ event, rowLeft: row !== null })
    if (fail === "async") throw new Error("sweep failed")
  }
  beforeAll(async () => {
    h = await createTestAuth({
      // Not an async function, so the "sync" case really throws synchronously.
      onDeleted: (event) => {
        if (fail === "sync") {
          seen.push({ event, rowLeft: false })
          throw new Error("sweep failed at once")
        }
        return record(event)
      },
    })
  })
  afterAll(() => h.close())

  const exists = async (model: string, id: string) =>
    (await (
      await h.auth.$context
    ).adapter.findOne({ model, where: [{ field: "id", value: id }] })) !== null

  it("reports a self-deleted person and their personal organization, after both are gone", async () => {
    seen.length = 0
    const user = await h.signUp("Leaving")
    await h.auth.api.deleteUser({ headers: new Headers({ cookie: user.cookie }), body: {} })
    const link = h.outbox.filter((m) => m.to === user.email).at(-1)?.link ?? ""
    expect(link).toContain("/delete-user/callback")
    const res = await h.auth.handler(new Request(link, { headers: { cookie: user.cookie } }))
    expect(res.status).toBeLessThan(400)
    expect(await exists("user", user.userId)).toBe(false)
    expect(seen).toEqual([
      { event: { userId: user.userId }, rowLeft: false },
      { event: { organizationId: user.orgId }, rowLeft: false },
    ])
  })

  it("reports a deleted organization after the plugin has removed it", async () => {
    seen.length = 0
    const user = await h.signUp("Org owner")
    await h.auth.api.deleteOrganization({
      headers: new Headers({ cookie: user.cookie }),
      body: { organizationId: user.orgId },
    })
    expect(seen).toEqual([{ event: { organizationId: user.orgId }, rowLeft: false }])
  })

  it("reports only the person on a delete that skips beforeDelete (admin removal)", async () => {
    seen.length = 0
    const user = await h.signUp("Removed")
    await (await h.auth.$context).internalAdapter.deleteUser(user.userId)
    expect(seen).toEqual([{ event: { userId: user.userId }, rowLeft: false }])
    expect(await exists("organization", user.orgId)).toBe(true)
  })

  it.each(["async", "sync"] as const)(
    "reports a failing (%s) callback and still completes the deletion",
    async (mode) => {
      seen.length = 0
      const reported: unknown[] = []
      setErrorReporter((error, context) => reported.push({ message: error.message, context }))
      fail = mode
      onTestFinished(() => {
        fail = false
        setErrorReporter(undefined)
      })
      const user = await h.signUp("Unlucky")
      await h.auth.api.deleteUser({ headers: new Headers({ cookie: user.cookie }), body: {} })
      const link = h.outbox.filter((m) => m.to === user.email).at(-1)?.link ?? ""
      const res = await h.auth.handler(new Request(link, { headers: { cookie: user.cookie } }))
      expect(res.status).toBeLessThan(400)
      expect(await exists("user", user.userId)).toBe(false)
      // Both sweeps ran: the first one failing doesn't skip the personal organization's.
      expect(seen.map((s) => s.event)).toEqual([
        { userId: user.userId },
        { organizationId: user.orgId },
      ])
      expect(reported).toHaveLength(2)
      expect(reported[0]).toMatchObject({
        context: { phase: "onDeleted", userId: user.userId },
      })
    },
  )
})
