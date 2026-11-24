import { Button } from "@proof/ui/components/ui/button"
import { Input } from "@proof/ui/components/ui/input"
import { Label } from "@proof/ui/components/ui/label"
import { Textarea } from "@proof/ui/components/ui/textarea"
import { type FormEvent, useId, useState } from "react"

import type { HqError } from "../api/errors"
import type { NeedsYou, WorkBoard, WorkItemSummary } from "../api/schemas"
import { BUSY_MESSAGE } from "../lib/use-one-write"
import { KpiCard } from "../components/kpi-card"
import { NeedsYouCard, type NeedsYouActions, needKey } from "../components/needs-you-card"
import { PageHeader } from "../components/page-header"
import { EmptyState, ErrorBlock, LoadingBlock } from "../components/states"
import { WorkCard } from "../components/work-card"

export interface WorkPageProps {
  /** hq's board exactly as it answered: nothing here is counted or derived again. */
  board: WorkBoard
  /** What the search box holds. */
  query: string
  onQuery(query: string): void
  /** The search's answer; null while there is none (nothing typed, or still on its way). */
  results: WorkItemSummary[] | null
  /** Set while the search is typed but has no answer yet. */
  searchLoad?: { status: "loading" } | { status: "error"; error: HqError; onRetry(): void }
  /** hq has more matches than `results` holds. */
  resultsTruncated?: boolean
  onCreate(input: { title: string; body?: string; repo: string }): void
  creating: boolean
  createError: string | null
  /** The display id of the item just created: closes the form. */
  created: string | null
  /** What the last write did, in one line (hq's refusal is on its card instead). */
  notice: string | null
  actions: NeedsYouActions
}

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/
/** hq's limits: a title is 300 characters, a search 200, details 20 000. */
const TITLE_MAX = 300
const SEARCH_MAX = 200
const DETAILS_MAX = 20_000

/** The repos a card's pull request link may name: the item's own, else the board's. */
function reposFor(board: WorkBoard, need: NeedsYou): readonly string[] {
  const listed = board.columns.flatMap((c) => c.items).find((item) => item.id === need.itemId)
  return listed ? [listed.repo] : board.repos
}

