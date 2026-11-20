import { memberGrants, provisionalSignup } from "@proof/auth"
import { AppError } from "@proof/errors"
import { z } from "zod"

import { invitationPreview } from "../data/invitations"
import { actsForOperator } from "../tenant"
import { actorOf, defineOperation, type OperationDeps, requirePerson } from "./shared"

/** POST /v1/signup's body. */
export const signupInput = z.object({
  email: z.email().describe("Address that claims the account; one claim email is sent to it"),
  name: z.string().trim().min(1).max(100).optional().describe("Display name"),
})

/** whoami's `entitlements`: the organization's plan as the API enforces it (@proof/plans). */
const entitlementsOutput = z
  .object({
    plan: z.string().describe("The plan key: free, pro or team"),
    status: z
      .string()
      .nullable()
      .describe("The subscription's status (active, trialing, past_due, ...); null without one"),
    features: z
      .record(z.string(), z.boolean())
      .describe("What the plan includes: apiKeys, budgets, sso, auditExport, customRoles"),
    limits: z
      .record(z.string(), z.union([z.number().int(), z.literal("unlimited")]))
      .describe("requests (per UTC day), seats (viewers are free), agents, runHistoryDays"),
    degraded: z
      .boolean()
      .describe("True when the plan could not be read and this is the Free plan as a fallback"),
  })
  .describe("The organization's plan, features and limits")

