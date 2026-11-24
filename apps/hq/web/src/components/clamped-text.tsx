import { Button } from "@proof/ui/components/ui/button"
import { useId, useState } from "react"

// What a collapsed text shows. Every text field of an item is untrusted and can be as long as it
// likes, so a text is cut only when it offers "Show all", and it offers it whenever the cut could
// hide something: by length (about 45 characters a line at a phone's width) or by line breaks.
const LONG_CHARS = 240
const LONG_LINES = 6

const lineCount = (text: string) => text.split("\n").length

/** Whether the text could be cut when it is collapsed. */
export const isLongText = (text: string): boolean =>
  text.length > LONG_CHARS || lineCount(text) > LONG_LINES

/**
 * Untrusted text as plain text: one React text node, long words broken where they would overflow,
 * line breaks kept, never markup and never a link. A long text is cut to six lines with a
 * "Show all" that opens the whole of it (the text is in the page either way: a clamp hides lines,
 * not characters). `what` names the text for the toggle ("Show all of the note").
 */
export function ClampedText({
  text,
  what,
  className = "",
}: {
  text: string
  /** What the text is, for the toggle's name: "the note". */
  what: string
  /** Type styles for the text (size, colour, font). */
  className?: string
}) {
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const long = isLongText(text)
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <p
        id={id}
        className={`m-0 min-w-0 max-w-full whitespace-pre-wrap wrap-anywhere ${long && !expanded ? "line-clamp-6" : ""} ${className}`}
      >
        {text}
      </p>
      {long ? (
        <Button
          type="button"
          variant="ghost"
          className="min-h-touch px-3"
          aria-expanded={expanded}
          aria-controls={id}
          aria-label={`${expanded ? "Show less" : "Show all"} of ${what}`}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show all"}
        </Button>
      ) : null}
    </div>
  )
}
