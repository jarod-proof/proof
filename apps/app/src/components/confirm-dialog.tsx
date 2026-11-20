import { type ReactElement, type ReactNode, useState } from "react"

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@proof/ui/components/ui/alert-dialog"
import { Button } from "@proof/ui/components/ui/button"

export interface ConfirmDialogProps {
  /** Controlled open state. Omit both this and `onOpenChange` to let a `trigger` own it. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  /** Extra body content between the description and the buttons (e.g. a typed-name field). */
  children?: ReactNode
  confirmLabel: ReactNode
  /** Shown on the confirm button while `pending`. Defaults to `confirmLabel`. */
  pendingLabel?: ReactNode
  cancelLabel?: ReactNode
  /** A destructive action: the confirm button is the destructive variant (a red outline). */
  destructive?: boolean
  /** The action is in flight: the confirm button is disabled and shows `pendingLabel`. */
  pending?: boolean
  /** Disables confirm without marking it pending (e.g. a typed name does not match yet). */
  confirmDisabled?: boolean
  /** A failure the person can act on, shown above the buttons. */
  error?: string | null
  onConfirm: () => void
  /** Element that opens the dialog. Omit when `open` is controlled elsewhere. */
  trigger?: ReactElement
}

/**
 * An AlertDialog asking the person to confirm an action: a title, the consequence, Cancel and a
 * confirm button that is disabled while the action is pending. The caller owns the action, its
 * pending flag and its error; this only lays them out.
 */
export function ConfirmDialog({
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  title,
  description,
  children,
  confirmLabel,
  pendingLabel,
  cancelLabel = "Cancel",
  destructive = false,
  pending = false,
  confirmDisabled = false,
  error,
  onConfirm,
  trigger,
}: ConfirmDialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const onOpenChange = controlledOnOpenChange ?? setUncontrolledOpen
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {trigger ? <AlertDialogTrigger render={trigger} /> : null}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {children}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={pending || confirmDisabled}
            onClick={onConfirm}
          >
            {pending && pendingLabel !== undefined ? pendingLabel : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