function NewItemForm({
  defaultRepo,
  creating,
  blocked,
  error,
  onCreate,
  onCancel,
}: {
  defaultRepo: string
  creating: boolean
  /** Another write is on its way: this one waits (the board sends one at a time). */
  blocked: boolean
  error: string | null
  onCreate: WorkPageProps["onCreate"]
  onCancel(): void
}) {
  const id = useId()
  const [title, setTitle] = useState("")
  const [details, setDetails] = useState("")
  const [repo, setRepo] = useState(defaultRepo)
  const [problem, setProblem] = useState<string | null>(null)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (creating || blocked) return
    const cleanTitle = title.trim()
    const cleanRepo = repo.trim()
    if (cleanTitle === "") return setProblem("Give the item a title.")
    if (!REPO_PATTERN.test(cleanRepo)) {
      return setProblem("The repo must be owner/name, for example acme/web.")
    }
    setProblem(null)
    const body = details.trim()
    onCreate({ title: cleanTitle, ...(body === "" ? {} : { body }), repo: cleanRepo })
  }

  return (
    <form
      aria-label="New work item"
      onSubmit={submit}
      noValidate
      className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-muted p-3.5"
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-title`}>Title</Label>
        <Input
          id={`${id}-title`}
          className="min-h-touch"
          maxLength={TITLE_MAX}
          value={title}
          disabled={creating}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-details`}>Details</Label>
        <Textarea
          id={`${id}-details`}
          className="min-h-touch"
          maxLength={DETAILS_MAX}
          value={details}
          disabled={creating}
          onChange={(event) => setDetails(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-repo`}>Repo</Label>
        <Input
          id={`${id}-repo`}
          className="min-h-touch font-mono"
          value={repo}
          disabled={creating}
          onChange={(event) => setRepo(event.target.value)}
        />
      </div>
      {problem || error ? (
        <p role="alert" className="m-0 text-xs text-destructive wrap-anywhere">
          {problem ?? error}
        </p>
      ) : null}
      {blocked ? (
        <output className="block text-xs text-muted-foreground wrap-anywhere">
          {BUSY_MESSAGE}
        </output>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="min-h-touch px-4" disabled={creating || blocked}>
          Create item
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-touch border-input px-4"
          disabled={creating}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}

function Column({
  column,
  boardEmpty,
}: {
  column: WorkBoard["columns"][number]
  boardEmpty: boolean
}) {
  const id = useId()
  const hidden = column.count - column.items.length
  return (
    <section
      aria-labelledby={id}
      className="flex min-w-0 flex-col gap-2 rounded-card border border-border bg-background p-2.5"
    >
      <div className="flex items-center justify-between gap-2 px-1 pb-1">
        <h3 id={id} className="m-0 text-[13px] font-semibold text-foreground">
          {column.label}
        </h3>
        <span className="font-mono text-[11px] text-muted-foreground">{column.count}</span>
      </div>
      {column.items.length === 0 ? (
        <p className="m-0 px-1 text-xs text-faint">
          {boardEmpty ? "Nothing in the pipeline yet" : "Nothing here"}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {column.items.map((item) => (
            <li key={item.id} className="flex min-w-0 flex-col">
              <WorkCard item={item} />
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 ? (
        <p className="m-0 px-1 font-mono text-[11px] text-faint">{`${hidden} more`}</p>
      ) : null}
    </section>
  )
}

/** The Work board: header, the four stats, what needs a founder, then the five columns. */
export function WorkPage({
  board,
  query,
  onQuery,
  results,
  searchLoad,
  resultsTruncated = false,
  onCreate,
  creating,
  createError,
  created,
  notice,
  actions,
}: WorkPageProps) {
  // The form is open from the click until an item is created (`created` changes).
  const [openedAt, setOpenedAt] = useState<{ created: string | null } | null>(null)
  const formOpen = openedAt !== null && openedAt.created === created
  const searching = query.trim() !== ""
  const { stats } = board
  const boardEmpty = board.columns.every((c) => c.count === 0)

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <PageHeader
        title="Work"
        subtitle={[...board.repos, `${stats.inFlight} in flight`].join(" · ")}
        actions={
          <>
            <Input
              type="search"
              aria-label="Search work items"
              placeholder="Search items, files, errors"
              className="min-h-touch w-full min-w-0 sm:w-56"
              maxLength={SEARCH_MAX}
              value={query}
              onChange={(event) => onQuery(event.target.value)}
            />
            <span
              title="Agents start work only when a founder asks. Policy arrives in Phase 5."
              className="inline-flex min-h-touch items-center gap-2 rounded-control border border-border bg-muted px-3.5 text-sm text-muted-foreground"
            >
              <span aria-hidden="true" className="size-2 rounded-full bg-faint" />
              Autopilot off
            </span>
            <Button
              type="button"
              className="min-h-touch px-4"
              aria-expanded={formOpen}
              onClick={() => setOpenedAt({ created })}
            >
              New item
            </Button>
          </>
        }
      />

      {formOpen ? (
        <NewItemForm
          defaultRepo={board.repos[0] ?? ""}
          creating={creating}
          blocked={actions.pending !== null && !creating}
          error={createError}
          onCreate={onCreate}
          onCancel={() => setOpenedAt(null)}
        />
      ) : null}

      {notice ? (
        <output
          aria-label="Last action"
          className="block rounded-card border border-border bg-card p-3 text-sm text-soft wrap-anywhere"
        >
          {notice}
        </output>
      ) : null}

      <section
        aria-label="Pipeline summary"
        className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] gap-3"
      >
        <KpiCard
          label="In flight"
          value={String(stats.inFlight)}
          note={`${stats.runningAttempts} ${stats.runningAttempts === 1 ? "agent" : "agents"} running now`}
        />
        <KpiCard
          label="Needs you"
          value={String(stats.needsYou)}
          tone="attention"
          note={
            stats.oldestWaitingMinutes === null
              ? "nothing waiting"
              : `oldest waiting ${stats.oldestWaitingMinutes} min`
          }
        />
        <KpiCard
          label="Resolved today"
          value={String(stats.resolvedToday)}
          tone="ok"
          note={`${stats.verifiedToday} verified, ${stats.watching} still watching`}
        />
        <KpiCard
          label="Reopened"
          value={String(stats.reopened)}
          tone="bad"
          note={
            stats.latestReopened
              ? `${stats.latestReopened.displayId}: ${stats.latestReopened.reason}`
              : "none"
          }
        />
      </section>

      <section aria-labelledby="needs-you" className="flex min-w-0 flex-col gap-3">
        <h2
          id="needs-you"
          className="m-0 flex items-center gap-2 text-base font-semibold text-solar"
        >
          Needs you
          {board.needsYou.length > 0 ? (
            <span className="rounded-md bg-solar px-1.5 py-px font-mono text-[11px] font-medium text-primary-foreground">
              {board.needsYou.length}
            </span>
          ) : null}
        </h2>
        {board.needsYou.length === 0 ? (
          <EmptyState
            title="Nothing needs you"
            description="Merge approvals, agent questions and spent attempt budgets show up here."
          />
        ) : (
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-3 p-0">
            {board.needsYou.map((need) => (
              <li key={needKey(need)} className="flex min-w-0 flex-col">
                <NeedsYouCard need={need} actions={actions} repos={reposFor(board, need)} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {searching ? (
        <section aria-labelledby="search-results" className="flex min-w-0 flex-col gap-3">
          <h2 id="search-results" className="m-0 text-base font-semibold text-foreground">
            Search results
          </h2>
          {results === null && searchLoad?.status === "error" ? (
            <ErrorBlock error={searchLoad.error} onRetry={searchLoad.onRetry} />
          ) : null}
          {results === null && searchLoad?.status !== "error" ? (
            <LoadingBlock label="search results" />
          ) : null}
          {results?.length === 0 ? (
            <EmptyState title="No work item matches" description="Try a title, an id or a file." />
          ) : null}
          {results && results.length > 0 ? (
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-3 p-0">
              {results.map((item) => (
                <li key={item.id} className="flex min-w-0 flex-col">
                  <WorkCard item={item} />
                </li>
              ))}
            </ul>
          ) : null}
          {resultsTruncated ? (
            <p className="m-0 text-xs text-faint">More items match: narrow the search.</p>
          ) : null}
        </section>
      ) : (
        <section aria-labelledby="board-columns" className="flex min-w-0 flex-col gap-3">
          <h2 id="board-columns" className="sr-only">
            Board
          </h2>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,210px),1fr))] gap-3">
            {board.columns.map((column) => (
              <Column key={column.key} column={column} boardEmpty={boardEmpty} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
