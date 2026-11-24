import { Button } from "@proof/ui/components/ui/button"
import { Label } from "@proof/ui/components/ui/label"
import { Textarea } from "@proof/ui/components/ui/textarea"
import { Link } from "@tanstack/react-router"
import { type ReactNode, useId, useState } from "react"

import type { NeedsYou } from "../api/schemas"
import { pullRequestLink } from "../lib/pull-request-link"
import { ConfirmInline } from "./confirm-inline"

/**
 * What the board can write, and what is in flight. `pending` is the key (`needKey`) of the card
 * whose write is on its way, or null; while it is not null nothing on the board can be clicked
 * (one write at a time). `errors` is what hq answered, by card key.
 */
export interface NeedsYouActions {
  onApproveMerge(need: NeedsYou): void
  onAnswer(questionId: string, optionId: string): void
  onRetry(itemId: string, note: string): void
  pending: string | null
  errors: Record<string, string>
}

/** One card per item and kind: the key its pending state and its error are kept under. */
export const needKey = (need: NeedsYou): string => `${need.kind}:${need.itemId}`

const KIND_LABEL: Record<NeedsYou["kind"], string> = {
  merge_approval: "merge approval",
  agent_question: "agent question",
  attempt_budget: "attempt budget",
  stuck_attempt: "stuck attempt",
}

/** hq stores 2 000 characters of a note (NOTE_MAX_CHARS); a longer one is refused. */
const NOTE_MAX_CHARS = 2000
// What a collapsed card shows. Every text field is untrusted and can be as long as it likes, but a
// founder answers or approves from this card, so text is cut only on a card that offers "Show all"
// (as ProposalCard does), and a card offers it whenever any field is beyond what its cut would
// show at a phone's width (the limits sit below the clamp's lines at about 45 characters a line).
const LONG_TITLE_CHARS = 100
const LONG_REASON_CHARS = 160
const LONG_PROMPT_CHARS = 300
const LONG_PROMPT_LINES = 6
const LONG_DETAIL_CHARS = 120
const LONG_DETAIL_LINES = 2

const lineCount = (text: string) => text.split("\n").length

/** Whether any text on the card could be cut when it is collapsed. */
export function isLong(need: NeedsYou): boolean {
  const question = need.question
  return (
    need.title.length > LONG_TITLE_CHARS ||
    need.reason.length > LONG_REASON_CHARS ||
    (question !== undefined &&
      (question.prompt.length > LONG_PROMPT_CHARS ||
        lineCount(question.prompt) > LONG_PROMPT_LINES ||
        question.options.some(
          (o) =>
            o.detail !== undefined &&
            (o.detail.length > LONG_DETAIL_CHARS || lineCount(o.detail) > LONG_DETAIL_LINES),
        )))
  )
}

const LINK_BASE =
  "inline-flex min-h-touch max-w-full items-center justify-center rounded-lg border-2 px-4 text-sm font-bold"
const PRIMARY_LINK = `${LINK_BASE} border-solar bg-solar text-primary-foreground hover:bg-solar/85`
const OUTLINE_LINK = `${LINK_BASE} border-input text-foreground hover:bg-accent`
// A button whose text comes from outside (an option label) must wrap and stay inside the card.
const TEXT_BUTTON =
  "h-auto min-h-touch w-full max-w-full justify-start px-4 py-2 text-left whitespace-normal wrap-anywhere"
const PRIMARY_BUTTON = "border-solar bg-solar text-primary-foreground hover:bg-solar/85"

function ItemLink({
  need,
  label,
  primary,
  describedBy,
}: {
  need: NeedsYou
  label: string
  primary: boolean
  describedBy: string
}) {
  return (
    <Link
      to="/work/$itemId"
      params={{ itemId: need.displayId }}
      className={primary ? PRIMARY_LINK : OUTLINE_LINK}
      aria-describedby={describedBy}
    >
      {label}
    </Link>
  )
}

function MergeBody({
  need,
  actions,
  repos,
  titleId,
}: {
  need: NeedsYou
  actions: NeedsYouActions
  repos: readonly string[]
  titleId: string
}) {
  const merge = need.merge
  if (!merge) return <ItemLink need={need} label="Open item" primary describedBy={titleId} />
  const link = pullRequestLink(merge.pullRequestUrl, merge.number, repos)
  const sha = merge.headSha.slice(0, 7)
  const locked = actions.pending !== null
  return (
    <>
      <p className="m-0 font-mono text-[11px] text-faint wrap-anywhere">
        PR #{merge.number} · head {sha} · {merge.isDraft ? "draft" : "ready for review"}
      </p>
      <div className="flex flex-wrap gap-2">
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noreferrer noopener"
            className={PRIMARY_LINK}
            aria-describedby={titleId}
          >
            Review diff
          </a>
        ) : null}
        {/* A new head is a new question: the key restarts the confirmation. */}
        <ConfirmInline
          key={merge.headSha}
          label="Approve merge"
          confirmLabel="Confirm"
          pending={locked}
          describedBy={titleId}
          onConfirm={() => actions.onApproveMerge(need)}
        >
          Approve pull request #{merge.number} at head <span className="font-mono">{sha}</span>
          {merge.isDraft ? ", which is a draft" : ""}. Your decision is recorded for this head only.
          It does not merge anything on GitHub.
        </ConfirmInline>
      </div>
    </>
  )
}

