import { buttonVariants } from "@proof/ui/components/ui/button"
import { StatusIcon } from "@proof/ui/dplus/status"
import { cn } from "cn"

import { site } from "../../site"

/** The headline, the two CTAs, and a run preview drawn from the design system (no screenshot). */
export function Hero() {
  return (
    <section
      aria-labelledby="hero-h"
      className="mx-auto grid max-w-300 grid-cols-[repeat(auto-fit,minmax(min(480px,100%),1fr))] items-center gap-14 px-6 pt-18 pb-14"
    >
      <div className="flex flex-col gap-5.5">
        <span className="self-start rounded-full border-[1.5px] border-foreground px-3 py-0.5 text-[13px] font-extrabold tracking-[0.05em]">
          AGENTS FOR TEAMS WHO KEEP THE FINAL SAY
        </span>
        <h1 id="hero-h" className="type-hero">
          Hand off the busywork. <span className="highlight px-1">Keep the final say.</span>
        </h1>
        <p className="max-w-135 type-lead text-secondary-foreground">{site.description}</p>
        <div className="flex flex-wrap gap-2.5">
          <a
            href={site.signUpUrl}
            className={cn(buttonVariants({ size: "lg" }), "h-13 text-[17px]")}
          >
            Start free
          </a>
          <a
            href={site.demoUrl}
            className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-13 text-[17px]")}
          >
            Book a demo
          </a>
        </div>
        <p className="text-sm text-muted-foreground">
          Free for 3 seats · no card required · sign in with a passkey
        </p>
      </div>
      <RunPreview />
    </section>
  )
}

/** A static picture of a run: three steps done, one running, an approval waiting. */
function RunPreview() {
  return (
    <figure className="m-0 flex flex-col gap-3.5 rounded-2xl border-2 border-foreground bg-secondary p-5.5 text-[15px]">
      <figcaption className="sr-only">
        Product preview: an agent run with two finished steps, one running, and an approval waiting
        for you
      </figcaption>
      <div aria-hidden="true" className="flex flex-col gap-3.5">
        <div className="flex items-baseline gap-2.5">
          <strong className="text-lg">Release triage</strong>
          <span className="text-[13px] text-muted-foreground">run 482 · step 4 of 6</span>
        </div>
        <div className="flex flex-col border-t">
          <PreviewStep label="Collected 14 release blockers" detail="6s" />
          <PreviewStep label="Drafted 2 fixes" detail="+42 −9" />
          <div className="flex flex-col gap-1.5 border-b py-2">
            <div className="flex items-center gap-3">
              <StatusIcon state="running" />
              <span className="flex-1 font-semibold">Running tests</span>
              <span className="text-[13px]">38 of 61</span>
            </div>
            <div className="ml-7 hatch h-2 overflow-hidden rounded-[3px] border">
              <div className="h-full w-[62%] bg-foreground" />
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-2.5 rounded-xl bg-solar p-3.5 px-4 text-solar-foreground">
          <span className="type-eyebrow">NEEDS YOUR APPROVAL</span>
          <strong className="text-[17px] leading-tight">Post this summary to #releases?</strong>
          <div className="flex gap-2">
            <span className="grid min-h-10 flex-1 place-items-center rounded-lg border-2 border-solar-foreground bg-solar-foreground font-bold text-solar">
              Approve
            </span>
            <span className="grid min-h-10 flex-1 place-items-center rounded-lg border-2 border-solar-foreground font-bold">
              Reject
            </span>
            <span className="grid min-h-10 flex-1 place-items-center rounded-lg border-2 border-solar-foreground font-bold">
              Edit
            </span>
          </div>
        </div>
      </div>
    </figure>
  )
}

function PreviewStep({ label, detail }: { label: string; detail: string }) {
  return (
    <div className="flex items-center gap-3 border-b py-2">
      <StatusIcon state="done" />
      <span className="flex-1">{label}</span>
      <span className="text-[13px] text-muted-foreground">{detail}</span>
    </div>
  )
}
