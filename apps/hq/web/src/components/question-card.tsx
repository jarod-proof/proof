import { Button } from "@proof/ui/components/ui/button"
import { useId } from "react"

import type { QuestionView } from "../api/schemas"
import { ClampedText } from "./clamped-text"

const letter = (index: number) => String.fromCharCode(65 + index)

// A button whose text comes from outside (an option label) must wrap and stay inside the card.
const OPTION_BUTTON =
  "h-auto min-h-touch w-full max-w-full justify-start gap-2 px-4 py-2 text-left whitespace-normal wrap-anywhere"

/**
 * One question an agent asked a founder. The prompt, the option labels and details are untrusted:
 * plain text, bounded, the prompt cut with "Show all" so that the answers stay in view. Options are
 * lettered in hq's order, so "You answered A" always names the option that was answered. The
 * recommended option is marked "default" and is only a recommendation: nothing applies it.
 * Answer buttons exist only while the question is open and call `onAnswer` once per click.
 */
export function QuestionCard({
  question,
  onAnswer,
  pending,
}: {
  question: QuestionView
  onAnswer(optionId: string): void
  pending: boolean
}) {
  const titleId = useId()
  const open = question.status === "open"
  const answeredIndex = question.options.findIndex((o) => o.id === question.answeredOptionId)
  const hasDefault = question.options.some((o) => o.id === question.defaultOptionId)
  return (
    <article
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-2.5 overflow-hidden rounded-card border border-attention-border bg-attention-surface px-4 py-3.5"
    >
      <h3 id={titleId} className="sr-only">
        Question from an agent
      </h3>
      <ClampedText
        text={question.prompt}
        what="the question"
        className="text-[13px] leading-normal text-soft"
      />
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {question.options.map((option, index) => {
          const isDefault = option.id === question.defaultOptionId
          const body = (
            <>
              <span className="font-mono font-medium text-foreground">{letter(index)}</span>
              <span className="min-w-0 wrap-anywhere">{option.label}</span>
              {isDefault ? <span className="font-mono text-[11px] text-faint">default</span> : null}
            </>
          )
          return (
            <li key={option.id} className="flex min-w-0 flex-col gap-1">
              {open ? (
                <Button
                  type="button"
                  variant="outline"
                  className={`${OPTION_BUTTON} border-input`}
                  disabled={pending}
                  onClick={() => onAnswer(option.id)}
                >
                  {body}
                </Button>
              ) : (
                <span className="flex min-w-0 items-baseline gap-2 text-[12.5px] text-muted-foreground">
                  {body}
                </span>
              )}
              {option.detail ? (
                <span className="px-1 text-[11px] whitespace-pre-wrap text-faint wrap-anywhere">
                  {option.detail}
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>
      {open && hasDefault ? (
        <p className="m-0 text-[11px] text-faint">
          default is the agent&apos;s recommendation. Nothing applies it for you.
        </p>
      ) : null}
      {open ? (
        <span className="text-xs font-medium text-solar">waits for your answer</span>
      ) : question.status === "answered" ? (
        <span className="text-xs font-medium text-success">
          {answeredIndex >= 0 ? `You answered ${letter(answeredIndex)}` : "Answered"}
        </span>
      ) : (
        <span className="text-xs text-faint">Withdrawn. No answer is needed.</span>
      )}
    </article>
  )
}
