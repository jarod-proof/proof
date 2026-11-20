import type { createClient } from "@proof/auth/client"

import { catalogPlans } from "./plans"
import { fetchBillingUsage } from "./usage"
import {
  type BillingAdapter,
  type BillingSnapshot,
  type BillingSubscription,
  CHECKOUT_RETURN_PARAM,
} from "./adapter"

type Client = ReturnType<typeof createClient>

export interface StripeBillingOptions {
  /** The page to return to from the provider (defaults to the current address). */
  returnUrl?: () => string
}

const currentPage = () => (typeof window === "undefined" ? "/" : window.location.href)

function unwrap<T>(
  result: { data: T | null; error: { message?: string } | null },
  fallback: string,
): T {
  if (result.error) throw new Error(result.error.message || fallback)
  if (result.data === null) throw new Error(fallback)
  return result.data
}

const dateText = (value: Date | string | null | undefined): string | null => {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date)
}

/** The page to come back to after checkout, marked so the page refreshes the plan on arrival. */
export function checkoutReturnUrl(page: string): string {
  return `${page}${page.includes("?") ? "&" : "?"}${CHECKOUT_RETURN_PARAM}=success`
}

/**
 * The billing adapter over better-auth's stripe client (test mode, server-gated: only chosen when
 * the server reports `stripe: true`). The provider owns the card, the invoices and the
 * cancellation: each change returns a URL, and the page opens it in a new tab.
 *
 * better-auth's stripe client doesn't list invoices or read the card, so those come back null and
 * the page points at the portal for them.
 */
export function createStripeBillingAdapter(
  client: Client,
  options: StripeBillingOptions = {},
): BillingAdapter {
  const subscription = client.subscription
  const here = options.returnUrl ?? currentPage
  return {
    mode: "stripe",
    usage: fetchBillingUsage,
    async load(organizationId) {
      const rows = unwrap(
        await subscription.list({
          query: { referenceId: organizationId, customerType: "organization" },
        }),
        "Could not load the subscription",
      )
      const active = rows.find((row) => row.status === "active" || row.status === "trialing")
      // The plans are the product catalog's (@proof/plans), the ones the API enforces; prices
      // live in Stripe, so none is shown here.
      const snapshot: BillingSnapshot = {
        sample: false,
        plans: catalogPlans(null),
        subscription: null,
        paymentMethod: null,
        invoiceEmail: null,
        invoices: null,
      }
      if (!active) return snapshot
      const current: BillingSubscription = {
        planId: active.plan,
        renewsOn: dateText(active.periodEnd),
        seats: typeof active.seats === "number" ? active.seats : null,
        cancelAtPeriodEnd: active.cancelAtPeriodEnd === true,
      }
      snapshot.subscription = current
      return snapshot
    },
    async openPortal(organizationId) {
      const result = unwrap(
        await subscription.billingPortal({
          referenceId: organizationId,
          customerType: "organization",
          returnUrl: here(),
          disableRedirect: true,
        }),
        "Could not open the billing portal",
      )
      return { url: result.url }
    },
    async changePlan(organizationId, planId) {
      const result = unwrap(
        await subscription.upgrade({
          plan: planId,
          referenceId: organizationId,
          customerType: "organization",
          // Back on this page with ?checkout=success: the page refreshes the plan (refresh below).
          successUrl: checkoutReturnUrl(here()),
          cancelUrl: here(),
          returnUrl: here(),
          disableRedirect: true,
        }),
        "Could not change the plan",
      )
      return { url: result.url }
    },
    // After checkout the webhook may not have arrived yet: resync the plan from Stripe now.
    async refresh(organizationId) {
      unwrap(await client.entitlements.refresh({ organizationId }), "Could not refresh the plan")
    },
    async cancel(organizationId) {
      const result = unwrap(
        await subscription.cancel({
          referenceId: organizationId,
          customerType: "organization",
          returnUrl: here(),
          disableRedirect: true,
        }),
        "Could not cancel the plan",
      )
      return { url: result.url }
    },
  }
}
