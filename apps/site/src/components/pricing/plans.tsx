import { Badge } from "@proof/ui/components/ui/badge"
import { buttonVariants } from "@proof/ui/components/ui/button"
import { cn } from "cn"
import type { ReactNode } from "react"

import { type Plan, plans } from "../../data/plans"
import { site } from "../../site"
import { CheckList } from "../check-list"

/**
 * The Monthly/Annual switch and the plan cards. The switch is a pair of radios: CSS (`:has`) shows
 * the matching price, so it works with no JavaScript. Annual starts selected, as in the design.
 */
export function Plans() {
  return (
    <div className="group/billing">
      <section
        aria-labelledby="pr-h"
        className="mx-auto flex max-w-300 flex-col items-center gap-4.5 px-6 pt-18 pb-10 text-center"
      >
        <h1 id="pr-h" className="max-w-225 type-page-title">
          Pay for people, <span className="highlight px-1">not agents.</span>
        </h1>
        <p className="max-w-155 type-lead text-secondary-foreground">
          Every plan includes unlimited runs within fair use, approvals, and the full run history.
          Viewers are free on every plan.
        </p>
        <fieldset className="mt-1.5 flex overflow-hidden rounded-[10px] border-2 border-foreground">
          <legend className="sr-only">Billing period</legend>
          <PeriodOption value="monthly">Monthly</PeriodOption>
          <PeriodOption value="annual" defaultChecked>
            Annual{" "}
            <Badge variant="solar" size="sm" className="ml-1.5">
              save [XX]%
            </Badge>
          </PeriodOption>
        </fieldset>
      </section>
      <section
        aria-label="Plans"
        className="mx-auto grid max-w-300 grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] items-stretch gap-5 px-6 pt-6 pb-10"
      >
        {plans.map((plan) => (
          <PlanCard key={plan.name} plan={plan} />
        ))}
      </section>
    </div>
  )
}

function PeriodOption({
  value,
  defaultChecked,
  children,
}: {
  value: "monthly" | "annual"
  defaultChecked?: boolean
  children: ReactNode
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center px-5 font-semibold not-first:border-l-2 not-first:border-foreground has-checked:bg-primary has-checked:font-bold has-checked:text-primary-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-inset">
      <input
        type="radio"
        name="billing-period"
        value={value}
        defaultChecked={defaultChecked}
        className="sr-only"
      />
      {children}
    </label>
  )
}

function PlanCard({ plan }: { plan: Plan }) {
  return (
    <div
      className={cn(
        "relative flex flex-col gap-3.5 rounded-2xl border bg-secondary p-7",
        plan.featured && "border-2 border-foreground",
      )}
    >
      {plan.featured && (
        <Badge variant="solar" size="sm" className="absolute -top-2.5 left-6.5">
          MOST TEAMS
        </Badge>
      )}
      <h2 className="text-[22px] font-extrabold">{plan.name}</h2>
      <p className="min-h-12 text-secondary-foreground">{plan.blurb}</p>
      <div className="flex items-baseline gap-2">
        <span className="text-[40px] font-extrabold tracking-[-0.03em]">
          <span className="group-has-[[value=annual]:checked]/billing:hidden">
            {plan.price.monthly}
          </span>
          <span className="hidden group-has-[[value=annual]:checked]/billing:inline">
            {plan.price.annual}
          </span>
        </span>
        <span className="text-[15px] text-muted-foreground">{plan.unit}</span>
      </div>
      <a
        href={plan.cta.href}
        className={cn(
          buttonVariants({ variant: plan.featured ? "default" : "outline", size: "lg" }),
          "h-13",
        )}
      >
        {plan.cta.label}
      </a>
      <CheckList items={plan.items} className="mt-1.5 border-t pt-4 text-[15px]" />
    </div>
  )
}

/** Below the cards: the plan for buyers who need a contract. */
export function Enterprise() {
  return (
    <section aria-label="Enterprise" className="mx-auto max-w-300 px-6 pb-18">
      <div className="flex flex-wrap items-center gap-6 rounded-2xl border-2 border-foreground px-7 py-6">
        <div className="flex min-w-70 flex-1 flex-col gap-1">
          <h2 className="text-[22px] font-extrabold">Enterprise</h2>
          <p className="text-secondary-foreground">
            SAML SSO and SCIM, data residency, private model endpoints, custom terms and a named
            contact.
          </p>
        </div>
        <a
          href={`mailto:${site.contactEmail}`}
          className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-13")}
        >
          Talk to us
        </a>
      </div>
    </section>
  )
}
