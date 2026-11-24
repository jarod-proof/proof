import { Button } from "@proof/ui/components/ui/button"
import { type ReactNode, useState } from "react"

export interface ConfirmInlineProps {
  /** The button that asks (and the name of the group it opens). */
  label: string
  confirmLabel: string
  /** Called once per click on the confirm button, nowhere else. */
  onConfirm(): void
  /** A write is on its way: nothing here can be clicked. */
  pending: boolean
  /** What the founder is asked to confirm, in plain text. */
  children?: ReactNode
  /** The id of the element that names what this is about (the card's title). */
  describedBy?: string
}

/**
 * A decision asked twice, in place: the first click opens the question (it sends nothing), the
 * second one, on `confirmLabel`, calls `onConfirm`. Cancel closes it. No dialog, no timer.
 */
export function ConfirmInline({
  label,
  confirmLabel,
  onConfirm,
  pending,
  children,
  describedBy,
}: ConfirmInlineProps) {
  const [asking, setAsking] = useState(false)

  if (!asking) {
    return (
      <Button
        type="button"
        variant="outline"
        className="min-h-touch max-w-full border-input px-4"
        aria-describedby={describedBy}
        disabled={pending}
        onClick={() => setAsking(true)}
      >
        {label}
      </Button>
    )
  }
  return (
    <fieldset className="m-0 flex min-w-0 basis-full flex-col gap-2 rounded-control border border-attention-border bg-background p-2.5">
      <legend className="sr-only">{label}</legend>
      {children ? <div className="min-w-0 text-xs text-soft wrap-anywhere">{children}</div> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          className="min-h-touch max-w-full border-solar bg-solar px-4 text-primary-foreground hover:bg-solar/85"
          aria-describedby={describedBy}
          disabled={pending}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-touch max-w-full border-input px-4"
          disabled={pending}
          onClick={() => setAsking(false)}
        >
          Cancel
        </Button>
      </div>
    </fieldset>
  )
}
