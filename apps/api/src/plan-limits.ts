// Plan refusals for the product API: a capacity check (@byo-oss/entitlements checkCapacity) that
// says no becomes a FORBIDDEN naming the plan that would allow it, never a 500. A check that could
// not read the plan (reason "error") is INTERNAL: nothing is created while the plan is unknown.
import { AppError } from "@proof/errors"
import { type PlanId, planDisplay } from "@proof/plans"

/** What the refusal is about, in words: "agents", "seats". */
export interface CapacityRefusal {
  allowed: boolean
  reason: "ok" | "not_in_plan" | "limit_reached" | "error"
  key: string
  limit: number | "unlimited"
  count: number
  plan: string
  upgradeTo: readonly string[]
}

const names = (plans: readonly string[]) =>
  plans.map((plan) => planDisplay(plan as PlanId).name).join(" or ")

/** Throws when a capacity check refused; returns otherwise. */
export function assertCapacity(result: CapacityRefusal, noun: string): void {
  if (result.allowed) return
  if (result.reason === "error") {
    throw new AppError("INTERNAL", `Could not check the plan's ${noun} limit`, {
      context: { key: result.key },
    })
  }
  const plan = planDisplay(result.plan as PlanId).name
  const upgrade =
    result.upgradeTo.length > 0 ? `Upgrade to ${names(result.upgradeTo)} for more ${noun}.` : ""
  // The hint names the upgrade: agents read it, and the web app shows it under the message.
  const message = `The ${plan} plan includes ${String(result.limit)} ${noun}, and this organization has ${result.count}.`
  throw new AppError("FORBIDDEN", message, {
    hint: `${upgrade ? `${upgrade} ` : ""}An owner or admin changes the plan on the Billing page.`,
    context: {
      key: result.key,
      limit: result.limit,
      count: result.count,
      plan: result.plan,
      upgradeTo: [...result.upgradeTo],
    },
  })
}
