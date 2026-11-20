import { useVirtualizer } from "@tanstack/react-virtual"
import { type CSSProperties, useEffect, useRef } from "react"

import { Button } from "@proof/ui/components/ui/button"
import { Status } from "@proof/ui/dplus/status"
import { anchorLink, type RenderLink } from "@proof/ui/dplus/shell/link"
import { PageBody, PageHeader, PageTabs } from "@proof/ui/dplus/shell/page-header"

import {
  formatCount,
  formatWhen,
  RUN_FILTERS,
  RUN_STATUS_LABEL,
  RUN_STATUS_STATE,
} from "../lib/run-view"
import type { RunStatus, RunSummary } from "../lib/runs-api"

const ROW_HEIGHT = 84

export interface OrgHomePageProps {
  organization: { name: string; slug: string }
  renderLink?: RenderLink
  /** The status filter in the URL: "all" or one run status. Each filter is a tab linking to it. */
  filter: RunStatus | "all"
  /** Show the What's new card above the runs (the `whats-new-card` feature flag). */
  whatsNew?: boolean
  /** Runs that need a person, shown first when no filter is set. */
  needsYou: RunSummary[]
  /** The list, newest first, below the needs-you section. */
  runs: RunSummary[]
  status: "loading" | "error" | "ready"
  errorMessage: string | null
  onRetry: () => void
  hasNextPage: boolean
  loadingMore: boolean
  onLoadMore: () => void
}

/**
 * The organization's home: its runs, with the ones that need a person first. The list is virtualized,
 * and the next page loads as the reader nears its end. Props in, callbacks out.
 */
export function OrgHomePage({
  organization,
  renderLink = anchorLink,
  filter,
  whatsNew = false,
  needsYou,
  runs,
  status,
  errorMessage,
  onRetry,
  hasNextPage,
  loadingMore,
  onLoadMore,
}: OrgHomePageProps) {
  const Link = renderLink
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: runs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 6,
    // The first paint has no layout (and jsdom has none): a fixed rect shows rows until it is measured.
    initialRect: { width: 0, height: 640 },
  })
  const items = virtualizer.getVirtualItems()
  const lastItem = items[items.length - 1]

  useEffect(() => {
    if (hasNextPage && !loadingMore && lastItem && lastItem.index >= runs.length - 8) {
      onLoadMore()
    }
  }, [hasNextPage, loadingMore, lastItem, runs.length, onLoadMore])

  const showNeedsYou = filter === "all" && needsYou.length > 0
  const empty = status === "ready" && runs.length === 0 && !showNeedsYou

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title={organization.name}>
        <PageTabs
          label="Filter runs by status"
          tabs={RUN_FILTERS.map((option) => ({
            id: option.id,
            label: option.label,
            href:
              option.id === "all"
                ? `/${organization.slug}`
                : `/${organization.slug}?status=${option.id}`,
          }))}
          activeTab={filter}
          renderLink={renderLink}
        />
      </PageHeader>
      <PageBody>
        {whatsNew ? <WhatsNewCard /> : null}
        {status === "loading" ? (
          <output className="block text-muted-foreground">Loading runs…</output>
        ) : null}
        {status === "error" ? (
          <div role="alert" className="flex flex-col gap-3">
            <p className="text-destructive">Could not load runs. {errorMessage}</p>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 self-start"
              onClick={onRetry}
            >
              Try again
            </Button>
          </div>
        ) : null}

        {showNeedsYou ? (
          <section aria-labelledby="home-needs-you" className="flex flex-col gap-2">
            <h2 id="home-needs-you" className="text-lg font-bold">
              Needs you
            </h2>
            <ul className="flex flex-col gap-2">
              {needsYou.map((run) => (
                <RunRow key={run.id} run={run} slug={organization.slug} Link={Link} />
              ))}
            </ul>
          </section>
        ) : null}

        {empty ? (
          <p className="text-muted-foreground">
            {filter === "all"
              ? "No runs yet. Runs appear here when an agent starts work."
              : `No ${RUN_STATUS_LABEL[filter].toLowerCase()} runs.`}
          </p>
        ) : null}

        {runs.length > 0 ? (
          <section aria-labelledby="home-runs" className="flex flex-col gap-2">
            <h2 id="home-runs" className="text-lg font-bold">
              {filter === "all" ? "All runs" : RUN_STATUS_LABEL[filter]}
            </h2>
            <div ref={scrollRef} className="max-h-[70vh] overflow-auto" data-testid="run-list">
              <ol
                aria-label="Runs"
                className="relative w-full"
                style={{ height: `${virtualizer.getTotalSize()}px` }}
              >
                {items.map((item) => {
                  const run = runs[item.index]
                  if (!run) return null
                  return (
                    <RunRow
                      key={run.id}
                      run={run}
                      slug={organization.slug}
                      Link={Link}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${item.start}px)`,
                        height: `${item.size}px`,
                      }}
                    />
                  )
                })}
              </ol>
            </div>
            {loadingMore ? (
              <output className="text-sm text-muted-foreground">Loading more runs…</output>
            ) : null}
            {hasNextPage && !loadingMore ? (
              <Button
                type="button"
                variant="outline"
                className="min-h-11 self-start"
                onClick={onLoadMore}
              >
                Load more runs
              </Button>
            ) : null}
          </section>
        ) : null}
      </PageBody>
    </div>
  )
}

/** Release notes in brief, behind the `whats-new-card` flag. Replace the text with your own. */
function WhatsNewCard() {
  return (
    <section
      aria-labelledby="home-whats-new"
      className="flex flex-col gap-1 rounded-lg border-2 border-foreground bg-card p-4"
    >
      <h2 id="home-whats-new" className="text-lg font-bold">
        What's new
      </h2>
      <p className="text-muted-foreground">
        [PLACEHOLDER] One line about your latest release, with a link to its notes.
      </p>
    </section>
  )
}

function RunRow({
  run,
  slug,
  Link,
  style,
}: {
  run: RunSummary
  slug: string
  Link: RenderLink
  style?: CSSProperties
}) {
  return (
    <li style={style} className="flex items-stretch" data-status={run.status}>
      <Link
        href={`/${slug}/runs/${encodeURIComponent(run.id)}`}
        className="flex min-h-11 w-full flex-col justify-center gap-1 rounded-lg border border-border px-4 py-3 hover:bg-muted"
      >
        <span className="flex items-center gap-3">
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{run.title}</span>
          <Status state={RUN_STATUS_STATE[run.status]} className="shrink-0 text-[13px]">
            {run.status === "queued" && run.deferredUntil
              ? `Queued until ${formatWhen(run.deferredUntil)}`
              : RUN_STATUS_LABEL[run.status]}
          </Status>
        </span>
        <span className="text-[13px] text-muted-foreground">
          {formatWhen(run.startedAt ?? run.createdAt)} ·{" "}
          {formatCount(run.footprint.toolCalls, "tool call")}
        </span>
      </Link>
    </li>
  )
}
