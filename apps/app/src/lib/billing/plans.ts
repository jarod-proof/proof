// The plans the billing page lists, from the product's plan catalog (@proof/plans): the copy the
// pricing page shows and the limits the API enforces. Both adapters use it; prices are theirs.
import { catalog, planDisplay, planIds } from "@proof/plans"

import type { BillingPlan } from "./adapter"

/** The catalog's plans as the billing page shows them: the same copy as the pricing page. */
export function catalogPlans(price: string | null): BillingPlan[] {
  return planIds.map((id) => {
    const copy = planDisplay(id)
    const seats = catalog.plans[id].limits.seats
    return {
      id,
      name: copy.name,
      price,
      perSeat: copy.perSeat,
      features: [`${copy.summary} · ${copy.support.toLowerCase()} support`],
      seatCap: seats === "unlimited" ? null : seats,
    }
  })
}
