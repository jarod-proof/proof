import { Meter } from "@proof/ui/dplus/meter"
import { StatusIcon } from "@proof/ui/dplus/status"
import type { ReactNode } from "react"

import { site } from "../../site"

/** "Agents you can actually let loose": three answers to the usual doubts. */
export function Benefits() {
  return (
    <section aria-labelledby="why-h" className="mx-auto flex max-w-300 flex-col gap-9 px-6 py-22">
      <div className="flex max-w-180 flex-col gap-2.5">
        <h2 id="why-h" className="type-section">
          Agents you can actually let loose.
        </h2>
        <p className="text-lg text-secondary-foreground">
          The usual worry with AI agents is not knowing what they did. {site.name} is built around
          three answers to that.
        </p>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-4.5">
        <Benefit
          title="You see every step"
          art={
            <>
              <StatusIcon state="done" className="size-5.5" />
              <StatusIcon state="running" className="size-5.5 animate-none" />
              <StatusIcon state="queued" className="size-5.5" />
            </>
          }
        >
          Each run is a readable timeline: what the agent looked at, what it changed, how long it
          took. Steer it mid-run in plain words.
        </Benefit>
        <Benefit
          title="Nothing ships without your yes"
          art={
            <>
              <span className="rounded-md bg-solar-foreground px-2.5 py-0.5 text-[13px] font-bold text-solar">
                Approve
              </span>
              <span className="rounded-md border-2 border-foreground px-2.25 py-px text-[13px] font-bold">
                Reject
              </span>
            </>
          }
        >
          Posting, emailing, merging and spending all stop for approval by default. You decide what
          agents may do on their own.
        </Benefit>
        <Benefit
          title="You know what it costs"
          art={<Meter value={3} max={6} label="3 of 6 budget cells used" />}
        >
          Every run shows tokens, tool calls and estimated energy. Set budgets, and defer heavy work
          to low-carbon hours.
        </Benefit>
      </div>
    </section>
  )
}

function Benefit({ title, art, children }: { title: string; art: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-[14px] border p-6">
      <div aria-hidden="true" className="flex h-8 items-center gap-2.5">
        {art}
      </div>
      <h3 className="text-[21px] font-extrabold tracking-tight">{title}</h3>
      <p className="text-secondary-foreground">{children}</p>
    </div>
  )
}
