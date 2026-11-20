import { createFormHook, createFormHookContexts } from "@tanstack/react-form"
import { type ComponentProps, type ReactNode, useId } from "react"

import { Alert, AlertDescription, AlertTitle } from "@proof/ui/components/ui/alert"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@proof/ui/components/ui/alert-dialog"
import { Button } from "@proof/ui/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@proof/ui/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@proof/ui/components/ui/field"
import { Input } from "@proof/ui/components/ui/input"

import { fieldMessage } from "../lib/messages"

// TanStack Form, wired to the D+ field pieces. A page builds its form with `useAppForm`, renders
// fields with `form.AppField` and `field.TextField`, and never reads field state for display:
// `FieldIssues` shows the Zod message, `invalidOf` sets aria-invalid.

const { fieldContext, formContext, useFieldContext, useFormContext } = createFormHookContexts()

/** Anything with a field's state, so `FieldIssues` works for any field the page has. */
export interface FieldLike {
  state: { meta: { errors: unknown[] } }
}

/** The first message of a field's errors, or null while it is valid. */
export function issueOf(field: FieldLike): string | null {
  const errors = field.state.meta.errors
  return errors.length > 0 ? fieldMessage(errors) : null
}

/** The first message of a field's errors, shown under it. Renders nothing while it is valid. */
export function FieldIssues({ field, hidden = false }: { field: FieldLike; hidden?: boolean }) {
  const message = issueOf(field)
  if (hidden || message === null) return null
  return <FieldError>{message}</FieldError>
}

/** `aria-invalid` for an input whose field has errors: `true`, or undefined so the attribute is absent. */
export function invalidOf(field: FieldLike): true | undefined {
  return field.state.meta.errors.length > 0 ? true : undefined
}

type InputProps = ComponentProps<typeof Input>

export type TextFieldProps = Omit<InputProps, "value" | "onChange" | "onBlur" | "defaultValue"> & {
  label: ReactNode
  /** Sits on the label's line, e.g. a "Forgot password?" link. */
  labelAction?: ReactNode
  /** Help text under the input, after any error. */
  description?: ReactNode
  descriptionId?: string
  /** Hides the Zod message under the input (for a page that shows its own copy). */
  hideError?: boolean
}

/** A labelled text input bound to the field in context: value, blur, error and aria-invalid. */
function TextField({
  label,
  labelAction,
  description,
  descriptionId,
  hideError = false,
  id,
  name,
  ...input
}: TextFieldProps) {
  const field = useFieldContext<string>()
  const generatedId = useId()
  const inputId = id ?? generatedId
  return (
    <Field>
      {labelAction ? (
        <div className="flex items-baseline justify-between gap-2">
          <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
          {labelAction}
        </div>
      ) : (
        <FieldLabel htmlFor={inputId}>{label}</FieldLabel>
      )}
      <Input
        {...input}
        id={inputId}
        name={name ?? field.name}
        value={field.state.value}
        onChange={(event) => field.handleChange(event.currentTarget.value)}
        onBlur={field.handleBlur}
        aria-invalid={input["aria-invalid"] ?? invalidOf(field)}
      />
      <FieldIssues field={field} hidden={hideError} />
      {description ? <FieldDescription id={descriptionId}>{description}</FieldDescription> : null}
    </Field>
  )
}

/** A password input: a TextField with type=password. */
function PasswordField(props: Omit<TextFieldProps, "type">) {
  return <TextField {...props} type="password" />
}

/**
 * The form's submit button. It is disabled while the form submits or while `pending` (an action
 * the page runs outside the form), and shows `pendingLabel` in the first case.
 */
function SubmitButton({
  children,
  pendingLabel,
  pending = false,
  variant,
  className,
}: {
  children: ReactNode
  pendingLabel?: ReactNode
  pending?: boolean
  variant?: ComponentProps<typeof Button>["variant"]
  className?: string
}) {
  const form = useFormContext()
  return (
    <form.Subscribe selector={(state) => state.isSubmitting}>
      {(isSubmitting) => (
        <Button
          type="submit"
          variant={variant}
          className={className}
          disabled={isSubmitting || pending}
        >
          {isSubmitting && pendingLabel !== undefined ? pendingLabel : children}
        </Button>
      )}
    </form.Subscribe>
  )
}

/**
 * A failure the person can act on, under a form or dialog. Renders nothing without a message.
 * With a `title` it is the card-level alert ("Something went wrong"); without one, a line of text.
 */
export function FormError({
  message,
  title,
}: {
  message: string | null | undefined
  title?: string
}) {
  if (!message) return null
  if (title) {
    return (
      <Alert variant="destructive">
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    )
  }
  return (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  )
}

export const { useAppForm } = createFormHook({
  fieldComponents: { TextField, PasswordField },
  formComponents: { SubmitButton },
  fieldContext,
  formContext,
})

export interface FormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Runs once the dialog has finished closing (after its exit animation). */
  onOpenChangeComplete?: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  /** The form's submit: usually `() => void form.handleSubmit()`. */
  onSubmit: () => void
  submitLabel: ReactNode
  pendingLabel?: ReactNode
  cancelLabel?: ReactNode
  /** A destructive action: the submit is the red outline button. */
  destructive?: boolean
  /**
   * An alert dialog (role alertdialog) for a confirmation a person must answer, such as turning
   * off a security setting. Otherwise a plain dialog.
   */
  alert?: boolean
  /** The submit is in flight (a call outside the form's own submit). */
  pending?: boolean
  error?: string | null
  children: ReactNode
}

/**
 * A dialog that holds a form: title, the fields, an error line, and Cancel and submit in the
 * footer. The page owns the form (`useAppForm`) and passes its submit in.
 */
export function FormDialog({
  open,
  onOpenChange,
  onOpenChangeComplete,
  title,
  description,
  onSubmit,
  submitLabel,
  pendingLabel,
  cancelLabel = "Cancel",
  destructive = false,
  alert = false,
  pending = false,
  error,
  children,
}: FormDialogProps) {
  const submitButton = (
    <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={pending}>
      {pending && pendingLabel !== undefined ? pendingLabel : submitLabel}
    </Button>
  )
  const form = (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onSubmit()
      }}
    >
      {children}
      <FormError message={error} />
      {alert ? (
        <AlertDialogFooter>
          <AlertDialogCancel>{cancelLabel}</AlertDialogCancel>
          {submitButton}
        </AlertDialogFooter>
      ) : (
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>{cancelLabel}</DialogClose>
          {submitButton}
        </DialogFooter>
      )}
    </form>
  )

  if (alert) {
    return (
      <AlertDialog
        open={open}
        onOpenChange={onOpenChange}
        onOpenChangeComplete={onOpenChangeComplete}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
          </AlertDialogHeader>
          {form}
        </AlertDialogContent>
      </AlertDialog>
    )
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={onOpenChangeComplete}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {form}
      </DialogContent>
    </Dialog>
  )
}
