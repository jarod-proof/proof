// The product's plans: what each one includes and how it is described. The one copy of the plan
// promises: the API enforces it (@proof/auth mounts @byo-oss/entitlements with it), the web app's
// billing page shows it, and the marketing site's pricing page is built from it. Prices are not here
// (they live in Stripe; STRIPE_PLANS names the price ids). Browser-safe: it imports only the
// package's `/catalog` entry, which imports nothing.
//
// Never rename a plan key that has subscribers: add a `planAliases` entry from the old key instead.
import { defineEntitlements } from "@byo-oss/entitlements/catalog"

/** How a plan is described (pricing page, billing page). Not read by any check. */
export interface PlanDisplay {
  name: string
  blurb: string
  /** What the home page teaser and the billing page say under the price. */
  summary: string
  /** Charged per seat (Pro, Team) or a flat price (Free). */
  perSeat: boolean
  /** The support tier. Display only: nothing enforces it. */
  support: "Community" | "Email" | "Priority"
  /** The plan card's lines, in order. */
  items: readonly string[]
}

// One display shape for every plan: a plan missing a field, or with an unknown one, fails to compile.
export const catalog = defineEntitlements<PlanDisplay>()({
  features: ["apiKeys", "budgets", "sso", "auditExport", "customRoles"],
  limits: {
    // Product API calls per organization per UTC day (the invoke hooks in apps/api consume it):
    // Free 10 000, Pro 100 000, Team unlimited (consumeUsage never refuses it, and the API sends
    // no ratelimit-* headers for it). Organizations nobody has claimed yet get a lower limit on any
    // plan (resolveEntitlements in @proof/auth).
    requests: { kind: "metered", period: "day" },
    // Members who hold a role other than viewer: viewers are free on every plan.
    seats: { kind: "capacity" },
    // Workspace agents.
    agents: { kind: "capacity" },
    // How far back run history goes. Not enforced yet (runs are never pruned).
    runHistoryDays: { kind: "value" },
  },
  plans: {
    free: {
      features: {
        apiKeys: true,
        budgets: false,
        sso: false,
        auditExport: false,
        customRoles: false,
      },
      limits: { requests: 10_000, seats: 3, agents: 2, runHistoryDays: 30 },
      display: {
        name: "Free",
        blurb: "For trying agents with a small team.",
        summary: "3 seats · 2 agents · API keys",
        perSeat: false,
        support: "Community",
        items: [
          "3 seats, viewers free",
          "2 agents",
          "10,000 API requests a day",
          "Approvals and run history (30 days)",
          "Org API keys",
          "Passkeys and two-factor",
          "Community support",
        ],
      },
    },
    pro: {
      features: {
        apiKeys: true,
        budgets: true,
        sso: false,
        auditExport: false,
        customRoles: false,
      },
      limits: { requests: 100_000, seats: 25, agents: "unlimited", runHistoryDays: 365 },
      display: {
        name: "Pro",
        blurb: "For teams putting agents to daily work.",
        summary: "Up to 25 seats · unlimited agents · budgets",
        perSeat: true,
        support: "Email",
        items: [
          "Up to 25 seats, viewers free",
          "Unlimited agents",
          "100,000 API requests a day",
          "Run history (1 year)",
          "Org API keys",
          "Budgets and footprint reports",
          "Email support",
        ],
      },
    },
    team: {
      features: { apiKeys: true, budgets: true, sso: true, auditExport: true, customRoles: true },
      limits: {
        requests: "unlimited",
        seats: "unlimited",
        agents: "unlimited",
        runHistoryDays: "unlimited",
      },
      display: {
        name: "Team",
        blurb: "For larger teams with security reviews.",
        summary: "SSO · audit log · custom roles",
        perSeat: true,
        support: "Priority",
        items: [
          "Unlimited seats",
          "Everything in Pro",
          "Unlimited API requests",
          "SSO (SAML) and audit log export",
          "Custom roles",
          "Priority support",
        ],
      },
    },
  },
  defaultPlan: "free",
})

export type PlanCatalog = typeof catalog
export type PlanId = keyof PlanCatalog["plans"]
export type PlanFeature = PlanCatalog["features"][number]
export type PlanLimit = keyof PlanCatalog["limits"]

/** The plan ids in catalog order (cheapest first). */
export const planIds = Object.keys(catalog.plans) as PlanId[]

/** A plan's display copy, typed: read from the catalog, each plan's `display` keeps its own type. */
export const planDisplay = (plan: PlanId): PlanDisplay => catalog.plans[plan].display

/** Whether a member's role string ("viewer", "admin,member") takes a seat: viewers are free. */
export const takesSeat = (role: string): boolean =>
  role
    .split(",")
    .map((r) => r.trim())
    .some((r) => r !== "" && r !== "viewer")
