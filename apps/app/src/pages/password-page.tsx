import { FieldIssues, invalidOf } from "../components/form"
import { useForm } from "@tanstack/react-form"
import { useId, useState } from "react"
import { z } from "zod"

import { Button } from "@proof/ui/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@proof/ui/components/ui/field"
import { Input } from "@proof/ui/components/ui/input"

import { AuthCard, ErrorAlert } from "../components/auth-card"
import { messageOf } from "../lib/messages"
import type { WebAuth } from "../lib/web-auth"

const schema = z
  .object({
    password: z.string().min(8, "The new password must be at least 8 characters long."),
    confirm: z.string(),
  })
  .refine((value) => value.password === value.confirm, {
    message: "The two passwords do not match.",
    path: ["confirm"],
  })

/**
 * Sets a password from an emailed link. `reset` is a forgotten password; `claim` is the account an
 * agent created for the person (its claim email links here too, carrying a reset token).
 */
export function PasswordPage({
  auth,
  mode,
  token,
  linkError,
}: {
  auth: WebAuth
  mode: "reset" | "claim"
  token: string | undefined
  linkError?: string
}) {
  const id = useId()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const form = useForm({
    defaultValues: { password: "", confirm: "" },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      setPending(true)
      setError(null)
      try {
        await auth.resetPassword({ token: token ?? "", newPassword: value.password })
        setDone(true)
      } catch (caught) {
        setError(messageOf(caught))
      } finally {
        setPending(false)
      }
    },
  })

  const copy =
    mode === "claim"
      ? {
          title: "Claim your account",
          description:
            "An agent created this account for you. Set a password to claim it. Claiming turns off " +
            "the agent's temporary key; it reconnects by asking you to approve a sign-in.",
          submit: "Claim account",
          success: "Your account is claimed. Sign in with the password you just set.",
        }
      : {
          title: "Choose a new password",
          description: "Enter a new password for your account.",
          submit: "Set password",
          success: "Your password is set. Sign in with it.",
        }

  // better-auth sends an invalid or expired link back as `?error=INVALID_TOKEN` with no token, so
  // that check comes first; a missing token on its own means the link was cut short.
  let linkProblem: string | null = null
  if (linkError) {
    linkProblem = "This link is invalid or has expired. Ask for a new one."
  } else if (!token) {
    linkProblem = "This link is missing its token. Open the link from the email again."
  }
  if (linkProblem) {
    return (
      <AuthCard
        title={copy.title}
        footer={
          <a href="/sign-in" className="underline underline-offset-4">
            Back to sign in
          </a>
        }
      >
        <ErrorAlert message={linkProblem} />
      </AuthCard>
    )
  }

  if (done) {
    return (
      <AuthCard
        title={copy.title}
        description={copy.success}
        footer={
          <a href="/sign-in" className="underline underline-offset-4">
            Go to sign in
          </a>
        }
      />
    )
  }

  return (
    <AuthCard title={copy.title} description={copy.description}>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          event.stopPropagation()
          void form.handleSubmit()
        }}
      >
        <FieldGroup>
          <form.Field name="password">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${id}-password`}>New password</FieldLabel>
                <Input
                  id={`${id}-password`}
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.currentTarget.value)}
                  onBlur={field.handleBlur}
                  aria-invalid={invalidOf(field)}
                  minLength={8}
                  required
                  disabled={pending}
                  aria-describedby={`${id}-hint`}
                />
                <FieldDescription id={`${id}-hint`}>Use at least 8 characters.</FieldDescription>
                <FieldIssues field={field} />
              </Field>
            )}
          </form.Field>
          <form.Field name="confirm">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${id}-confirm`}>Confirm password</FieldLabel>
                <Input
                  id={`${id}-confirm`}
                  name="confirm"
                  type="password"
                  autoComplete="new-password"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.currentTarget.value)}
                  onBlur={field.handleBlur}
                  aria-invalid={invalidOf(field)}
                  required
                  disabled={pending}
                />
                <FieldIssues field={field} />
              </Field>
            )}
          </form.Field>
          <ErrorAlert message={error} />
          <Button type="submit" disabled={pending}>
            {pending ? "Please wait" : copy.submit}
          </Button>
        </FieldGroup>
      </form>
    </AuthCard>
  )
}
