// Plan entitlements (@byo-oss/entitlements), mounted in createAuth (index.ts) after organization().
// The plans are the product catalog (@proof/plans): what each plan includes, the one copy the API,
// the web app and the pricing page share. Billing state comes from the stripe plugin when it is
// mounted with plans; without it every organization is on Free (plus staff overrides).
//
// What this file adds to the package's defaults:
//   - authorize: the app's own grant math (memberGrants + allowed), the rule every request uses.
//   - acceptEntitlementsSession: the package's impersonation rule, plus cookie sessions only on the
//     staff (override) endpoints: a request that carries an API key or a bearer token is refused.
//   - resolveEntitlements: an organization nobody has claimed yet (no owner verified their email,
//     provisional signups) gets the lower daily request limit.
//   - seat checks: viewers are free, every other role takes a seat (takesSeat). Checked on invite,
//     add, accept, SCIM provisioning and a role change from viewer to a paid role.
import { allowed, type PermissionSet } from "@proof/api"
import {
  type BillingSource,
  type Entitlements,
  type EntitlementsOptions,
  entitlements,
} from "@byo-oss/entitlements"
import { fromBetterAuthStripe } from "@byo-oss/entitlements/stripe"
import { catalog, type PlanCatalog, planDisplay, takesSeat } from "@proof/plans"
import { APIError } from "better-auth/api"

import { isImpersonated } from "./guards"
import { type Adapter, type Member, memberGrants } from "./membership"

/** The typed server API over this app's catalog (`auth.entitlements`). */
export type PlanEntitlements = Entitlements<PlanCatalog>

/** Entitlements' settings (apps/api/src/server.ts). Everything is optional. */
export interface EntitlementsConfig {
  /**
   * The organization whose members manage overrides: OPERATOR_ORGANIZATION_ID. Unset, nobody can
   * set or list overrides (the package logs one warning at boot).
   */
  staffOrganizationId?: string
  /**
   * Requests per UTC day for an organization nobody has claimed yet (UNCLAIMED_ORG_DAILY_REQUEST_LIMIT).
   * The plan's own limit applies once an owner verifies their email. Default 500.
   */
  unclaimedRequestLimit?: number
  /**
   * Where each organization's plan comes from. Default: the stripe plugin's subscriptions when it is
   * mounted with plans, else none (everyone on Free). Tests pass `memorySource()`.
   */
  source?: BillingSource
}

export const DEFAULT_UNCLAIMED_REQUEST_LIMIT = 500

/** The error code a plan refusal answers in better-auth's own endpoints (invite, add, accept, role). */
export const PLAN_LIMIT_CODE = "PLAN_LIMIT_REACHED"

/** Headers that carry an API key or an OAuth token. Overrides are for a person's cookie session. */
const CREDENTIAL_HEADERS = ["authorization", "x-api-key"] as const

/** The override endpoints (`/entitlements/override/set`, `/remove`, and the `/overrides` list). */
const OVERRIDE_PATH_PREFIX = "/entitlements/override"

/**
 * Which sessions may use entitlements' endpoints. The package's default rule (no impersonated
 * session on a staff call or on any POST), plus: the staff endpoints take a cookie session only. This
 * app has no bearer plugin and API keys make no session, so a key alone already gets 401; this
 * refuses one sent next to a cookie (403 SESSION_NOT_ACCEPTED).
 */
export const acceptEntitlementsSession: NonNullable<EntitlementsOptions["acceptSession"]> = ({
  session,
  headers,
  kind,
  method,
  path,
}) => {
  if (isImpersonated(session) && (kind === "staff" || method === "POST")) return false
  const staffCall = kind === "staff" || path.startsWith(OVERRIDE_PATH_PREFIX)
  if (staffCall && CREDENTIAL_HEADERS.some((name) => headers?.has(name))) return false
  return true
}

/** Whether an owner of the organization has verified their email: the organization is claimed. */
export async function organizationClaimed(db: Adapter, organizationId: string): Promise<boolean> {
  const members = await db.findMany<Member>({
    model: "member",
    where: [{ field: "organizationId", value: organizationId }],
  })
  const owners = members.filter((m) => m.role.split(",").some((r) => r.trim() === "owner"))
  if (owners.length === 0) return false
  const users = await db.findMany<{ emailVerified: boolean | null }>({
    model: "user",
    where: [{ field: "id", value: owners.map((o) => o.userId), operator: "in" }],
  })
  return users.some((u) => u.emailVerified === true)
}

