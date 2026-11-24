import { useId } from "react"

import type { PullRequestView, WorkItemDetail } from "../api/schemas"
import { DEPLOY_GRACE_MINUTES } from "../../../src/work/constants"
import { pullRequestLink } from "../lib/pull-request-link"
import { ClampedText } from "./clamped-text"
import { ConfirmInline } from "./confirm-inline"

type Reviewer = WorkItemDetail["attemptList"][number]["reviewer"]

const MINUS = "−"
const sha7 = (sha: string) => sha.slice(0, 7)

const VERDICT: Record<NonNullable<Reviewer>["verdict"], { label: string; tone: string }> = {
  approve: { label: "approved", tone: "text-success" },
  request_changes: { label: "asked for changes", tone: "text-destructive" },
  reject: { label: "rejected", tone: "text-destructive" },
}

const CHECK_TONE: Record<PullRequestView["checks"][number]["state"], string> = {
  passed: "text-success",
  failed: "text-destructive",
  pending: "text-faint",
}

const LINK_CLASS =
  "inline-flex min-h-touch max-w-full items-center rounded-control border-2 border-input px-4 text-sm font-bold text-foreground hover:bg-accent"

/** `+18 −4 · 3 files`, leaving out what hq did not report: a missing number is never 0. */
function sizeOf(pr: PullRequestView): string | null {
  const parts: string[] = []
  if (pr.additions !== null) parts.push(`+${pr.additions}`)
  if (pr.deletions !== null) parts.push(`${MINUS}${pr.deletions}`)
  const lines = parts.join(" ")
  const files = pr.files === null ? null : `${pr.files} ${pr.files === 1 ? "file" : "files"}`
  const all = [lines, files].filter((part) => part !== "" && part !== null)
  return all.length === 0 ? null : all.join(" · ")
}

function MergeLine({
  pr,
  approval,
  canApprove,
  onApproveMerge,
  pending,
  approvedBy,
}: {
  pr: PullRequestView
  approval: WorkItemDetail["mergeApproval"]
  canApprove: boolean
  onApproveMerge(headSha: string): void
  pending: boolean
  approvedBy: string | null
}) {
  // What GitHub says wins over what hq's approval row says: a merged or closed pull request is
  // never a pending decision.
  if (pr.state === "merged") {
    return (
      <p className="m-0 text-xs leading-normal text-soft wrap-anywhere">
        {pr.mergedBy ? `Merged on GitHub by ${pr.mergedBy}` : "Merged on GitHub"}
      </p>
    )
  }
  if (pr.state === "closed") {
    return <p className="m-0 text-xs leading-normal text-soft">Closed without merging</p>
  }
  if (approval?.status === "approved") {
    return approval.headSha === pr.headSha ? (
      <p className="m-0 text-xs leading-normal text-success wrap-anywhere">
        Approved by {approvedBy ?? "a founder"} for{" "}
        <span className="font-mono">{sha7(approval.headSha)}</span>; merge it on GitHub
      </p>
    ) : (
      <p className="m-0 text-xs leading-normal text-solar">
        Approved for <span className="font-mono">{sha7(approval.headSha)}</span>, but the head is
        now <span className="font-mono">{sha7(pr.headSha)}</span>. That approval does not cover it.
      </p>
    )
  }
  if (approval?.status === "pending") {
    if (approval.headSha !== pr.headSha) {
      return (
        <p className="m-0 text-xs leading-normal text-solar">
          Merge approval waits for a founder, but the pull request changed since the approval was
          requested. Reload to see the new head.
        </p>
      )
    }
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <p className="m-0 text-xs leading-normal font-medium text-solar">
          Merge approval waits for a founder
        </p>
        {canApprove ? (
          // A new head is a new question: the key restarts the confirmation.
          <ConfirmInline
            key={approval.headSha}
            label="Approve merge"
            confirmLabel="Confirm"
            pending={pending}
            onConfirm={() => onApproveMerge(approval.headSha)}
          >
            Approve pull request #{pr.number} at head{" "}
            <span className="font-mono">{sha7(approval.headSha)}</span>
            {pr.isDraft ? ", which is a draft" : ""}. Your decision is recorded for this head only.
            It does not merge anything on GitHub.
          </ConfirmInline>
        ) : (
          <p className="m-0 text-xs text-faint">It cannot be approved from here right now.</p>
        )}
      </div>
    )
  }
  return <p className="m-0 text-xs leading-normal text-faint">No merge approval is waiting.</p>
}