function QuestionBody({
  need,
  actions,
  titleId,
  long,
  clamp,
  toggle,
}: {
  need: NeedsYou
  actions: NeedsYouActions
  titleId: string
  long: boolean
  /** The clamp class for a field, or "" while the card is expanded or short. */
  clamp: (lines: string) => string
  toggle: ReactNode
}) {
  const question = need.question
  if (!question) return <ItemLink need={need} label="Open item" primary describedBy={titleId} />
  const locked = actions.pending !== null
  // The recommended option first, only when it is one of the options; the rest keep hq's order.
  const recommended = question.options.find((o) => o.id === question.defaultOptionId)
  const options = recommended
    ? [recommended, ...question.options.filter((o) => o.id !== recommended.id)]
    : question.options
  return (
    <>
      <p
        className={`m-0 text-xs leading-relaxed whitespace-pre-wrap text-soft wrap-anywhere ${clamp("line-clamp-8")}`}
      >
        {question.prompt}
      </p>
      {long ? (
        <div className="flex flex-wrap gap-2">
          {toggle}
          <ItemLink
            need={need}
            label="Open item to read it all"
            primary={false}
            describedBy={titleId}
          />
        </div>
      ) : null}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {options.map((option) => {
          const isDefault = option === recommended
          return (
            <li key={option.id} className="flex min-w-0 flex-col gap-1">
              <Button
                type="button"
                variant={isDefault ? "default" : "outline"}
                className={`${TEXT_BUTTON} ${isDefault ? PRIMARY_BUTTON : "border-input"}`}
                disabled={locked}
                onClick={() => actions.onAnswer(question.questionId, option.id)}
              >
                {isDefault ? `${option.label} (default)` : option.label}
              </Button>
              {option.detail ? (
                <p
                  className={`m-0 px-1 text-[11px] whitespace-pre-wrap text-faint wrap-anywhere ${clamp("line-clamp-4")}`}
                >
                  {option.detail}
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>
    </>
  )
}

function RetryBody({
  need,
  actions,
  titleId,
}: {
  need: NeedsYou
  actions: NeedsYouActions
  titleId: string
}) {
  const noteId = useId()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState("")
  const locked = actions.pending !== null
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <ItemLink need={need} label="Take over" primary describedBy={titleId} />
        <Button
          type="button"
          variant="outline"
          className="min-h-touch max-w-full border-input px-4"
          aria-expanded={open}
          aria-controls={noteId}
          aria-describedby={titleId}
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
          <p className="m-0 text-[11px] text-faint wrap-anywhere">
            Allows one more fix attempt and records your note. It does not start one.
          </p>
          <div>
            <Button
              type="button"
              className={`min-h-touch max-w-full px-4 ${PRIMARY_BUTTON}`}
              disabled={locked || note.trim() === ""}
              onClick={() => actions.onRetry(need.itemId, note.trim())}
            >
              Allow one more attempt
            </Button>
          </div>
        </div>
      ) : null}
    </>
  )
}

/**
 * One thing that waits for a founder, as the mock's "Needs you" card. Everything the card says
 * (title, reason, prompt, option labels and details) is untrusted and rendered as plain text:
 * React text nodes only, long words broken where they would overflow, each block bounded, and
 * the buttons never inside a text element. The one link built from data is "Review diff", and
 * only for the pull request page of one of `repos` (`pullRequestLink`).
 */
export function NeedsYouCard({
  need,
  actions,
  repos,
}: {
  need: NeedsYou
  actions: NeedsYouActions
  /** The repos the item can belong to: its own, or the board's when the item is not listed. */
  repos: readonly string[]
}) {
  const id = useId()
  const titleId = `${id}-title`
  const key = needKey(need)
  const error = actions.errors[key]
  const [expanded, setExpanded] = useState(false)
  const long = isLong(need)
  // One decision for every clamp: text is cut only on a card that offers "Show all".
  const clamp = (lines: string) => (long && !expanded ? lines : "")
  const toggle = long ? (
    <Button
      type="button"
      variant="ghost"
      className="min-h-touch self-start px-3"
      aria-expanded={expanded}
      aria-controls={titleId}
      onClick={() => setExpanded((value) => !value)}
    >
      {expanded ? "Show less" : "Show all"}
    </Button>
  ) : null
  return (
    <article
      aria-labelledby={titleId}
      aria-busy={actions.pending === key || undefined}
      className="flex min-w-0 flex-col gap-3 rounded-card border border-attention-border bg-attention-surface p-3.5"
    >
      <div className="flex min-w-0 flex-col gap-1 overflow-hidden">
        <span className="font-mono text-[11px] text-faint wrap-anywhere">
          {need.displayId} · {KIND_LABEL[need.kind]}
        </span>
        <h3
          id={titleId}
          className={`m-0 text-sm leading-snug font-medium text-foreground wrap-anywhere ${clamp("line-clamp-3")}`}
        >
          {need.title}
        </h3>
        <p
          className={`m-0 text-xs leading-snug text-muted-foreground wrap-anywhere ${clamp("line-clamp-4")}`}
        >
          {need.reason}
        </p>
      </div>
      {long && need.kind !== "agent_question" ? toggle : null}
      {need.kind === "merge_approval" ? (
        <MergeBody need={need} actions={actions} repos={repos} titleId={titleId} />
      ) : null}
      {need.kind === "agent_question" ? (
        <QuestionBody
          need={need}
          actions={actions}
          titleId={titleId}
          long={long}
          clamp={clamp}
          toggle={toggle}
        />
      ) : null}
      {need.kind === "attempt_budget" ? (
        <RetryBody need={need} actions={actions} titleId={titleId} />
      ) : null}
      {need.kind === "stuck_attempt" ? (
        // hq refuses "retry" while an attempt is still live, so the one real move is the item.
        <div>
          <ItemLink need={need} label="Open item" primary describedBy={titleId} />
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 text-xs text-destructive wrap-anywhere">
          {error}
        </p>
      ) : null}
    </article>
  )
}
