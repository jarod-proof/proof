import { Button } from "@proof/ui/components/ui/button"
import type { ReactNode } from "react"

import type { HqError } from "../api/errors"
import type { Proposal } from "../api/schemas"
import { PageHeader } from "../components/page-header"
import { EmptyState, ErrorBlock, LoadingBlock } from "../components/states"

/** Where a list is: waiting, failed (with a way to ask again) or here. */
export type Load<T> =
  | { status: "loading" }
  | { status: "error"; error: HqError; onRetry(): void }
  | { status: "ready"; items: T }

/**
 * What a decision left behind for the founder to read: hq's refusal ("error") or the confirmation
 * of a decision made ("done"). It names the proposal because its card may be gone by then.
 */
export interface Notice {
  title: string
  message: string
  tone: "error" | "done"
}

export interface ApprovalsPageProps {
  pending: Load<Proposal[]>
  /**
   * The newest decisions among the most recently created proposals, newest decision first. hq can
   * only order `list_proposals` by creation, so a proposal created long ago and decided just now
   * can be missing: that is why a decision's notice never depends on a row being here.
   */
  decided: Load<Proposal[]>
  /** One pending proposal's card (the container wires its decision to hq). */
  renderPending(proposal: Proposal): ReactNode
  /** By proposal id. Beside its decided row when there is one, else at the top of Needs you. */
  notices: Record<string, Notice>
  onDismissNotice(proposalId: string): void
  hasMore: boolean
  loadingMore: boolean
  onLoadMore(): void
}

/** `2026-11-17 12:30 UTC`: a fixed zone, so the screen reads the same everywhere. */
function when(iso: string | null): string | null {
  return iso === null ? null : `${iso.slice(0, 16).replace("T", " ")} UTC`
}

function DecidedRow({ proposal, notice }: { proposal: Proposal; notice: Notice | undefined }) {
  const approved = proposal.status === "approved"
  const at = when(proposal.decidedAt)
  return (
    <li className="flex min-w-0 flex-col gap-1 rounded-control border border-border bg-muted p-3">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={`text-xs font-semibold ${approved ? "text-success" : "text-muted-foreground"}`}
        >
          {approved ? "Approved" : "Rejected"}
        </span>
        <span className="min-w-0 flex-1 text-sm wrap-anywhere text-foreground">
          {proposal.title}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 font-mono text-[11px] text-faint">
        <span>
          {proposal.id.slice(0, 8)} · {proposal.kind}
        </span>
        {at ? <time dateTime={proposal.decidedAt ?? undefined}>{at}</time> : null}
        {approved && proposal.entryId ? (
          <a
            href={`/admin/entries/${encodeURIComponent(proposal.entryId)}`}
            className="inline-flex min-h-touch items-center text-primary underline underline-offset-2"
          >
            History
          </a>
        ) : null}
      </div>
      {notice?.tone === "error" ? (
        <p role="alert" className="m-0 text-xs wrap-anywhere text-destructive">
          {notice.message}
        </p>
      ) : null}
    </li>
  )
}

/** The Approvals screen: what needs a founder, then what was decided lately. */
export function ApprovalsPage({
  pending,
  decided,
  renderPending,
  notices,
  onDismissNotice,
  hasMore,
  loadingMore,
  onLoadMore,
}: ApprovalsPageProps) {
  // A notice whose proposal has a card or a decided row is shown there; any other would vanish
  // with its card, so it is shown here until dismissed.
  const placed = new Set([
    ...(pending.status === "ready" ? pending.items : []).map((p) => p.id),
    ...(decided.status === "ready" ? decided.items : []).map((p) => p.id),
  ])
  const orphans = Object.entries(notices).filter(([id]) => !placed.has(id))

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader title="Approvals" subtitle="Proposals from agents, waiting for a founder" />

      <section aria-labelledby="needs-you" className="flex min-w-0 flex-col gap-3">
        <h2
          id="needs-you"
          className="m-0 flex items-center gap-2 text-base font-semibold text-solar"
        >
          Needs you
          {pending.status === "ready" && pending.items.length > 0 ? (
            <span className="rounded-md bg-solar px-1.5 py-px font-mono text-[11px] font-medium text-primary-foreground">
              {pending.items.length}
              {hasMore ? "+" : ""}
            </span>
          ) : null}
        </h2>
        {orphans.map(([id, notice]) => (
          <div
            key={id}
            role={notice.tone === "error" ? "alert" : "status"}
            className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-card border border-border bg-card p-3"
          >
            <p
              className={`m-0 min-w-0 flex-1 text-sm wrap-anywhere ${
                notice.tone === "error" ? "text-destructive" : "text-soft"
              }`}
            >
              {notice.title}: {notice.message}
            </p>
            <Button
              type="button"
              variant="outline"
              className="min-h-touch border-input"
              onClick={() => onDismissNotice(id)}
            >
              Dismiss
            </Button>
          </div>
        ))}
        {pending.status === "loading" ? <LoadingBlock label="proposals" /> : null}
        {pending.status === "error" ? (
          <ErrorBlock error={pending.error} onRetry={pending.onRetry} />
        ) : null}
        {pending.status === "ready" && pending.items.length === 0 ? (
          <EmptyState
            title="Nothing needs you"
            description="New proposals from agents show up here for a decision."
          />
        ) : null}
        {pending.status === "ready" && pending.items.length > 0 ? (
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))] gap-3 p-0">
            {pending.items.map((proposal) => (
              <li key={proposal.id} className="flex min-w-0 flex-col">
                {renderPending(proposal)}
              </li>
            ))}
          </ul>
        ) : null}
        {hasMore ? (
          <Button
            type="button"
            variant="outline"
            className="min-h-touch self-start border-input"
            disabled={loadingMore}
            onClick={onLoadMore}
          >
            Load more
          </Button>
        ) : null}
      </section>

      <section aria-labelledby="recently-decided" className="flex min-w-0 flex-col gap-3">
        <h2 id="recently-decided" className="m-0 text-base font-semibold text-foreground">
          Recently decided
        </h2>
        {decided.status === "loading" ? <LoadingBlock label="decided proposals" /> : null}
        {decided.status === "error" ? (
          <ErrorBlock error={decided.error} onRetry={decided.onRetry} />
        ) : null}
        {decided.status === "ready" && decided.items.length === 0 ? (
          <EmptyState title="Nothing decided yet" />
        ) : null}
        {decided.status === "ready" && decided.items.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {decided.items.map((proposal) => (
              <DecidedRow key={proposal.id} proposal={proposal} notice={notices[proposal.id]} />
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  )
}