/**
 * The pull request of an item, as the mock's PR section with its real words: the size, the branch,
 * the checks GitHub reported, the reviewer's verdict and where the merge stands. The pull request
 * is a link only when its url is exactly the item's repo's page for that number (`pullRequestLink`,
 * which returns the url it built); anything else is text. Approving sends the full head sha of the
 * approval the founder saw, and only while that head is still the pull request's. A deploy is never
 * observed: the panel says the window's 15-minute assumption is one.
 */
export function PullRequestPanel({
  pr,
  mergeApproval,
  canApprove,
  onApproveMerge,
  pending,
  repo,
  reviewer,
  approvedBy = null,
}: {
  pr: PullRequestView
  mergeApproval: WorkItemDetail["mergeApproval"]
  canApprove: boolean
  onApproveMerge(headSha: string): void
  pending: boolean
  repo: string
  /** The newest reviewer verdict of the item's attempts (an addition: no prop of the plan carries it). */
  reviewer: Reviewer
  /** The approving founder's name, when the page knows it (hq records an id, which is not shown). */
  approvedBy?: string | null
}) {
  const headingId = useId()
  const size = sizeOf(pr)
  const link = pullRequestLink(pr.url, pr.number, [repo])
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-2.5 overflow-hidden rounded-card border border-border bg-card px-4 py-3.5"
    >
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id={headingId} className="m-0 flex items-baseline gap-2 text-[13px] font-semibold">
          PR #{pr.number}
          {pr.isDraft ? (
            <span className="font-mono text-[11px] font-normal text-faint">draft</span>
          ) : null}
        </h2>
        <span className="font-mono text-[11px] text-muted-foreground">
          {size ?? "Diff size not reported"}
        </span>
      </div>
      <span className="font-mono text-[11px] text-faint wrap-anywhere">
        {pr.branch} into {pr.base}
      </span>
      {pr.checks.length === 0 ? (
        <p className="m-0 text-xs text-faint">No checks reported</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {pr.checks.map((check, index) => (
            <li
              // A check has no id; hq's list is the order GitHub reported.
              key={`${index}-${check.name}`}
              className="flex min-w-0 items-baseline justify-between gap-3 text-xs text-soft"
            >
              <span className="min-w-0 wrap-anywhere">{check.name}</span>
              <span className={`shrink-0 font-medium ${CHECK_TONE[check.state]}`}>
                {check.state}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex min-w-0 flex-col gap-1 text-xs text-soft">
        {reviewer ? (
          <>
            <p className="m-0">
              <span className="text-faint">Reviewer</span>{" "}
              <span className={`font-medium ${VERDICT[reviewer.verdict].tone}`}>
                {VERDICT[reviewer.verdict].label}
              </span>
              {reviewer.headSha && reviewer.headSha !== pr.headSha ? (
                <span className="text-solar">
                  {" "}
                  (read head {sha7(reviewer.headSha)}, the pull request is at {sha7(pr.headSha)})
                </span>
              ) : null}
            </p>
            <ClampedText
              text={reviewer.summary}
              what="the reviewer's summary"
              className="text-xs leading-normal text-muted-foreground"
            />
          </>
        ) : (
          <p className="m-0">
            <span className="text-faint">Reviewer</span> no verdict recorded
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-2.5">
        <MergeLine
          pr={pr}
          approval={mergeApproval}
          canApprove={canApprove}
          onApproveMerge={onApproveMerge}
          pending={pending}
          approvedBy={approvedBy}
        />
        {link ? (
          <div>
            <a href={link} target="_blank" rel="noreferrer noopener" className={LINK_CLASS}>
              Open pull request #{pr.number} on GitHub
            </a>
          </div>
        ) : (
          <p className="m-0 text-[11px] text-faint wrap-anywhere">
            Pull request address (not a GitHub page of this repo, so not a link): {pr.url}
          </p>
        )}
        <p className="m-0 text-xs leading-normal text-muted-foreground">
          Deploy is assumed {DEPLOY_GRACE_MINUTES} minutes after the merge; no deploy source is
          connected.
        </p>
      </div>
    </section>
  )
}
