import { Button } from "@proof/ui/components/ui/button"
import { Input } from "@proof/ui/components/ui/input"
import { Label } from "@proof/ui/components/ui/label"
import { useId, useState } from "react"

import type { Proposal } from "../api/schemas"

export interface ProposalCardProps {
  proposal: Proposal
  onDecide(input: { decision: "approve" | "reject"; note?: string }): void
  /** A decision for this card is on its way (or is made and the list has not caught up yet). */
  pending: boolean
  error: string | null
}

// What a collapsed card shows. A proposal comes from an agent or from outside input, so any of
// these can be as long as it likes: the card cuts them down so Approve and Reject stay near the top
// of the card, and the whole text is one click away ("Show all").
const PREVIEW_CHARS = 1200
const LONG_TITLE_CHARS = 120
const LONG_REASON_CHARS = 240
const LONG_BODY_CHARS = 480
const LONG_BODY_LINES = 8
/** What hq accepts for a decision note. */
const NOTE_MAX_CHARS = 2000

/**
 * One proposal that needs a founder, as the mock's "Needs you" card. Everything the proposal says
 * (title, reason, body) is untrusted and rendered as plain text: React text nodes only, no HTML or
 * markdown, no links, long words broken where they would overflow.
 */
export function ProposalCard({ proposal, onDecide, pending, error }: ProposalCardProps) {
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const [note, setNote] = useState("")

  const text = proposal.body.text
  const long =
    proposal.title.length > LONG_TITLE_CHARS ||
    proposal.reason.length > LONG_REASON_CHARS ||
    text.length > LONG_BODY_CHARS ||
    text.split("\n").length > LONG_BODY_LINES
  const shownText =
    !expanded && text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text
  // One decision for the clamp and the toggle: text is cut only on a card that offers "Show all".
  // Under the thresholds above every field is short enough to show whole, at any width.
  const clamp = (lines: string) => (long && !expanded ? lines : "")

  const decide = (decision: "approve" | "reject") => {
    if (pending) return
    const trimmed = note.trim()
    onDecide(trimmed === "" ? { decision } : { decision, note: trimmed })
  }

  return (
    <article
      aria-labelledby={`${id}-title`}
      aria-busy={pending || undefined}
      className="flex min-w-0 flex-col gap-3 rounded-card border border-attention-border bg-attention-surface p-3.5"
    >
      <div className="flex min-w-0 flex-col gap-1 overflow-hidden">
        <span className="font-mono text-[11px] text-faint">
          {proposal.id.slice(0, 8)} · proposal · {proposal.kind}
        </span>
        <h3
          id={`${id}-title`}
          className={`m-0 text-sm leading-snug font-medium wrap-anywhere text-foreground ${clamp("line-clamp-3")}`}
        >
          {proposal.title}
        </h3>
        <p
          className={`m-0 text-xs leading-snug wrap-anywhere text-muted-foreground ${clamp("line-clamp-4")}`}
        >
          {proposal.reason}
        </p>
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[11px] text-faint">Proposed text</span>
        {/* The box carries the padding; the clamped text sits inside it, so a cut-off line never
            shows in the padding. */}
        <div className="min-w-0 overflow-hidden rounded-control border border-border bg-muted p-2.5">
          <p
            id={`${id}-body`}
            className={`m-0 text-xs leading-relaxed whitespace-pre-wrap wrap-anywhere text-soft ${clamp("line-clamp-8")}`}
          >
            {shownText}
          </p>
        </div>
        {long ? (
          <Button
            type="button"
            variant="ghost"
            className="min-h-touch self-start"
            aria-expanded={expanded}
            aria-controls={`${id}-body`}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : "Show all"}
          </Button>
        ) : null}
      </div>

      <div data-slot="decision" className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-note`}>Note (optional)</Label>
          <Input
            id={`${id}-note`}
            className="min-h-touch"
            maxLength={NOTE_MAX_CHARS}
            value={note}
            disabled={pending}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            className="min-h-touch border-solar bg-solar px-4 text-primary-foreground hover:bg-solar/85"
            aria-describedby={`${id}-title`}
            disabled={pending}
            onClick={() => decide("approve")}
          >
            Approve
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-touch border-input px-4"
            aria-describedby={`${id}-title`}
            disabled={pending}
            onClick={() => decide("reject")}
          >
            Reject
          </Button>
        </div>
        {error ? (
          <p role="alert" className="m-0 text-xs wrap-anywhere text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </article>
  )
}
