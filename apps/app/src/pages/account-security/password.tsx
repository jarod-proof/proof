import {} from "@tanstack/react-form"
import { useId, useState } from "react"
import { z } from "zod"

import { Button } from "@proof/ui/components/ui/button"
import {} from "@proof/ui/components/ui/input"

import { relativeTime } from "../../lib/account-format"

// The sections of the Security page (board Security). Each takes its data and callbacks as props.
// Errors a call throws are shown in the section; the container has already mapped their copy.

import { useAction } from "./shared"
import { FormDialog, useAppForm } from "../../components/form"

// ---- Password -------------------------------------------------------------------------------------

export interface PasswordSectionProps {
  hasPassword: boolean
  changedAt: string | Date | null
  onChange: (input: { currentPassword: string; newPassword: string }) => Promise<void>
}

export function PasswordSection({ hasPassword, changedAt, onChange }: PasswordSectionProps) {
  const headingId = useId()
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState(false)
  const changed = relativeTime(changedAt)
  return (
    <section aria-labelledby={headingId} className="flex items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 id={headingId} className="text-base font-bold">
          Password
        </h2>
        <span className="text-[13.5px] text-muted-foreground">
          {hasPassword
            ? `${changed ? `Changed ${changed}` : "Set"} · checked against Have I Been Pwned when you change it`
            : "No password on this account. Use Forgot password on the sign-in page to set one."}
        </span>
        {done ? (
          <output className="text-sm text-muted-foreground">Your password is changed.</output>
        ) : null}
      </div>
      <Button variant="outline" disabled={!hasPassword} onClick={() => setOpen(true)}>
        Change password
      </Button>
      <ChangePasswordDialog
        open={open}
        onOpenChange={(next) => {
          // Opening clears the last note. Closing after a change keeps it on the page.
          if (next) setDone(false)
          setOpen(next)
        }}
        onChange={async (input) => {
          await onChange(input)
          setDone(true)
        }}
      />
    </section>
  )
}

/** The new password must be 8+ characters and match its confirmation. */
const changePasswordSchema = z
  .object({
    current: z.string().min(1, "Enter your current password."),
    next: z.string().min(8, "The new password must be at least 8 characters long."),
    confirm: z.string(),
  })
  .refine((value) => value.next === value.confirm, {
    message: "The two passwords do not match.",
    path: ["confirm"],
  })

function ChangePasswordDialog({
  open,
  onOpenChange,
  onChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (input: { currentPassword: string; newPassword: string }) => Promise<void>
}) {
  const action = useAction(async (input: { currentPassword: string; newPassword: string }) => {
    await onChange(input)
  })
  const form = useAppForm({
    defaultValues: { current: "", next: "", confirm: "" },
    validators: { onSubmit: changePasswordSchema },
    onSubmit: async ({ value }) => {
      if (await action.call({ currentPassword: value.current, newPassword: value.next })) {
        onOpenChange(false)
      }
    },
  })
  // Once closed (after the exit animation), the dialog forgets what was typed and any error.
  const forget = () => {
    action.setError(null)
    form.reset()
  }
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(next) => {
        if (!next) forget()
      }}
      title="Change password"
      description="Checked against Have I Been Pwned. A password found in a known breach is refused."
      onSubmit={() => void form.handleSubmit()}
      submitLabel="Change password"
      pendingLabel="Changing…"
      pending={action.busy}
      error={action.error}
    >
      <form.AppField name="current">
        {(field) => (
          <field.PasswordField label="Current password" autoComplete="current-password" required />
        )}
      </form.AppField>
      <form.AppField name="next">
        {(field) => (
          <field.PasswordField
            label="New password"
            autoComplete="new-password"
            minLength={8}
            required
            description="Use at least 8 characters."
          />
        )}
      </form.AppField>
      <form.AppField name="confirm">
        {(field) => (
          <field.PasswordField label="Confirm new password" autoComplete="new-password" required />
        )}
      </form.AppField>
    </FormDialog>
  )
}