export function accountOperations({
  auth,
  db,
  meter,
  now,
  operator,
}: Pick<OperationDeps, "auth" | "db" | "meter" | "now" | "operator">) {
  const whoami = defineOperation({
    name: "whoami",
    method: "GET",
    path: "/v1/whoami",
    summary: "Show the caller, its organization, permissions and usage",
    description:
      "Returns the organization this credential acts for, who is acting (a user or an API key), " +
      "how it authenticated, its permission grants (a request is allowed when one grant covers all " +
      "of it), today's usage against the daily limit, and whether the owner has claimed the " +
      "account (verified the email), whether this is the operator organization, and the " +
      "organization's plan with its features and limits. Call this first to check a credential.",
    permissions: {},
    input: z.object({}),
    output: z.object({
      organizationId: z.string(),
      actor: z.object({ type: z.enum(["user", "apiKey"]), id: z.string() }),
      via: z.string(),
      grants: z.array(z.record(z.string(), z.array(z.string()))),
      usage: z.object({
        day: z.string().describe("The UTC day the counter covers (YYYY-MM-DD)"),
        total: z.number().int().describe("Requests so far today, including this one"),
        limit: z
          .number()
          .int()
          .nullable()
          .describe("Requests allowed per day for this organization; null when unlimited (Team)"),
      }),
      claimed: z.boolean().describe("False while the owner's email is unverified (lower limit)"),
      operator: z
        .boolean()
        .describe("True in the operator organization, which runs the product (feature flags)"),
      entitlements: entitlementsOutput,
    }),
    hints: { readOnly: true, idempotent: true },
    examples: [
      {
        input: {},
        output: {
          organizationId: "org_123",
          actor: { type: "apiKey", id: "key_123" },
          via: "api-key",
          grants: [{ project: ["read", "create"] }],
          usage: { day: "2026-10-15", total: 3, limit: 500 },
          claimed: false,
          operator: false,
          entitlements: {
            plan: "free",
            status: null,
            features: {
              apiKeys: true,
              budgets: false,
              sso: false,
              auditExport: false,
              customRoles: false,
            },
            limits: { requests: 500, seats: 3, agents: 2, runHistoryDays: 30 },
            degraded: false,
          },
        },
      },
    ],
    handler: async (_input, { caller }) => {
      const [status, usage, plan] = await Promise.all([
        meter.status(caller),
        meter.usageToday(caller),
        auth.entitlements.get(caller.organizationId),
      ])
      return {
        organizationId: caller.organizationId,
        actor: actorOf(caller),
        via: caller.via,
        grants: caller.grants.map((g) =>
          Object.fromEntries(Object.entries(g).map(([r, a]) => [r, [...a]])),
        ),
        usage: { day: usage.day, total: usage.total, limit: usage.limit },
        claimed: status.claimed,
        operator: actsForOperator(operator)(caller),
        entitlements: {
          plan: plan.plan.key,
          status: plan.status,
          features: { ...plan.features },
          limits: { ...plan.limits },
          degraded: plan.degraded,
        },
      }
    },
  })

  /** An unclaimed organization always has a finite limit (resolveEntitlements caps every plan). */
  async function newOrganizationLimit(organizationId: string): Promise<number> {
    const limit = await meter.limitOf(organizationId)
    if (limit === null)
      throw new AppError("INTERNAL", "A new organization is unclaimed, so its limit is finite")
    return limit
  }

  const signup = defineOperation({
    name: "signup",
    method: "POST",
    path: "/v1/signup",
    // Public: no credential is read, so the request runs with no caller (see OperationAuth).
    auth: "none",
    summary: "Create an agent account without signing in",
    description:
      "Creates a personal organization, an API key with project permissions, and sends one email " +
      "to the address to claim the account. No credentials are needed; any that are sent are ignored. Use the returned apiKey straight away, as x-api-key or a Bearer " +
      "token. The key is temporary: it stops working when the person claims the account by opening " +
      "the emailed link, since whoever called signup holds it. Tell them that. After the claim, " +
      "calls with it get UNAUTHORIZED; sign in with the device grant (POST /api/auth/device/code, " +
      "which the person approves at /device). Until the claim the organization has a lower daily " +
      "request limit (see limits). Limits: 5 signups per client IP per hour and 20 per email " +
      "domain per day.",
    permissions: {},
    input: signupInput,
    output: z.object({
      organizationId: z.string(),
      apiKey: z.string().describe("Shown once. Stores project read, create, update and delete."),
      claimUrlSentTo: z.string(),
      apiKeyEndsWhenClaimed: z
        .literal(true)
        .describe(
          "apiKey stops working once the person claims the account; then use the device grant",
        ),
      limits: z.object({
        requestsPerDay: z.number().int().describe("Until the email is verified"),
      }),
    }),
    examples: [{ input: { email: "agent@example.com" } }],
    handler: async (input, ctx) => {
      const created = await provisionalSignup(auth, {
        email: input.email,
        name: input.name,
        ip: ctx.public.ip,
      })
      return {
        organizationId: created.organizationId,
        apiKey: created.apiKey,
        claimUrlSentTo: input.email.trim().toLowerCase(),
        apiKeyEndsWhenClaimed: true as const,
        // The new organization's limit now: nobody has claimed it, so the unclaimed one.
        limits: { requestsPerDay: await newOrganizationLimit(created.organizationId) },
      }
    },
  })

  const get_invitation_preview = defineOperation({
    name: "get_invitation_preview",
    method: "GET",
    path: "/v1/invitations/:id/preview",
    // Public: the invitation page shows who invited the person before they have an account.
    auth: "none",
    summary: "Preview an invitation from its link, before signing in",
    description:
      "Returns the organization, role, inviter and state of an invitation, and, while it can " +
      "still be accepted, the invited address. The " +
      "invitation id from the emailed link is the only credential. Accepting still needs a " +
      "signed-in person with the invited address. An unknown id is NOT_FOUND.",
    permissions: {},
    input: z.object({ id: z.string().min(1).max(255).describe("The invitation id from the link") }),
    output: z.object({
      organizationName: z.string(),
      role: z.string().describe("The role the person joins with"),
      status: z.enum(["pending", "accepted", "rejected", "canceled", "expired"]),
      expiresAt: z.string().describe("ISO time the invitation stops working"),
      inviterName: z.string().nullable(),
      email: z.string().nullable().describe("The invited address; null once it is no longer open"),
    }),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: { id: "inv_unknown" }, error: "NOT_FOUND" }],
    handler: async (input) => {
      const preview = await invitationPreview(db, input.id, now())
      if (!preview) {
        throw new AppError("NOT_FOUND", "This invitation could not be found", {
          hint: "Ask the person who invited you to send it again.",
        })
      }
      return { ...preview, expiresAt: preview.expiresAt.toISOString() }
    },
  })

  const get_my_operator_organization = defineOperation({
    name: "get_my_operator_organization",
    method: "GET",
    path: "/v1/me/operator-organization",
    summary: "Find the operator organization, if you belong to it",
    description:
      "Returns the id of the operator organization (the one that runs the product and manages " +
      "feature flags) when the signed-in person is a member of it, whatever organization the " +
      "session is on; null otherwise. The web app uses it for the admin console. Only a person in " +
      "the web app can call it: API keys and AI clients get FORBIDDEN.",
    // About the person, not the organization the session is on: never a key or token.
    auth: "person",
    permissions: {},
    input: z.object({}),
    output: z.object({
      organizationId: z
        .string()
        .nullable()
        .describe("The operator organization's id, or null when you are not a member of it"),
    }),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: {}, output: { organizationId: null } }],
    handler: async (_input, { caller }) => {
      const userId = requirePerson(caller)
      const operatorId = operator.organizationId
      if (operatorId === undefined) return { organizationId: null }
      const grants = await memberGrants((await auth.$context).adapter, userId, operatorId)
      return { organizationId: grants ? operatorId : null }
    },
  })

  return {
    whoami,
    signup,
    get_invitation_preview,
    get_my_operator_organization,
  }
}
