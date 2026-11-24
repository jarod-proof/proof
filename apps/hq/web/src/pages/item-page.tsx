import { Button } from "@proof/ui/components/ui/button"
import { Label } from "@proof/ui/components/ui/label"
import { Textarea } from "@proof/ui/components/ui/textarea"
import { Link } from "@tanstack/react-router"
import { type ReactNode, useId, useState } from "react"

import type { AttemptKind, WorkItemDetail } from "../api/schemas"
import { AttemptCard } from "../components/attempt-card"
import { ClampedText } from "../components/clamped-text"
import { ConfirmInline } from "../components/confirm-inline"
import { ContractList } from "../components/contract-list"
import { PullRequestPanel } from "../components/pull-request-panel"
import { QuestionCard } from "../components/question-card"
import { Section } from "../components/section"
import { StageStrip } from "../components/stage-strip"
import { Transcript, type TranscriptState } from "../components/transcript"
import { VerificationChart } from "../components/verification-chart"
import { NOTE_MAX_CHARS } from "../../../src/work/constants"
import { signalLink } from "../lib/signal-link"

/** What the page can ask for. Each is one write; the container sends it once and never retries. */
export interface ItemActions {
  onStop(note?: string): void
  onReopen(note?: string): void
  onRevert(note?: string): void
  onRetry(note: string): void
  onRequestAttempt(kind: AttemptKind, instructions?: string): void
  onAnswer(questionId: string, optionId: string): void
  /** `headSha` is the full sha of the approval the founder saw. */
  onApproveMerge(headSha: string): void
  /** The key of the write on its way, or null: while it is not null nothing here can be clicked. */
  pending: string | null
  /** hq's refusal of the last write, in hq's words. */
  error: string | null
  /** What the last write did, in one line. */
  notice: string | null
}

export interface ItemPageProps {
  item: WorkItemDetail
  transcript: TranscriptState
  actions: ItemActions
  /** How attempts start; `loading` while the board that says so is on its way, null when it could not be read. */
  dispatch: "label" | "claim" | "loading" | null
  /** The issue page of the item's signal, built from a url hq checked; null when there is none. */
  issueUrl: string | null
  /** The approving founder's name when the container knows it (hq stores an id, never shown). */
  approvedBy?: string | null
}

const REPORTED_NEVER = "time not reported"

const SOURCE_LABEL: Record<WorkItemDetail["source"], string> = {
  github_issue: "GitHub",
  ci_failure: "CI",
  manual: "Manual",
  sentry: "Sentry",
  posthog: "PostHog",
}
const TONE_CLASS: Record<WorkItemDetail["card"]["tone"], string> = {
  blue: "text-primary",
  dim: "text-muted-foreground",
  amber: "text-solar",
  teal: "text-success",
  coral: "text-destructive",
}
const NOTE_KIND: Record<WorkItemDetail["founderNotes"][number]["kind"], string> = {
  retry: "Retry",
  answer: "Answer",
  revert: "Revert",
  request: "Request",
}
const WINDOW_LABEL = {
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  stopped: "Stopped",
} as const
const LINK_CLASS =
  "inline-flex min-h-touch max-w-full items-center rounded-control border-2 border-input px-4 text-sm font-bold text-foreground hover:bg-accent"
const MUTED = "m-0 text-xs leading-normal text-faint"

const two = (n: number) => String(n).padStart(2, "0")

/** `2026-11-17 12:00 UTC`: hq's times in UTC, so the page never depends on the browser's zone. */
function utc(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return REPORTED_NEVER
  return `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())} UTC`
}

