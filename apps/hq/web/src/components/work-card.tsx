import { Link } from "@tanstack/react-router"
import { useId } from "react"

import type { WorkItemSummary } from "../api/schemas"

const TONE_CLASS: Record<WorkItemSummary["card"]["tone"], string> = {
  blue: "text-primary",
  dim: "text-muted-foreground",
  amber: "text-solar",
  teal: "text-success",
  coral: "text-destructive",
}

const SOURCE: Record<WorkItemSummary["source"], { label: string; dot: string }> = {
  github_issue: { label: "GitHub", dot: "bg-primary" },
  ci_failure: { label: "CI", dot: "bg-soft" },
  manual: { label: "Manual", dot: "bg-faint" },
  // Not connected in this phase (hq refuses to record them), named in case a row ever says so.
  sentry: { label: "Sentry", dot: "bg-violet" },
  posthog: { label: "PostHog", dot: "bg-solar" },
}

/** What hq knows about the item beside its summary: the pull request and the fix attempts used. */
function metaOf(item: WorkItemSummary): string | null {
  const parts: string[] = []
  if (item.pullRequest) {
    parts.push(`PR #${item.pullRequest.number}${item.pullRequest.isDraft ? " (draft)" : ""}`)
  }
  if (item.attempts.limit !== null) {
    parts.push(`${item.attempts.used} of ${item.attempts.limit} fix attempts`)
  }
  return parts.length === 0 ? null : parts.join(" · ")
}

/**
 * One item on the board, as the mock's card. The title, the summary and the card text come from
 * outside input or hq's own words and are rendered as text only: React text nodes, no markup, no
 * link made from them. The title is the one link, to the item page (by its display id).
 */
export function WorkCard({ item }: { item: WorkItemSummary }) {
  const id = useId()
  const source = SOURCE[item.source]
  const meta = metaOf(item)
  return (
    <article
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 flex-col gap-2 overflow-hidden rounded-control border border-border bg-card p-3"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-faint">{item.displayId}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${source.dot}`} />
          {source.label}
        </span>
      </div>
      <Link
        id={`${id}-title`}
        to="/work/$itemId"
        params={{ itemId: item.displayId }}
        className="inline-flex min-h-touch min-w-0 items-center text-[13px] leading-snug font-medium text-foreground wrap-anywhere hover:underline"
      >
        <span className="line-clamp-3 min-w-0">{item.title}</span>
      </Link>
      {item.summary ? (
        <p className="m-0 line-clamp-2 text-xs text-faint wrap-anywhere">{item.summary}</p>
      ) : null}
      {meta ? <p className="m-0 font-mono text-[11px] text-faint wrap-anywhere">{meta}</p> : null}
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 border-t border-border pt-2 text-xs">
        <span className={`font-medium ${TONE_CLASS[item.card.tone]}`}>{item.card.label}</span>
        <span className="min-w-0 font-mono text-[11px] text-faint wrap-anywhere">
          {item.card.detail}
        </span>
      </div>
    </article>
  )
}
