import type { HqError } from "../api/errors"
import { ClampedText } from "./clamped-text"
import { ErrorBlock, LoadingBlock, NotConnected } from "./states"

export type TranscriptState =
  | { kind: "not-recorded" }
  | { kind: "loading" }
  | { kind: "error"; error: HqError }
  | { kind: "ready"; events: { at: string; tool: string; text: string }[] }

/**
 * The transcript of one attempt, from whatever the container could read. Phase 4 records none, so
 * `not-recorded` says "Not connected" rather than showing an empty or invented one. Ready events are
 * plain text: the time, the tool and the text are never markup and never a link.
 */
export function Transcript({
  state,
  attemptNumber,
}: {
  state: TranscriptState
  attemptNumber: number
}) {
  const headingId = `transcript-${attemptNumber}`
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2.5">
      <h2 id={headingId} className="m-0 text-[13px] font-semibold">
        Attempt {attemptNumber} transcript
      </h2>
      {state.kind === "not-recorded" ? (
        <NotConnected source="Phase 2 sessions" what="the attempt transcript" />
      ) : state.kind === "loading" ? (
        <LoadingBlock label="the transcript" />
      ) : state.kind === "error" ? (
        <ErrorBlock error={state.error} />
      ) : state.events.length === 0 ? (
        <p className="m-0 text-xs text-faint">The transcript has no events.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col overflow-hidden rounded-card border border-border bg-background p-0 py-1.5">
          {state.events.map((event, index) => (
            <li
              // Events have no id of their own; the list never reorders.
              key={index}
              className="flex min-w-0 gap-3 px-4 py-1.5 font-mono text-xs leading-normal"
            >
              <span className="shrink-0 basis-10 text-faint wrap-anywhere">{event.at}</span>
              <span className="shrink-0 basis-12 font-medium text-muted-foreground wrap-anywhere">
                {event.tool}
              </span>
              <span className="min-w-0 flex-1">
                <ClampedText text={event.text} what="the event" className="text-soft" />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
