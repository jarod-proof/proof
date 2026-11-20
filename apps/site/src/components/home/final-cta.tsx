import { buttonVariants } from "@proof/ui/components/ui/button"
import { cn } from "cn"

import { site } from "../../site"

/** The closing band, in inverse ink. */
export function FinalCta() {
  return (
    <section aria-labelledby="cta-h" className="bg-primary text-primary-foreground">
      <div className="mx-auto flex max-w-300 flex-wrap items-center gap-8 px-6 py-22">
        <div className="flex min-w-75 flex-1 flex-col gap-2.5">
          <h2
            id="cta-h"
            className="text-[clamp(32px,4vw,52px)] leading-[1.05] font-extrabold tracking-[-0.035em] text-balance"
          >
            Give your team its{" "}
            <span className="bg-[linear-gradient(transparent_86%,var(--solar)_86%)] px-1">
              afternoons back.
            </span>
          </h2>
          <p className="text-lg opacity-85">Free for 3 seats. No card. Cancel in two clicks.</p>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <a
            href={site.signUpUrl}
            className={cn(
              buttonVariants({ size: "lg" }),
              "h-14 border-solar bg-solar px-7 text-lg font-extrabold text-solar-foreground hover:bg-solar/85",
            )}
          >
            Start free
          </a>
          <a
            href={site.demoUrl}
            className={cn(
              buttonVariants({ variant: "outline", size: "lg" }),
              "h-14 border-primary-foreground px-7 text-lg text-primary-foreground hover:bg-primary-foreground/10",
            )}
          >
            Book a demo
          </a>
        </div>
      </div>
    </section>
  )
}
