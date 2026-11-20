import { FieldIssues, invalidOf } from "../components/form"
import { useForm } from "@tanstack/react-form"
import {} from "@tanstack/react-virtual"
import { useId, useState } from "react"
import {} from "cn"
import { z } from "zod"

import {} from "@proof/ui/components/ui/badge"
import { Button } from "@proof/ui/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@proof/ui/components/ui/field"
import { Input } from "@proof/ui/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@proof/ui/components/ui/native-select"
import {} from "@proof/ui/dplus/shell/settings-header"
import {} from "@proof/ui/dplus/shell/view-only-notice"

import { ASSIGNABLE_ROLES, type AssignableRole, parseInviteEmails } from "../lib/members"
import {} from "../components/confirm-dialog"
import { messageOf } from "../lib/messages"
import { ROLE_LABEL } from "../lib/roles"

/** A member as the table shows them. Security fields are undefined when the caller can't see them. */
import type { InviteOutcome } from "./members-page"

export const schema = z.object({
  emails: z.string().superRefine((value, ctx) => {
    const { emails, invalid } = parseInviteEmails(value)
    if (invalid.length > 0) {
      ctx.addIssue({ code: "custom", message: `Check these addresses: ${invalid.join(", ")}` })
    } else if (emails.length === 0) {
      ctx.addIssue({ code: "custom", message: "Enter at least one email address." })
    }
  }),
  role: z.enum(ASSIGNABLE_ROLES),
})

export type InviteValues = z.infer<typeof schema>

export function InviteForm({
  emailsId,
  roleId,
  defaultRole,
  failures,
  onInvite,
}: {
  emailsId: string
  roleId: string
  defaultRole: AssignableRole
  failures: InviteOutcome["failed"]
  onInvite: (emails: string[], role: AssignableRole) => Promise<InviteOutcome>
}) {
  const emailsHelpId = useId()
  const [serverError, setServerError] = useState<string | null>(null)
  const form = useForm({
    defaultValues: { emails: "", role: defaultRole } as InviteValues,
    validators: { onChange: schema },
    onSubmit: async ({ value }) => {
      setServerError(null)
      const { emails } = parseInviteEmails(value.emails)
      try {
        const outcome = await onInvite(emails, value.role)
        if (outcome.failed.length === 0) form.reset()
      } catch (caught) {
        setServerError(messageOf(caught))
      }
    },
  })

  return (
    <form
      noValidate
      aria-label="Invite members"
      className="grid gap-y-1 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end sm:gap-x-2.5"
      onSubmit={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void form.handleSubmit()
      }}
    >
      {/* On the board the inputs and the button share one bottom edge. The email help and error
          sit under the email input: below the row when wide, before Role on a phone. */}
      <form.Field name="emails">
        {(field) => (
          <Field className="min-w-0">
            <FieldLabel htmlFor={emailsId}>Invite by email</FieldLabel>
            <Input
              id={emailsId}
              name="emails"
              value={field.state.value}
              placeholder="name@company.com, another@company.com"
              aria-describedby={emailsHelpId}
              aria-invalid={invalidOf(field)}
              onChange={(event) => field.handleChange(event.currentTarget.value)}
              onBlur={field.handleBlur}
            />
            <FieldIssues field={field} />
          </Field>
        )}
      </form.Field>
      <FieldDescription id={emailsHelpId} className="sm:col-start-1">
        Separate addresses with commas.
      </FieldDescription>
      <form.Subscribe selector={(state) => state.fieldMeta.emails?.errors ?? []}>
        {(errors) =>
          errors.length > 0 ? (
            <FieldError className="sm:col-start-1">{messageOf(errors)}</FieldError>
          ) : null
        }
      </form.Subscribe>
      <form.Field name="role">
        {(field) => (
          <Field className="max-sm:mt-2 sm:col-start-2 sm:row-start-1">
            <FieldLabel htmlFor={roleId}>Role</FieldLabel>
            <NativeSelect
              id={roleId}
              name="role"
              value={field.state.value}
              onChange={(event) => field.handleChange(event.currentTarget.value as AssignableRole)}
              onBlur={field.handleBlur}
            >
              {ASSIGNABLE_ROLES.map((role) => (
                <NativeSelectOption key={role} value={role}>
                  {ROLE_LABEL[role]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        )}
      </form.Field>
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(isSubmitting) => (
          <Button
            type="submit"
            className="min-h-11 px-4.5 font-bold max-sm:mt-2.5 sm:col-start-3 sm:row-start-1"
            disabled={isSubmitting}
          >
            {isSubmitting ? "Sending…" : "Send invites"}
          </Button>
        )}
      </form.Subscribe>
      {serverError || failures.length > 0 ? (
        <div role="alert" className="text-sm text-destructive sm:col-span-3">
          {serverError ? <p>{serverError}</p> : null}
          {failures.map((failure) => (
            <p key={failure.email}>
              {failure.email}: {failure.message}
            </p>
          ))}
        </div>
      ) : null}
    </form>
  )
}
