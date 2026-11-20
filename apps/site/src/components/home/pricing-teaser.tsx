import { Badge } from "@proof/ui/components/ui/badge"
import { buttonVariants } from "@proof/ui/components/ui/button"
import { cn } from "cn"

import { plans } from "../../data/plans"

/** The three plans in brief, linking to the full pricing page. */
export function PricingTeaser() {
  return (
    <section aria-labelledby="pt-h" className="border-y bg-secondary">
      <div className="mx-auto flex max-w-300 flex-col gap-8 px-6 py-22">
        <div className="flex flex-wrap items-end gap-6">
          <div className="flex min-w-75 flex-1 flex-col gap-2">
            <h2 id="pt-h" className="type-section">
              Simple per-seat pricing.
            </h2>
            <p className="text-lg text-secondary-foreground">
              Start free. Upgrade when your team does.
            </p>
          </div>
          <a href="/pricing" className="font-semibold underline underline-offset-3">
            Compare all plans
          </a>
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(280px,100%),1fr))] gap-4.5">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={cn(
                "relative flex flex-col gap-2.5 rounded-[14px] border bg-background p-6",
                plan.featured && "border-2 border-foreground",
              )}
            >
              {plan.featured && (
                <Badge variant="solar" size="sm" className="absolute -top-2.5 left-5.5">
                  MOST TEAMS
                </Badge>
              )}
              <h3 className="text-xl font-bold">{plan.name}</h3>
              <span className="text-[32px] font-extrabold tracking-[-0.02em]">
                {plan.price.monthly}{" "}
                {plan.unit !== "forever" && (
                  <span className="text-[15px] font-medium tracking-normal text-muted-foreground">
                    {plan.unit}
                  </span>
                )}
              </span>
              <span className="text-secondary-foreground">{plan.summary}</span>
              <a
                href={plan.cta.href}
                className={cn(
                  buttonVariants({ variant: plan.featured ? "default" : "outline", size: "lg" }),
                  "mt-2",
                )}
              >
                {plan.cta.label}
              </a>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