/** The members who take a seat (every role but viewer), and optionally the pending invitations. */
export async function seatsTaken(
  db: Adapter,
  organizationId: string,
  { invitations = false }: { invitations?: boolean } = {},
): Promise<number> {
  const members = await db.findMany<Member>({
    model: "member",
    where: [{ field: "organizationId", value: organizationId }],
  })
  let count = members.filter((m) => takesSeat(m.role)).length
  if (invitations) {
    // An expired invitation keeps status "pending" (better-auth compares expiresAt when it is used),
    // so only the ones still open hold a seat.
    const pending = await db.findMany<{ role: string | null; expiresAt: Date }>({
      model: "invitation",
      where: [
        { field: "organizationId", value: organizationId },
        { field: "status", value: "pending" },
        { field: "expiresAt", value: new Date(), operator: "gt" },
      ],
    })
    count += pending.filter((i) => takesSeat(i.role ?? "member")).length
  }
  return count
}

/** The plan names a refusal points to ("Pro or Team"). */
const planNames = (keys: readonly string[]) =>
  keys.map((key) => planDisplay(key as keyof PlanCatalog["plans"]).name).join(" or ")

/**
 * Refuses adding a seat over the plan's limit: a paid role (anything but viewer) joining, invited or
 * promoted. `count` is the seats taken now; `adding` 0 (a viewer) passes without a check. Throws a
 * better-auth APIError, for the organization plugin's hooks.
 */
export async function assertSeatAvailable(
  gate: PlanEntitlements,
  organizationId: string,
  count: number,
): Promise<void> {
  const result = await gate.checkCapacity(organizationId, "seats", { count, adding: 1 })
  if (result.allowed) return
  if (result.reason === "error") {
    throw APIError.from("INTERNAL_SERVER_ERROR", {
      message: "Could not check the plan's seats. Try again.",
      code: "ENTITLEMENTS_UNAVAILABLE",
    })
  }
  const plan = planDisplay(result.plan).name
  const upgrade = result.upgradeTo.length > 0 ? ` Upgrade to ${planNames(result.upgradeTo)}` : ""
  throw APIError.from("FORBIDDEN", {
    message:
      `The ${plan} plan includes ${String(result.limit)} seats and all of them are taken. ` +
      `Viewers are free: invite as a viewer, or remove a member.${upgrade ? `${upgrade} for more seats.` : ""}`,
    code: PLAN_LIMIT_CODE,
  })
}

/** The plugin for this app. `adapter` reads through the current transaction (index.ts). */
export function entitlementsPlugin({
  config,
  billing,
  adapter,
}: {
  config: EntitlementsConfig
  /** The stripe plugin is mounted with plans (its subscription model and webhook exist). */
  billing: boolean
  adapter: () => Promise<Adapter>
}) {
  const unclaimed = config.unclaimedRequestLimit ?? DEFAULT_UNCLAIMED_REQUEST_LIMIT
  const source: BillingSource | undefined =
    config.source ?? (billing ? fromBetterAuthStripe() : undefined)
  return entitlements({
    catalog,
    ...(source && { source }),
    ...(config.staffOrganizationId && { staffOrganizationId: config.staffOrganizationId }),
    // The app's grant math: a request is allowed when one of the member's roles covers it.
    authorize: async ({ session, organizationId, permissions }) => {
      if (!organizationId) return false
      const grants = await memberGrants(await adapter(), session.user.id, organizationId)
      return grants !== null && allowed(grants, permissions as PermissionSet)
    },
    acceptSession: acceptEntitlementsSession,
    resolveEntitlements: async ({ organizationId, limits }) => {
      if (await organizationClaimed(await adapter(), organizationId)) return {}
      const planLimit = limits.requests
      const requests = planLimit === "unlimited" ? unclaimed : Math.min(planLimit, unclaimed)
      return { limits: { requests } }
    },
    // A metering outage must not stop the API: the request is let through (and logged). Seats and
    // agents fail closed: nothing is created while the plan can't be read.
    onError: (_error, { operation }) => (operation === "consumeUsage" ? "allow" : "deny"),
  })
}

/** Whether a role change takes a new seat: from free (viewer only) to a paid role. */
export const takesNewSeat = (from: string, to: string) => !takesSeat(from) && takesSeat(to)

export { catalog, takesSeat }
