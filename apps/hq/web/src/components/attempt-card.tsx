import type { AttemptView } from "../api/schemas"
import { ClampedText } from "./clamped-text"

type Tone = "text-success" | "text-destructive" | "text-solar" | "text-primary" | "text-faint"

function resultOf(attempt: AttemptView): { label: string; tone: Tone } {
  switch (attempt.result) {
    case "investigated":
      return { label: "Investigated", tone: "text-success" }
    case "approved":
      return { label: "Approved by reviewer", tone: "text-success" }
    case "rejected":
      return { label: "Rejected by reviewer", tone: "text-destructive" }
    case "failed":
      return { label: "Failed", tone: "text-destructive" }
    case "needs_answer":
      return { label: "Waiting for your answer", tone: "text-solar" }
    case "abandoned":
      // Only a lease that ran out is "Stopped reporting"; the other two ended for a reason hq knows.
      if (attempt.endReason === "merged") {
        return { label: "Ended: the pull request was merged", tone: "text-faint" }
      }
      if (attempt.endReason === "stopped") {
        return { label: "Ended: the item was stopped", tone: "text-faint" }
      }
      return { label: "Stopped reporting", tone: "text-solar" }
    case null:
      return attempt.status === "running"
        ? { label: "Running", tone: "text-primary" }
        : { label: "Requested, not started", tone: "text-faint" }
  }
}

const two = (n: number) => String(n).padStart(2, "0")

/** `HH:MM UTC`: hq's times in UTC, so the text never depends on the browser's zone. */
function formatClock(iso: string): string | null {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return `${two(date.getUTCHours())}:${two(date.getUTCMinutes())} UTC`
}

/** `48s`, `2m10s`, `1h05m`. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${two(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h${two(minutes % 60)}m`
}

function formatCost(attempt: AttemptView): string {
  if (attempt.costUsd === null) return "Not reported"
  const figure =
    attempt.costUsd > 0 && attempt.costUsd < 0.01
      ? "less than $0.01"
      : `$${attempt.costUsd.toFixed(2)}`
  return attempt.costEstimated ? `${figure} (estimated)` : figure
}

/** `05:40 UTC · 2m10s · 0 files changed · cost $0.42`, leaving out what the attempt has not got. */
function metaOf(attempt: AttemptView): string {
  const parts: string[] = []
  const clock = attempt.startedAt ? formatClock(attempt.startedAt) : null
  if (clock) parts.push(clock)
  if (attempt.durationMs !== null) parts.push(formatDuration(attempt.durationMs))
  if (attempt.status !== "requested") {
    // hq stores no files until the attempt reports some: for a running one "none yet" is not zero.
    parts.push(
      attempt.status === "running" && attempt.files.length === 0
        ? "no files reported yet"
        : `${attempt.files.length} ${attempt.files.length === 1 ? "file" : "files"} changed`,
    )
    parts.push(`cost ${formatCost(attempt)}`)
  }
  return parts.join(" · ")
}

/**
 * One attempt, as the mock's card: its number, the kind chip, the result in its colour, the meta
 * line and the note. The note is untrusted text: plain, bounded, cut with a "Show all".
 */
export function AttemptCard({ attempt }: { attempt: AttemptView }) {
  const result = resultOf(attempt)
  const meta = metaOf(attempt)
  const titleId = `attempt-${attempt.id}`
  return (
    <article
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-2 overflow-hidden rounded-card border border-border bg-card px-4 py-3.5"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 id={titleId} className="m-0 text-[13px] font-medium">
            Attempt {attempt.number}
          </h3>
          <span className="rounded-md border border-input px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
            {attempt.kind}
          </span>
        </div>
        <span className={`text-xs font-medium ${result.tone}`}>{result.label}</span>
      </div>
      {meta ? <span className="font-mono text-[11px] text-faint wrap-anywhere">{meta}</span> : null}
      {attempt.note ? (
        <ClampedText
          text={attempt.note}
          what="the note"
          className="text-[13px] leading-normal text-soft"
        />
      ) : null}
    </article>
  )
}
