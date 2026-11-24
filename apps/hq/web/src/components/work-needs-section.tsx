import type { NeedsYou, WorkBoard } from "../api/schemas"
import type { Load } from "../pages/approvals-page"
import { NeedsYouCard, type NeedsYouActions, needKey } from "./needs-you-card"
import { EmptyState, ErrorBlock, LoadingBlock } from "./states"

/** The repos a card's pull request link may name: the item's own, else the board's. */
function reposFor(board: WorkBoard, need: NeedsYou): readonly string[] {
  const listed = board.columns.flatMap((c) => c.items).find((item) => item.id === need.itemId)
  return listed ? [listed.repo] : board.repos
}

/**
 * What the pipeline waits on a founder for, on Approvals: every needs-you kind hq lists (merge
 * approval, agent question, attempt budget, stuck attempt), so its count is the badge's
 * contribution. The cards are the Work board's own (`NeedsYouCard`, so the same buttons, the same
 * confirmation and the same plain-text rendering of outside text). The section has its own loading
 * and error states: a failed board read leaves the proposals above it alone.
 */
export function WorkNeedsSection({
  load,
  actions,
  notice,
}: {
  load: Load<WorkBoard>
  actions: NeedsYouActions
  /** The line the last successful write returned (what was and was not done). */
  notice: string | null
}) {
  const needs = load.status === "ready" ? load.items.needsYou : []
  return (
    <section aria-labelledby="work-needs" className="flex min-w-0 flex-col gap-3">
      <h2
        id="work-needs"
        className="m-0 flex items-center gap-2 text-base font-semibold text-solar"
      >
        From the pipeline
        {needs.length > 0 ? (
          <span className="rounded-md bg-solar px-1.5 py-px font-mono text-[11px] font-medium text-primary-foreground">
            {needs.length}
          </span>
        ) : null}
      </h2>
      {notice ? (
        <output
          aria-label="Last action"
          className="block rounded-card border border-border bg-card p-3 text-sm text-soft wrap-anywhere"
        >
          {notice}
        </output>
      ) : null}
      {load.status === "loading" ? <LoadingBlock label="the pipeline" /> : null}
      {load.status === "error" ? <ErrorBlock error={load.error} onRetry={load.onRetry} /> : null}
      {load.status === "ready" && needs.length === 0 ? (
        <EmptyState
          title="Nothing from the pipeline needs you"
          description="Merge approvals, agent questions and spent attempt budgets show up here."
        />
      ) : null}
      {load.status === "ready" && needs.length > 0 ? (
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-3 p-0">
          {needs.map((need) => (
            <li key={needKey(need)} className="flex min-w-0 flex-col">
              <NeedsYouCard need={need} actions={actions} repos={reposFor(load.items, need)} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
