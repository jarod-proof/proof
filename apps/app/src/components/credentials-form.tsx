import { useForm } from "@tanstack/react-form"
import { useId } from "react"
import { z } from "zod"

import { Button } from "@proof/ui/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@proof/ui/components/ui/field"
import { Input } from "@proof/ui/components/ui/input"

import { fieldMessage } from "../lib/messages"
import { ErrorAlert } from "./auth-card"

export interface CredentialValues {
  name: string
  email: string
  password: string
}

/** Sign-up asks for a name and at least 8 password characters; sign-in only needs both filled. */
function rules(signUp: boolean) {
  return {
    name: z.string().trim().min(1, "Enter your name."),
    email: signUp
      ? z.string().trim().email("Enter a valid email address.")
      : z.string().trim().min(1, "Enter your email address first."),
    password: signUp
      ? z.string().min(8, "Use at least 8 characters.")
      : z.string().min(1, "Enter your password."),
  }
}

/**
 * Email and password, with a name for sign-up. Stateless: the page owns pending and error state and
 * decides what happens after a successful submit.
 */
export function CredentialsForm({
  mode,
  pending,
  error,
  defaultEmail = "",
  lockEmail = false,
  submitLabel,
  onSubmit,
}: {
  mode: "sign-in" | "sign-up"
  pending: boolean
  error: string | null
  defaultEmail?: string
  /** The address is fixed to `defaultEmail` (an invitation names who it is for). */
  lockEmail?: boolean
  submitLabel: string
  onSubmit: (values: CredentialValues) => void
}) {
  const id = useId()
  const signUp = mode === "sign-up"
  const check = rules(signUp)

  const form = useForm({
    defaultValues: { name: "", email: defaultEmail, password: "" } as CredentialValues,
    onSubmit: ({ value }) => {
      onSubmit({
        name: value.name,
        email: value.email,
        password: value.password,
      })
    },
  })

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void form.handleSubmit()
      }}
    >
      <FieldGroup>
        {signUp ? (
          <form.Field name="name" validators={{ onSubmit: check.name }}>
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
                <Input
                  id={`${id}-name`}
                  name="name"
                  autoComplete="name"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.currentTarget.value)}
                  onBlur={field.handleBlur}
                  aria-invalid={field.state.meta.errors.length > 0 || undefined}
                  required
                  disabled={pending}
                />
                {field.state.meta.errors.length > 0 ? (
                  <FieldError>{fieldMessage(field.state.meta.errors)}</FieldError>
                ) : null}
              </Field>
            )}
          </form.Field>
        ) : null}
        <form.Field name="email" validators={{ onSubmit: check.email }}>
          {(field) => (
            <Field>
              <FieldLabel htmlFor={`${id}-email`}>Email</FieldLabel>
              <Input
                id={`${id}-email`}
                name="email"
                type="email"
                autoComplete="email"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.currentTarget.value)}
                onBlur={field.handleBlur}
                aria-invalid={field.state.meta.errors.length > 0 || undefined}
                required
                readOnly={lockEmail}
                disabled={pending}
              />
              {field.state.meta.errors.length > 0 ? (
                <FieldError>{fieldMessage(field.state.meta.errors)}</FieldError>
              ) : null}
            </Field>
          )}
        </form.Field>
        <form.Field name="password" validators={{ onSubmit: check.password }}>
          {(field) => (
            <Field>
              <FieldLabel htmlFor={`${id}-password`}>Password</FieldLabel>
              <Input
                id={`${id}-password`}
                name="password"
                type="password"
                autoComplete={signUp ? "new-password" : "current-password"}
                value={field.state.value}
                onChange={(event) => field.handleChange(event.currentTarget.value)}
                onBlur={field.handleBlur}
                aria-invalid={field.state.meta.errors.length > 0 || undefined}
                minLength={signUp ? 8 : undefined}
                required
                disabled={pending}
                aria-describedby={signUp ? `${id}-password-hint` : undefined}
              />
              {field.state.meta.errors.length > 0 ? (
                <FieldError>{fieldMessage(field.state.meta.errors)}</FieldError>
              ) : null}
              {signUp ? (
                <FieldDescription id={`${id}-password-hint`}>
                  Use at least 8 characters.
                </FieldDescription>
              ) : null}
            </Field>
          )}
        </form.Field>
        <ErrorAlert message={error} />
        <Button type="submit" disabled={pending}>
          {pending ? "Please wait" : submitLabel}
        </Button>
      </FieldGroup>
    </form>
  )
}