/** `2h14m`, `45m`. */
function left(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h${two(minutes % 60)}m` : `${minutes}m`
}

/** Whole hours when it is a whole number, else one decimal. */
function hoursOf(startsAt: string, endsAt: string): string | null {
  const hours = (new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 3_600_000
  if (!Number.isFinite(hours) || hours <= 0) return null
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1)
}

/** The reviewer's verdict on the newest attempt of this cycle that has one (a number decides, not a position). */
function newestReviewer(item: WorkItemDetail) {
  const verdicts = item.attemptList
    .filter((attempt) => attempt.cycle === item.cycle && attempt.reviewer !== null)
    .sort((a, b) => b.number - a.number)
  return verdicts[0]?.reviewer ?? null
}

/** A decision with an optional note: the note stays typed while the question is closed and reopened. */
function NoteConfirm({
  label,
  confirmLabel,
  pending,
  describedBy,
  onConfirm,
  children,
}: {
  label: string
  confirmLabel: string
  pending: boolean
  describedBy: string
  onConfirm(note?: string): void
  children: ReactNode
}) {
  const id = useId()
  const [note, setNote] = useState("")
  return (
    <ConfirmInline
      label={label}
      confirmLabel={confirmLabel}
      pending={pending}
      describedBy={describedBy}
      onConfirm={() => {
        const text = note.trim()
        onConfirm(text === "" ? undefined : text)
      }}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <p className="m-0">{children}</p>
        <Label htmlFor={`${id}-note`}>Note (optional)</Label>
        <Textarea
          id={`${id}-note`}
          className="min-h-touch"
          maxLength={NOTE_MAX_CHARS}
          value={note}
          disabled={pending}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
    </ConfirmInline>
  )
}

function Decisions({
  item,
  actions,
  titleId,
}: {
  item: WorkItemDetail
  actions: ItemActions
  titleId: string
}) {
  const locked = actions.pending !== null
  const stopHint = useId()
  const reopenHint = useId()
  const stopLabel = item.state === "verify" ? "Stop watching" : "Stop item"
  const { canStop, canReopen, canRevert } = item.actions
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        {canRevert ? (
          <NoteConfirm
            label="Revert merge"
            confirmLabel="Request revert"
            pending={locked}
            describedBy={titleId}
            onConfirm={actions.onRevert}
          >
            Nothing is reverted automatically. This records a revert request and reopens the item;
            the revert itself is a normal fix attempt, and hq changes nothing on GitHub.
          </NoteConfirm>
        ) : null}
        {canStop ? (
          <NoteConfirm
            label={stopLabel}
            confirmLabel={stopLabel}
            pending={locked}
            describedBy={titleId}
            onConfirm={actions.onStop}
          >
            This stops the item in hq. A build already running on GitHub finishes on its own and its
            pull request is recorded on the stopped item.
          </NoteConfirm>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="min-h-touch max-w-full border-input px-4"
            disabled
            aria-describedby={stopHint}
          >
            {stopLabel}
          </Button>
        )}
        {canReopen ? (
          <NoteConfirm
            label="Reopen item"
            confirmLabel="Reopen"
            pending={locked}
            describedBy={titleId}
            onConfirm={actions.onReopen}
          >
            This reopens the item in hq. It starts no agent work by itself.
          </NoteConfirm>
        ) : (
          <Button
            type="button"
            variant="outline"
            className="min-h-touch max-w-full border-input px-4"
            disabled
            aria-describedby={reopenHint}
          >
            Reopen item
          </Button>
        )}
      </div>
      {canStop ? null : (
        <p id={stopHint} className="m-0 text-[11px] text-faint">
          A founder can stop an item in triage, plan, attempt, review, deploy or verify; not from
          this state.
        </p>
      )}
      {canReopen ? null : (
        <p id={reopenHint} className="m-0 text-[11px] text-faint">
          Only a verifying, done or stopped item can be reopened.
        </p>
      )}
    </div>
  )
}

function RetryControl({ item, actions }: { item: WorkItemDetail; actions: ItemActions }) {
  const noteId = useId()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState("")
  const locked = actions.pending !== null
  const { used, limit } = item.attempts
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-card border border-attention-border bg-attention-surface p-3.5">
      <p className="m-0 text-[13px] font-medium text-solar">
        {limit === null ? `${used} fix attempts used` : `${used} of ${limit} fix attempts used`}
      </p>
      <div>
        <Button
          type="button"
          variant="outline"
          className="min-h-touch max-w-full border-input px-4"
          aria-expanded={open}
          aria-controls={noteId}
          disabled={locked}
          onClick={() => setOpen((value) => !value)}
        >
          Retry with notes
        </Button>
      </div>
      {open ? (
        <div id={noteId} className="flex min-w-0 flex-col gap-2">
          <Label htmlFor={`${noteId}-note`}>Notes for the next attempt</Label>
          <Textarea
            id={`${noteId}-note`}
            className="min-h-touch"
            maxLength={NOTE_MAX_CHARS}
            value={note}
            disabled={locked}
            onChange={(event) => setNote(event.target.value)}
          />
          <p className="m-0 text-[11px] text-faint">
            Allows one more fix attempt and records your note. It does not start one.
          </p>
          <div>
            <Button
              type="button"
              className="min-h-touch max-w-full px-4"
              disabled={locked || note.trim() === ""}
              onClick={() => actions.onRetry(note.trim())}
            >
              Allow one more attempt
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

const REQUESTABLE_STATES: readonly WorkItemDetail["state"][] = [
  "triage",
  "plan",
  "attempt",
  "review",
]

/**
 * hq's start rules, from the facts the page already has (data/attempts.ts `stateMove`,
 * `assertNoActive`, `assertBudget`; hq's own `canRequestAttempt` is the same three rules, kind
 * blind): an attempt starts only from triage (an investigation), plan (either), attempt or review
 * (a fix); never while another is requested or running; a fix never without budget. `blocked` is
 * the one line to say when nothing can start; `investigate` and `fix` are per kind, with the reason
 * a kind is refused when the item as a whole is not.
 */
function startRules(item: WorkItemDetail): {
  blocked: string | null
  investigate: string | null
  fix: string | null
} {
  const { state } = item
  const { used, limit } = item.attempts
  const budget = limit === null || used < limit
  const active =
    item.attempts.running ||
    item.attemptList.some((a) => a.status === "requested" || a.status === "running")
  let blocked: string | null = null
  if (!REQUESTABLE_STATES.includes(state)) {
    // Only what hq offers from this state (a deploy item can be reverted, not reopened).
    const back = [
      item.actions.canReopen ? "Reopen item" : null,
      item.actions.canRevert ? "Revert merge" : null,
    ].filter((name) => name !== null)
    blocked = `No attempt starts while the item is in ${state}: hq starts one only from triage, plan, attempt or review.${
      back.length > 0 ? ` ${back.join(" or ")} is the way back.` : ""
    }`
  } else if (active) {
    blocked = "An attempt is already running. Wait for it to finish, or for its lease to expire."
  } else if ((state === "attempt" || state === "review") && !budget) {
    blocked = `The attempt limit for this item is reached.${
      item.actions.canRetry
        ? " Retry with notes allows one more fix attempt before another can start."
        : " No fix attempt can start this cycle."
    }`
  }
  return {
    blocked,
    investigate:
      state === "triage" || state === "plan"
        ? null
        : `An investigation starts from triage or plan, not from ${state}.`,
    fix:
      state === "triage"
        ? "Investigate first: a fix starts from plan, attempt or review."
        : budget
          ? null
          : "This item has used its fix attempts for this cycle.",
  }
}

function StartAttempt({
  item,
  actions,
  dispatch,
  issueUrl,
}: {
  item: WorkItemDetail
  actions: ItemActions
  dispatch: ItemPageProps["dispatch"]
  issueUrl: string | null
}) {
  const id = useId()
  const [instructions, setInstructions] = useState("")
  const locked = actions.pending !== null
  // A finished or stopped item starts nothing.
  if (item.state === "done" || item.state === "stopped") return null
  const rules = startRules(item)
  const text = instructions.trim() === "" ? undefined : instructions.trim()
  // hq's own verdict is a second lock: a request goes out only where it too says yes.
  const hqAllows = item.actions.canRequestAttempt
  const canInvestigate = hqAllows && rules.blocked === null && rules.investigate === null
  const canFix = hqAllows && rules.blocked === null && rules.fix === null
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2">
      <h3 id={id} className="m-0 text-[13px] font-semibold">
        Start an attempt
      </h3>
      {dispatch === null ? (
        <p className={MUTED}>
          How attempts start could not be read, so nothing is offered here. Reload to try again.
        </p>
      ) : dispatch === "loading" ? (
        <p className={MUTED}>Checking how attempts start.</p>
      ) : dispatch === "label" ? (
        rules.blocked !== null ? (
          <p className="m-0 text-xs leading-normal text-soft">{rules.blocked}</p>
        ) : issueUrl ? (
          <>
            <p className="m-0 text-xs leading-normal text-soft">
              Add the <code className="font-mono">agent:build</code> label to the issue to start the
              agent (if it already has the label, remove it and add it again: GitHub starts a run
              only when the label is added).
            </p>
            <div>
              <a href={issueUrl} target="_blank" rel="noreferrer noopener" className={LINK_CLASS}>
                Open the issue on GitHub
              </a>
            </div>
          </>
        ) : (
          <p className="m-0 text-xs leading-normal text-soft">
            This item has no GitHub issue. Open an issue for it and add the{" "}
            <code className="font-mono">agent:build</code> label; label mode cannot start an item
            without one.
          </p>
        )
      ) : (
        <div className="flex min-w-0 flex-col gap-2">
          <Label htmlFor={`${id}-instructions`}>Instructions for the agent (optional)</Label>
          <Textarea
            id={`${id}-instructions`}
            className="min-h-touch"
            maxLength={NOTE_MAX_CHARS}
            value={instructions}
            disabled={locked}
            onChange={(event) => setInstructions(event.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              className="min-h-touch max-w-full px-4"
              disabled={locked || !canInvestigate}
              onClick={() => actions.onRequestAttempt("investigate", text)}
            >
              Request an investigation
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-touch max-w-full border-input px-4"
              disabled={locked || !canFix}
              onClick={() => actions.onRequestAttempt("fix", text)}
            >
              Request a fix attempt
            </Button>
          </div>
          {rules.blocked !== null ? (
            <p className={MUTED}>{rules.blocked}</p>
          ) : !hqAllows ? (
            <p className={MUTED}>
              hq does not allow a request right now: an attempt may already be active, the item may
              be in a state that starts none, or its fix attempts may be used up.
            </p>
          ) : (
            <>
              {rules.investigate ? <p className={MUTED}>{rules.investigate}</p> : null}
              {rules.fix ? <p className={MUTED}>{rules.fix}</p> : null}
              <p className={MUTED}>It starts when the agent claims it. Nothing runs before that.</p>
            </>
          )}
        </div>
      )}
      {(dispatch === "label" || dispatch === "claim") &&
      rules.blocked === null &&
      item.state === "review" &&
      item.mergeApproval?.status === "pending" ? (
        // A retry moves the item out of review: an approval left pending there can never be
        // approved (hq's approveMerge needs the item in review).
        <p className="m-0 text-xs leading-normal text-solar">
          Starting another attempt leaves the waiting merge approval unusable.
        </p>
      ) : null}
    </section>
  )
}

function FounderNotes({ notes }: { notes: WorkItemDetail["founderNotes"] }) {
  const id = useId()
  if (notes.length === 0) return null
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2">
      <h3 id={id} className="m-0 text-[13px] font-semibold">
        Your notes
      </h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {notes.map((note, index) => (
          <li
            // Notes have no id; hq's list is in the order they were written.
            key={`${index}-${note.at}`}
            className="flex min-w-0 flex-col gap-1 overflow-hidden rounded-control border border-border bg-muted px-3 py-2.5"
          >
            <span className="font-mono text-[11px] text-faint">
              {NOTE_KIND[note.kind]} · {utc(note.at)}
            </span>
            <ClampedText text={note.text} what="the note" className="text-[13px] text-soft" />
          </li>
        ))}
      </ul>
    </section>
  )
}

function EvidenceSection({ item }: { item: WorkItemDetail }) {
  const signal = item.signal
  const link = signal ? signalLink(signal.url, item.repo, signal.urlChecked) : null
  return (
    <Section id="evidence" title="Evidence">
      {signal === null ? (
        <p className={MUTED}>This item has no signal.</p>
      ) : (
        <div className="flex min-w-0 flex-col gap-2">
          {link ? (
            <div>
              <a href={link.href} target="_blank" rel="noreferrer noopener" className={LINK_CLASS}>
                Open the {link.kind} on GitHub
              </a>
            </div>
          ) : signal.url ? (
            <p className="m-0 font-mono text-[11px] text-faint wrap-anywhere">
              Signal address (not a checked page of this repo, so not a link): {signal.url}
            </p>
          ) : (
            <p className={MUTED}>This signal has no address.</p>
          )}
          {signal.evidence ? (
            <ClampedText
              text={signal.evidence}
              what="the evidence"
              className="rounded-control border border-border bg-muted p-3 font-mono text-xs leading-relaxed text-soft"
            />
          ) : (
            <p className={MUTED}>No evidence text was recorded.</p>
          )}
        </div>
      )}
    </Section>
  )
}

const WAITING: Record<NonNullable<WorkItemDetail["window"]>["waitingOn"][number]["state"], string> =
  {
    pending: "not checked yet",
    not_connected: "not connected, so nothing is checking it",
    failing: "failing",
  }

function WindowSection({ window: win }: { window: NonNullable<WorkItemDetail["window"]> }) {
  const hours = hoursOf(win.startsAt, win.endsAt)
  const status =
    win.status === "running"
      ? win.pastEnd
        ? "Running · past its end"
        : win.remainingMinutes === null
          ? "Running"
          : `Running · ${left(win.remainingMinutes)} left`
      : WINDOW_LABEL[win.status]
  return (
    <Section id="verification-window" title="Verification window">
      <p className="m-0 text-xs leading-normal text-soft">
        {hours === null ? "Runs" : `Runs the contract above for ${hours} h.`} Reopens automatically
        on recurrence; a revert is your call.
      </p>
      <p className="m-0 font-mono text-[11px] text-faint">{status}</p>
      {win.waitingOn.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-soft">
          {win.waitingOn.map((wait) => (
            <li key={wait.contractItemId} className="wrap-anywhere">
              {wait.kind}: {WAITING[wait.state]}
            </li>
          ))}
        </ul>
      ) : null}
      <VerificationChart
        buckets={win.buckets}
        mergedAt={win.mergedAt}
        through={win.status !== "running" || win.pastEnd ? "window end" : "now"}
      />
    </Section>
  )
}

function History({ item }: { item: WorkItemDetail }) {
  return (
    <Section id="history" title="History">
      {item.truncated.events ? <p className={MUTED}>Only the newest events are shown.</p> : null}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {item.events.map((event) => (
          <li
            key={event.id}
            className="flex min-w-0 flex-col gap-1 overflow-hidden rounded-control border border-border bg-card px-3 py-2.5"
          >
            <span className="font-mono text-[11px] text-faint wrap-anywhere">
              {utc(event.at)} · {event.actorType}
            </span>
            <span className="min-w-0 text-[13px] text-soft wrap-anywhere">{event.summary}</span>
            {event.note ? (
              <ClampedText
                text={event.note}
                what="the note"
                className="text-xs text-muted-foreground"
              />
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  )
}

/**
 * One work item: the mock's Item detail with its real words. Every text hq or an agent wrote (the
 * title, the signal, the evidence, notes, prompts, option labels, summaries) is plain text,
 * bounded and cut only where "Show all" is offered. Each decision is asked twice in place and sent
 * by the container once. In label mode no control starts an attempt: the page says how it starts.
 */
export function ItemPage({
  item,
  transcript,
  actions,
  dispatch,
  issueUrl,
  approvedBy = null,
}: ItemPageProps) {
  const titleId = useId()
  const locked = actions.pending !== null
  const signal = item.signal
  const newestAttempt = item.attemptList.reduce<number | null>(
    (max, attempt) => (max === null || attempt.number > max ? attempt.number : max),
    null,
  )

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <header className="flex min-w-0 flex-col gap-3">
        <Link
          to="/work"
          className="inline-flex min-h-touch items-center gap-1.5 self-start text-sm text-muted-foreground hover:underline"
        >
          <span aria-hidden="true">←</span>
          Work
        </Link>
        <h1 id={titleId} className="m-0 text-xl font-semibold text-foreground wrap-anywhere">
          {item.title}
        </h1>
        <section
          aria-label="About this item"
          className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-xs text-faint"
        >
          <span>{item.displayId}</span>
          <span>
            {SOURCE_LABEL[item.source]} · {item.repo}
          </span>
          {signal ? <span className="wrap-anywhere">{signal.summary}</span> : null}
          {signal && signal.occurrences > 1 ? <span>{signal.occurrences} occurrences</span> : null}
          {signal ? <span>first seen {utc(signal.firstSeenAt)}</span> : null}
          <span className="inline-flex flex-wrap items-baseline gap-x-2">
            <span className={`font-medium ${TONE_CLASS[item.card.tone]}`}>{item.card.label}</span>
            <span className="wrap-anywhere">{item.card.detail}</span>
          </span>
        </section>
        <Decisions item={item} actions={actions} titleId={titleId} />
      </header>

      {actions.notice ? (
        <output
          aria-label="Last action"
          className="block rounded-card border border-border bg-card p-3 text-sm text-soft wrap-anywhere"
        >
          {actions.notice}
        </output>
      ) : null}
      {actions.error ? (
        <p role="alert" className="m-0 text-sm text-destructive wrap-anywhere">
          {actions.error}
        </p>
      ) : null}

      <Section id="progress" title="Progress">
        <StageStrip stages={item.stages} cycle={item.cycle} />
      </Section>

      <div className="flex min-w-0 flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[2_1_440px] flex-col gap-5">
          <Section
            id="contract"
            title="Plan and verification contract"
            description="Recorded before the first attempt. Done means these hold."
          >
            <ContractList items={item.contract} />
          </Section>

          <Section id="attempts" title="Attempts">
            {item.truncated.attempts ? (
              <p className={MUTED}>Only the newest attempts are shown.</p>
            ) : null}
            {item.attemptList.length === 0 ? (
              <p className={MUTED}>No attempt has started.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {item.attemptList.map((attempt) => (
                  <li key={attempt.id} className="flex min-w-0 flex-col">
                    <AttemptCard attempt={attempt} />
                  </li>
                ))}
              </ul>
            )}
            {item.actions.canRetry ? <RetryControl item={item} actions={actions} /> : null}
            <StartAttempt item={item} actions={actions} dispatch={dispatch} issueUrl={issueUrl} />
            <FounderNotes notes={item.founderNotes} />
          </Section>

          <Section id="questions" title="Questions from agents">
            {item.truncated.questions ? (
              <p className={MUTED}>Only the newest questions are shown.</p>
            ) : null}
            {item.questions.length === 0 ? (
              <p className={MUTED}>No agent has asked a question.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {item.questions.map((question) => (
                  <li key={question.id} className="flex min-w-0 flex-col">
                    <QuestionCard
                      question={question}
                      pending={locked}
                      onAnswer={(optionId) => actions.onAnswer(question.id, optionId)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {newestAttempt === null ? null : (
            <Transcript state={transcript} attemptNumber={newestAttempt} />
          )}
        </div>

        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-5">
          {item.pullRequest ? (
            <PullRequestPanel
              pr={item.pullRequest}
              mergeApproval={item.mergeApproval}
              canApprove={item.state === "review"}
              onApproveMerge={actions.onApproveMerge}
              pending={locked}
              repo={item.repo}
              reviewer={newestReviewer(item)}
              approvedBy={approvedBy}
            />
          ) : (
            <Section id="pull-request" title="Pull request">
              <p className={MUTED}>No pull request yet.</p>
            </Section>
          )}
          <EvidenceSection item={item} />
          {item.window ? <WindowSection window={item.window} /> : null}
          <History item={item} />
        </div>
      </div>
    </div>
  )
}
