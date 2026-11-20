import { Badge } from "@proof/ui/components/ui/badge"
import type { ReactNode } from "react"

import { CheckList } from "../check-list"

/** The inbox feature: the claim on one side, a drawn inbox on the other. */
export function Inbox() {
  return (
    <section
      aria-labelledby="inbox-h"
      className="mx-auto grid max-w-300 grid-cols-[repeat(auto-fit,minmax(min(440px,100%),1fr))] items-center gap-14 px-6 py-22"
    >
      <div className="flex flex-col gap-3.5">
        <h2 id="inbox-h" className="type-section">
          One inbox for everything that needs you.
        </h2>
        <p className="text-lg text-secondary-foreground">
          Approvals, reviews and mentions in a short list you can actually finish — not another
          feed.
        </p>
        <CheckList
          items={[
            "Act on items in place, without opening the run",
            "Undo any decision for 30 seconds",
            "Keyboard shortcuts for every action",
          ]}
        />
      </div>
      <figure className="m-0 flex flex-col rounded-2xl border-2 border-foreground bg-secondary p-2">
        <figcaption className="sr-only">Inbox preview with three items that need you</figcaption>
        <div aria-hidden="true" className="flex flex-col">
          <div className="flex items-center gap-2.5 px-3 py-2.5">
            <strong className="flex-1">Inbox</strong>
            <Badge variant="solar" size="sm">
              3 need you
            </Badge>
          </div>
          <InboxItem initials="RT" agent actions={["Approve", "Review"]}>
            <strong>Release triage</strong> wants to post the v2.8 summary
          </InboxItem>
          <InboxItem initials="SD" agent actions={["Review", "Snooze"]}>
            <strong>Support drafts</strong> finished 6 replies
          </InboxItem>
          <InboxItem initials="PS">
            <strong>Priya</strong> asked you to sign off on Q4 pricing
          </InboxItem>
        </div>
      </figure>
    </section>
  )
}

/** Agents get a square ink mark, people a round outline, as in the app. */
function InboxItem({
  initials,
  agent = false,
  actions = [],
  children,
}: {
  initials: string
  agent?: boolean
  actions?: string[]
  children: ReactNode
}) {
  return (
    <div className="flex gap-3 border-t p-3">
      <span
        className={
          agent
            ? "grid size-7.5 shrink-0 place-items-center rounded-md bg-foreground text-[11px] font-bold text-background"
            : "grid size-7.5 shrink-0 place-items-center rounded-full border-[1.5px] border-foreground text-[11px] font-bold"
        }
      >
        {initials}
      </span>
      <div className="flex flex-1 flex-col gap-1.5">
        <span className="text-[15px]">{children}</span>
        {actions.length > 0 && (
          <span className="flex gap-1.5">
            {actions.map((action, i) => (
              <span
                key={action}
                className={
                  i === 0
                    ? "rounded-md bg-primary px-2.5 py-0.5 text-[13px] font-bold text-primary-foreground"
                    : "rounded-md border-[1.5px] border-foreground px-2.25 py-px text-[13px] font-bold"
                }
              >
                {action}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  )
}
