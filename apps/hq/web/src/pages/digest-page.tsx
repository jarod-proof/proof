import { Link } from "@tanstack/react-router"
import { Button } from "@proof/ui/components/ui/button"

import type { Digest, FactoryStatus } from "../api/schemas"
import { PageHeader } from "../components/page-header"
import { Section } from "../components/section"
import { EmptyState, NotConnected } from "../components/states"

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const two = (n: number) => String(n).padStart(2, "0")

/** "Nov 16, 00:00 UTC": hq's times in UTC, so the text never depends on the browser's zone. */
function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`
}

const usd = (amount: number) => `$${amount.toFixed(2)}`
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function capLeftPercent(allowance: FactoryStatus["allowance"]): number {
  const total = allowance.capUsd + allowance.grantedUsd
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((allowance.remainingUsd / total) * 100)))
}

const RESULT_CLASS: Record<Digest["events"][number]["result"], string> = {
  started: "text-faint",
  succeeded: "text-success",
  failed: "text-destructive",
  stopped: "text-solar",
  proposed: "text-solar",
  approved: "text-success",
  rejected: "text-muted-foreground",
}

function Banner({ digest }: { digest: Digest }) {
  const { summary, health } = digest
  const quiet = summary.tone === "quiet"
  const parts = [
    `${count(summary.runsFinished, "run", "runs")} finished`,
    `${summary.runsFailed} failed`,
    ...(health.stuckRuns > 0 ? [`${health.stuckRuns} stuck`] : []),
    `${summary.pendingProposals} ${summary.pendingProposals === 1 ? "needs" : "need"} a decision`,
  ]
  return (
    <output
      aria-label="Digest summary"
      className={`block rounded-card border p-3.5 text-sm ${
        quiet
          ? "border-ok-border bg-ok-surface text-foreground"
          : "border-attention-border bg-attention-surface text-solar"
      }`}
    >
      {quiet ? "Quiet" : "Attention"} since {formatTime(digest.since)}. {parts.join(", ")}.
    </output>
  )
}

function EventRow({ event }: { event: Digest["events"][number] }) {
  // A run's cost is the spend recorded for it; while the run is open that is only what is in so
  // far (0 until something is recorded), not a final cost.
  const cost =
    event.kind === "run" && event.costUsd !== null
      ? event.result === "started"
        ? `spend recorded so far ${usd(event.costUsd)}`
        : usd(event.costUsd)
      : null
  return (
    <li className="flex flex-col gap-1 border-t border-border py-2.5 first:border-t-0 sm:flex-row sm:items-baseline sm:gap-4">
      <span className="font-mono text-xs text-faint sm:w-36 sm:shrink-0">
        {formatTime(event.at)}
      </span>
      <span className="min-w-0 flex-1 text-sm text-soft wrap-anywhere">{event.text}</span>
      <span className={`text-xs ${RESULT_CLASS[event.result]}`}>
        {event.result}
        {cost ? <span className="text-faint"> · {cost}</span> : null}
      </span>
    </li>
  )
}

function Fact({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-t border-border py-2.5 first:border-t-0 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="text-sm text-muted-foreground sm:w-48 sm:shrink-0">{name}</dt>
      <dd className="m-0 min-w-0 font-mono text-sm text-soft wrap-anywhere">{value}</dd>
    </div>
  )
}

function spendLine(spend: Digest["spend"]): string {
  const split = spend.bySource.map((s) => `${s.source} ${usd(s.amountUsd)}`).join(", ")
  return (
    `${usd(spend.totalUsd)}${split ? ` (${split})` : ""}` +
    (spend.estimatedUsd > 0 ? `, ${usd(spend.estimatedUsd)} of it estimated` : "")
  )
}

export function DigestPage({
  digest,
  allowance,
  readMarked,
  onMarkRead,
}: {
  digest: Digest
  allowance: FactoryStatus["allowance"] | null
  readMarked: boolean
  onMarkRead(): void
}) {
  const events = [...digest.events].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  return (
    <>
      <PageHeader
        title="Digest"
        subtitle={`since ${formatTime(digest.since)} · ${digest.hours} h`}
        actions={
          <Button
            type="button"
            variant="outline"
            className="min-h-touch"
            disabled={readMarked}
            onClick={onMarkRead}
          >
            {readMarked ? "Marked as read" : "Mark as read"}
          </Button>
        }
      />
      <Banner digest={digest} />

      <Section id="digest-health" title="Product health">
        <div className="grid gap-3 sm:grid-cols-3">
          <NotConnected source="Sentry" what="Errors per hour" />
          <NotConnected source="PostHog" what="Checkout completion" />
          <NotConnected source="PostHog" what="People struggling" />
        </div>
      </Section>

      <Section
        id="digest-decisions"
        title="Needs a decision"
        count={digest.summary.pendingProposals}
        tone={digest.summary.pendingProposals > 0 ? "attention" : "default"}
      >
        {digest.decisions.length === 0 ? (
          <EmptyState title="Nothing needs a decision" />
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {digest.decisions.map((d) => (
              <li
                key={d.proposalId}
                className="flex flex-col gap-3 rounded-card border border-attention-border bg-attention-surface p-3.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="font-mono text-xs text-faint wrap-anywhere">
                    {d.proposalId} · proposal · {d.entryKind}
                  </span>
                  <span className="text-sm font-medium text-foreground wrap-anywhere">
                    {d.title}
                  </span>
                  <span className="text-sm text-muted-foreground wrap-anywhere">
                    Why: {d.reason}
                  </span>
                </div>
                <Link
                  to="/approvals"
                  aria-label={`Decide ${d.title}`}
                  className="inline-flex min-h-touch shrink-0 items-center justify-center rounded-control border border-input px-4 text-sm font-medium text-foreground"
                >
                  Decide
                </Link>
              </li>
            ))}
          </ul>
        )}
        {digest.summary.pendingProposals > 0 ? (
          <Link
            to="/approvals"
            className="inline-flex min-h-touch items-center self-start text-sm text-primary"
          >
            See all {digest.summary.pendingProposals} in Approvals
          </Link>
        ) : null}
      </Section>

      <Section id="digest-did" title="What the factory did">
        {events.length === 0 ? (
          <EmptyState title="Nothing ran in this window" />
        ) : (
          <ul className="m-0 flex list-none flex-col p-0">
            {events.map((event) => (
              <EventRow
                key={`${event.kind}:${event.ref}:${event.at}:${event.result}`}
                event={event}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section id="digest-production" title="What changed in production">
        <NotConnected source="Deploy history" what="Every deploy, by whoever made it" />
      </Section>

      <Section id="digest-factory-health" title="Factory health">
        <dl className="m-0 flex flex-col">
          <Fact name="Runner" value="Not reported" />
          <Fact name="Stuck runs" value={String(digest.health.stuckRuns)} />
          <Fact
            name="Eve spend cap"
            value={allowance ? `${capLeftPercent(allowance)}% left` : "Unavailable"}
          />
          <Fact name="Last heartbeat" value="Not reported" />
          <Fact
            name="Last run started"
            value={
              digest.health.lastRunStartedAt
                ? formatTime(digest.health.lastRunStartedAt)
                : "No runs yet"
            }
          />
          <Fact name="Spend in this window" value={spendLine(digest.spend)} />
        </dl>
        <p className="m-0 text-xs text-faint">
          Box runs report no end, so they are never counted as finished, failed or stuck.
        </p>
      </Section>
    </>
  )
}
