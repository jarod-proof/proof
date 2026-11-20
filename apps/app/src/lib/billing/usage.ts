import { organizationFetch } from "../org-api"
import { WebError } from "../web-auth"
import { type PlanId, planDisplay, planIds } from "@proof/plans"

import type { BillingEntitlements, BillingUsage } from "./adapter"

interface WhoamiEntitlements {
  plan: string
  limits: Record<string, number | "unlimited">
  degraded: boolean
}

const capOf = (value: number | "unlimited" | undefined) =>
  typeof value === "number" ? value : null

/** whoami's `entitlements` as the billing page shows them. */
function entitlementsOf(raw: WhoamiEntitlements): BillingEntitlements {
  // A plan key this build's catalog doesn't know (a newer server) shows as the key itself.
  const known = (planIds as readonly string[]).includes(raw.plan)
  return {
    planId: raw.plan,
    planName: known ? planDisplay(raw.plan as PlanId).name : raw.plan,
    seatLimit: capOf(raw.limits.seats),
    agentLimit: capOf(raw.limits.agents),
    degraded: raw.degraded,
  }
}

/**
 * Today's metered requests for one organization, from `GET /v1/whoami`. The call names the
 * organization in `X-Organization-Id`, so the server answers for the org the page shows. Both
 * billing adapters use this: the usage counter is the API's own, not the provider's.
 */
export async function fetchBillingUsage(organizationId: string): Promise<BillingUsage> {
  const request = organizationFetch(organizationId)
  const response = await request("/v1/whoami", {
    method: "GET",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  })
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string }
    } | null
    throw new WebError(body?.error?.message ?? "Could not load today's usage", response.status)
  }
  const body = (await response.json()) as {
    usage: BillingUsage
    entitlements?: WhoamiEntitlements
  }
  return {
    day: body.usage.day,
    total: body.usage.total,
    limit: body.usage.limit,
    ...(body.entitlements && { plan: entitlementsOf(body.entitlements) }),
  }
}
