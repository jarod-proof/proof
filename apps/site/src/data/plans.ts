import { catalog, planDisplay, planIds, type PlanId } from "@proof/plans"

import { site } from "../site"

/**
 * The plans the pricing page and the home page teaser show. What each plan includes and its copy
 * come from the product's plan catalog (`@proof/plans`), the one the API enforces. Only the
 * site's own parts are here: prices (placeholders: fill them in from your billing setup, STRIPE_PLANS
 * in the API, rather than inventing numbers), the price unit and the call to action.
 */
export interface Plan {
  id: PlanId
  name: string
  blurb: string
  /** What the home page teaser says under the price. */
  summary: string
  price: { monthly: string; annual: string }
  /** After the price: "forever", "/ seat / month". */
  unit: string
  cta: { label: string; href: string }
  featured?: boolean
  items: string[]
}

const marketing: Record<PlanId, Pick<Plan, "cta" | "featured">> = {
  free: { cta: { label: "Start free", href: site.signUpUrl } },
  pro: { cta: { label: "Start [14]-day trial", href: site.signUpUrl }, featured: true },
  team: { cta: { label: "Talk to us", href: `mailto:${site.contactEmail}` } },
}

export const plans: Plan[] = planIds.map((id) => {
  const copy = planDisplay(id)
  return {
    id,
    name: copy.name,
    blurb: copy.blurb,
    summary: copy.summary,
    price: { monthly: "[PRICE]", annual: "[PRICE]" },
    unit: copy.perSeat ? "/ seat / month" : "forever",
    items: [...copy.items],
    ...marketing[id],
  }
})

/** A cell in the comparison table: included, not included, or a value. */
export type Cell = boolean | string

const each = (cell: (id: PlanId) => Cell): Cell[] => planIds.map(cell)
const feature = (key: keyof (typeof catalog.plans)[PlanId]["features"]) =>
  each((id) => catalog.plans[id].features[key])
const count = (value: number | "unlimited", unlimited = "Unlimited") =>
  value === "unlimited" ? unlimited : String(value)

/** Seats: the top plan's cap reads "Up to", Free's is the number itself. */
const seats = (id: PlanId): string => {
  const limit = catalog.plans[id].limits.seats
  if (limit === "unlimited") return "Unlimited"
  return id === catalog.defaultPlan ? String(limit) : `Up to ${limit}`
}

/** API requests per UTC day: "10,000", or "Unlimited". */
const requests = (value: number | "unlimited"): string =>
  value === "unlimited" ? "Unlimited" : value.toLocaleString("en-US")

const days = (value: number | "unlimited"): string => {
  if (value === "unlimited") return "Custom"
  if (value % 365 === 0) return value === 365 ? "1 year" : `${value / 365} years`
  return `${value} days`
}

export const comparison: { group: string; rows: { label: string; cells: Cell[] }[] }[] = [
  {
    group: "AGENTS AND RUNS",
    rows: [
      { label: "Agents", cells: each((id) => count(catalog.plans[id].limits.agents)) },
      {
        label: "API requests / day",
        cells: each((id) => requests(catalog.plans[id].limits.requests)),
      },
      { label: "Run history", cells: each((id) => days(catalog.plans[id].limits.runHistoryDays)) },
      { label: "Approvals and undo", cells: each(() => true) },
      { label: "Budgets and footprint reports", cells: feature("budgets") },
    ],
  },
  {
    group: "COLLABORATION",
    rows: [
      { label: "Seats", cells: each(seats) },
      { label: "Viewer role", cells: each(() => "Free") },
      { label: "Custom roles", cells: feature("customRoles") },
    ],
  },
  {
    group: "SECURITY",
    rows: [
      { label: "Passkeys, two-factor, breach checks", cells: each(() => true) },
      { label: "Org API keys", cells: feature("apiKeys") },
      {
        label: "SAML SSO, audit log export",
        cells: each(
          (id) => catalog.plans[id].features.sso && catalog.plans[id].features.auditExport,
        ),
      },
    ],
  },
  {
    group: "SUPPORT",
    rows: [{ label: "Support", cells: each((id) => planDisplay(id).support) }],
  },
]
