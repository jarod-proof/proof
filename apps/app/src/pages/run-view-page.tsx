import { Button } from "@proof/ui/components/ui/button"
import { Status } from "@proof/ui/dplus/status"
import { type RenderLink, anchorLink } from "@proof/ui/dplus/shell/link"

import {
  formatWhen,
  RUN_STATUS_LABEL,
  RUN_STATUS_STATE,
  runMetaCopy,
  currentStep,
} from "../lib/run-view"
import type { Approval, RunDetail } from "../lib/runs-api"
import {
  ApprovalCard,
  Footprint,
  MessageList,
  StepCounter,
  StepTimeline,
  SteerBar,
} from "./run-view-parts"
import { RunSummary } from "./run-summary"

export type RunViewState =
  | { kind: "loading" }
  | { kind: "not-found" }
  | { kind: "error"; message: string }
  | { kind: "ready"; run: RunDetail }

export interface RunViewPageProps {
  organization: { name: string; slug: string }
  state: RunViewState
  /** The caller can decide approvals (run:approve). Viewers read them. */
  canApprove: boolean
  /** The signed-in person's user id (their own decisions read "You approved."). */
  viewerId?: string
  /** The caller can steer and defer (run:steer). */
  canSteer: boolean
  busy: boolean
  /** A steering message or a deferral is in flight: its controls wait for it. */
  sending: boolean
  /** The last action the server refused, if any. */
  actionError: string | null
  onRetry: () => void
  onDecide: (approvalId: string, decision: "approve" | "deny") => void
  onUndo: (approvalId: string) => void
  onWindowPassed: () => void
  onSteer: (body: string) => Promise<void>
  onDefer: (untilIso: string) => Promise<void>
  renderLink?: RenderLink
}

/** The run view (board DirLift): the run's steps, its approvals, its footprint and steering. */
export function RunViewPage(props: RunViewPageProps) {
  const { state, organization, renderLink = anchorLink } = props
  const Link = renderLink

  if (state.kind === "loading") {
    return <output className="block p-6 text-muted-foreground">Loading run…</output>
  }
  if (state.kind === "not-found") {
    // The shell's <main> holds the page, so this is a div: a second main would nest a landmark.
    return (
      <div className="flex max-w-[640px] flex-col gap-3 p-6 md:px-9">
        <h1 className="text-2xl font-bold">Run not found</h1>
        <p className="text-muted-foreground">
          It may not exist, or it belongs to another organization.
        </p>
        <Link href={`/${organization.slug}`} className="underline underline-offset-3">
          Back to {organization.name}
        </Link>
      </div>
    )
  }
  if (state.kind === "error") {
    return (
      <div role="alert" className="flex flex-col gap-3 p-6">
        <p className="text-destructive">Could not load this run. {state.message}</p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 self-start"
          onClick={props.onRetry}
        >
          Try again
        </Button>
      </div>
    )
  }

  const { run } = state
  const finished = run.status === "done" || run.status === "failed"
  const step = currentStep(run.steps)
  const pending = run.approvals.filter((approval) => approval.status === "pending")
  // Pending approvals first, then the decided ones (open to undo, or final).
  const decided = run.approvals.filter((approval) => approval.status !== "pending")
  const shownApprovals: Approval[] = [...pending, ...decided]
  const steerReason = finished
    ? "This run has finished, so it takes no more messages."
    : props.canSteer
      ? null
      : "Viewers can read this run, but can't steer it."

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-5 px-4 py-6 md:px-9 md:py-7">
      <div className="flex items-end gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="flex flex-wrap items-center gap-x-3 text-sm text-muted-foreground">
            <span>
              {organization.name} · {runMetaCopy(run)}
            </span>
            <Status state={RUN_STATUS_STATE[run.status]}>
              {run.status === "queued" && run.deferredUntil
                ? `Queued until ${formatWhen(run.deferredUntil)}`
                : RUN_STATUS_LABEL[run.status]}
            </Status>
          </p>
          <h1 className="font-extrabold leading-tight tracking-tight text-[32px] break-words md:text-[38px]">
            {run.title}
          </h1>
        </div>
        {step ? <StepCounter index={step.index} total={step.total} /> : null}
      </div>

      {props.actionError ? (
        <p role="alert" className="text-sm text-destructive">
          {props.actionError}
        </p>
      ) : null}

      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        <div className="flex min-w-0 flex-[1.15] flex-col gap-4">
          <StepTimeline steps={run.steps} />
          {run.summary ? (
            <section aria-labelledby="run-summary" className="flex flex-col gap-3">
              <h2 id="run-summary" className="text-lg font-bold">
                Summary
              </h2>
              <RunSummary markdown={run.summary} />
            </section>
          ) : null}
        </div>

        {shownApprovals.length > 0 ? (
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            {shownApprovals.map((approval) => (
              <ApprovalCard
                key={approval.id}
                approval={approval}
                canApprove={props.canApprove}
                viewerId={props.viewerId}
                busy={props.busy}
                onDecide={props.onDecide}
                onUndo={props.onUndo}
                onWindowPassed={props.onWindowPassed}
              />
            ))}
          </div>
        ) : null}
      </div>

      <Footprint footprint={run.footprint} energyBudgetWh={run.footprint.energyBudgetWh} />

      <MessageList messages={run.messages} />

      <div className="mt-auto">
        <SteerBar
          disabledReason={steerReason}
          busy={props.busy}
          sending={props.sending}
          deferredUntil={run.status === "queued" ? run.deferredUntil : null}
          onSteer={props.onSteer}
          onDefer={props.onDefer}
        />
      </div>
    </div>
  )
}
