// Test-only: an auth instance on in-process Postgres (PGlite), with helpers for users and orgs.
import { memorySource } from "./testing"
import type { PlanId } from "@proof/plans"
import { createTestDb } from "@proof/db/testing"
import { type AuthOptions, createAuth } from "./index"
import { firstMembership } from "./membership"

export const BASE = "http://localhost:3000"
export const AUDIENCE = `${BASE}/mcp`

/** An auth email as the fake SES client received it: who it's for and its first link to the app. */
export interface SentMail {
  to: string
  link: string
}

export async function createTestAuth(
  options: Pick<
    AuthOptions,
    "stripe" | "onNotificationError" | "rateLimit" | "onSignUp" | "onDeleted"
  > = {},
) {
  const t = await createTestDb()
  // Stands in for SES: records who each auth email is for and the first link in it.
  const outbox: SentMail[] = []
  const ses = {
    send: async (command: { input: unknown }) => {
      const raw = JSON.stringify(command.input)
      const to = (command.input as { Destination?: { ToAddresses?: string[] } }).Destination
      const link = (raw.match(/https?:\/\/[^"\s<>\\]+/g) ?? []).find((l) => l.startsWith(BASE))
      outbox.push({ to: to?.ToAddresses?.[0] ?? "", link: (link ?? "").replaceAll("&amp;", "&") })
      return { MessageId: `test-${outbox.length}`, $metadata: { requestId: "test" } }
    },
  }
  // Every organization is on Free until a test puts it on a plan (`onPlan`).
  const plans = memorySource()
  const auth = createAuth({
    db: t.db,
    secret: "a-test-secret-that-is-long-enough-123456", // gitleaks:allow
    baseURL: BASE,
    emailFrom: "Test <auth@example.com>",
    oauthResources: [BASE, AUDIENCE],
    ses: { client: ses },
    stripe: options.stripe,
    rateLimit: options.rateLimit ?? false,
    onNotificationError: options.onNotificationError,
    onSignUp: options.onSignUp,
    onDeleted: options.onDeleted,
    entitlements: { source: plans },
  })
  let n = 0

  /** Sign up a fresh user. Returns their id, session cookie and personal organization id. */
  async function signUp(name = "User") {
    n++
    const res = await auth.api.signUpEmail({
      body: { email: `user${n}@example.com`, password: "correct-horse-battery", name },
      returnHeaders: true,
    })
    const userId = res.response.user.id
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
    const member = await firstMembership((await auth.$context).adapter, userId)
    if (!member) throw new Error("signup did not create a personal organization")
    return { userId, cookie, orgId: member.organizationId, email: `user${n}@example.com` }
  }

  /** Add a user to an organization with a role ("admin", "member", "admin,member", ...). */
  const addMember = (organizationId: string, userId: string, role: string) =>
    auth.api.addMember({ body: { organizationId, userId, role: role.split(",") as never } })

  /** Make `orgId` the active organization of the session behind `cookie`. */
  const setActive = (cookie: string, organizationId: string) =>
    auth.api.setActiveOrganization({ headers: new Headers({ cookie }), body: { organizationId } })

  /** Put an organization on a plan, as an active subscription would. */
  const onPlan = (organizationId: string, plan: PlanId) =>
    plans.set(organizationId, { planKey: plan, status: "active" })

  return { auth, db: t.db, signUp, addMember, setActive, onPlan, outbox, close: t.close }
}
