import { FieldIssues, invalidOf } from "../components/form"
import { useForm } from "@tanstack/react-form"
import { useEffect, useId, useState } from "react"
import { z } from "zod"

import {
  PASSWORD_COMPROMISED_CODE,
  PASSWORD_COMPROMISED_MESSAGE,
  type SignInMethods,
  type SocialProvider,
} from "@proof/auth/client"
import { Button } from "@proof/ui/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@proof/ui/components/ui/field"
import { Input } from "@proof/ui/components/ui/input"

import { AuthCard, ErrorAlert } from "../components/auth-card"
import { messageOf } from "../lib/messages"
import { navigateTo } from "../lib/navigation"
import { PASSWORD_ONLY_METHODS, type WebAuth } from "../lib/web-auth"

const SOCIAL_LABEL: Record<SocialProvider, string> = { github: "GitHub", google: "Google" }

/** The "Last used" badge: the method the person last signed in with. */
function LastUsed() {
  return (
    <span className="absolute right-2 rounded-sm bg-solar px-1.5 text-xs font-extrabold text-solar-foreground">
      Last used
    </span>
  )
}

/** Where a social, SSO or link sign-in returns. With an OAuth query, that's the page itself (it resumes). */
function returnTarget(next: string, page: string): string {
  const { origin, search } = window.location
  return new URLSearchParams(search).has("client_id")
    ? `${origin}${page}${search}`
    : `${origin}${next}`
}

/** After a passkey sign-in (no server URL comes back): resume a pending OAuth flow, else go to `next`. */
async function afterPasskey(auth: WebAuth, next: string): Promise<string> {
  if (!new URLSearchParams(window.location.search).has("client_id")) return next
  return (await auth.continueOAuth()) ?? next
}

/**
 * Messages for the codes the server sends back on the sign-in page. A change-of-email link opened
 * while signed out is sent here (account-plugin.ts) with the link to resume after sign-in.
 */
const LINK_ERRORS: Record<string, string> = {
  SIGN_IN_TO_CONFIRM_EMAIL_CHANGE:
    "Sign in to the account this email change is for, then open the confirmation link again.",
}

function linkErrorFromUrl(): string | null {
  const code = new URLSearchParams(window.location.search).get("error")
  return code ? (LINK_ERRORS[code] ?? null) : null
}

const EMAIL_REQUIRED = "Enter your email address first."
const emailRule = z.string().trim().min(1, EMAIL_REQUIRED)
const passwordRule = z.string().min(1, "Enter your password.")
const emailValidators = { onSubmit: emailRule }
const passwordValidators = { onSubmit: passwordRule }

/** Sign in. The methods come from the server (GET /api/auth/sign-in-methods); until they load, email only. */
export function SignInPage({
  auth,
  next,
  signUpHref,
}: {
  auth: WebAuth
  next: string
  signUpHref: string
}) {
  const id = useId()
  const [methods, setMethods] = useState<SignInMethods>(PASSWORD_ONLY_METHODS)
  const [lastUsed, setLastUsed] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(linkErrorFromUrl)
  const [sentTo, setSentTo] = useState<string | null>(null)
  // "Forgot password?": a reset-request card in place of the sign-in card (no new route).
  const [forgot, setForgot] = useState(false)
  const [resetSentTo, setResetSentTo] = useState<string | null>(null)

  const form = useForm({
    defaultValues: { email: "", password: "" },
    onSubmit: async ({ value }) => {
      if (!methods.password) return
      await attempt(async () => {
        navigateTo((await auth.signIn({ email: value.email, password: value.password })) ?? next)
      })
    },
  })

  useEffect(() => {
    let live = true
    setLastUsed(auth.lastUsedMethod?.() ?? null)
    void (async () => {
      try {
        const loaded = await auth.signInMethods?.()
        if (live && loaded) setMethods(loaded)
      } catch {
        // Keep email and password: the page still works without the list.
      }
    })()
    return () => {
      live = false
    }
  }, [auth])

  // A social sign-in returns here with the OAuth query still on the URL and a session now: resume it.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("client_id")) return
    let live = true
    void (async () => {
      try {
        if (!(await auth.getSession())) return
        const url = await auth.continueOAuth()
        if (live && url) navigateTo(url)
      } catch {
        // Nothing pending: stay on the sign-in page.
      }
    })()
    return () => {
      live = false
    }
  }, [auth])

  async function attempt(work: () => Promise<void>) {
    setPending(true)
    setError(null)
    try {
      await work()
    } catch (caught) {
      setError(messageOf(caught))
      setPending(false)
    }
  }

  /** Validates the email field (its error shows under the field) and returns the trimmed address. */
  async function checkEmail(): Promise<string | null> {
    const errors = await form.validateField("email", "submit")
    return errors.length > 0 ? null : form.getFieldValue("email").trim()
  }

  async function sendReset() {
    const address = await checkEmail()
    if (!address) return
    void attempt(async () => {
      await auth.requestPasswordReset?.({
        email: address,
        redirectTo: `${window.location.origin}/reset-password`,
      })
      setPending(false)
      setResetSentTo(address)
    })
  }

  async function sendMagicLink() {
    const address = await checkEmail()
    if (!address) return
    void attempt(async () => {
      await auth.sendMagicLink?.({
        email: address,
        callbackURL: returnTarget(next, "/sign-in"),
      })
      setPending(false)
      setSentTo(address)
    })
  }

  async function sendSso() {
    const address = await checkEmail()
    if (!address) return
    void attempt(
      () => auth.signInWithSso?.(address, returnTarget(next, "/sign-in")) ?? Promise.resolve(),
    )
  }

  if (forgot) {
    return (
      <AuthCard
        title={resetSentTo ? "Check your email" : "Forgot password?"}
        description={
          resetSentTo
            ? `If an account exists for ${resetSentTo}, we sent a reset link. The link opens the page to choose a new password.`
            : "Enter your email and we will send a link to choose a new password."
        }
        footer={
          <button
            type="button"
            className="underline underline-offset-4"
            onClick={() => {
              setForgot(false)
              setResetSentTo(null)
              setError(null)
            }}
          >
            Back to sign in
          </button>
        }
      >
        {resetSentTo ? null : (
          <form
            noValidate
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void sendReset()
            }}
          >
            <FieldGroup>
              <form.Field name="email" validators={emailValidators}>
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor={`${id}-reset-email`}>Email</FieldLabel>
                    <Input
                      id={`${id}-reset-email`}
                      name="email"
                      type="email"
                      autoComplete="email"
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
              <Button type="submit" size="lg" className="h-12 w-full" disabled={pending}>
                {pending ? "Please wait" : "Send reset link"}
              </Button>
            </FieldGroup>
          </form>
        )}
      </AuthCard>
    )
  }

  if (sentTo) {
    return (
      <AuthCard
        title="Check your email"
        description={`We sent a sign-in link to ${sentTo}. Open the link in that email to sign in.`}
        footer={
          <button
            type="button"
            className="underline underline-offset-4"
            onClick={() => {
              setSentTo(null)
              setError(null)
            }}
          >
            Use a different email
          </button>
        }
      />
    )
  }

  const hasPasskeyRow = methods.passkey || methods.social.length > 0
  const hasEmailRow = methods.password || methods.magicLink || methods.sso

  return (
    <AuthCard
      title="Sign in"
      description="Sign in to manage your organization and the agents connected to it."
      footer={
        <p>
          New here?{" "}
          <a
            href={signUpHref}
            className="font-semibold text-foreground underline underline-offset-4"
          >
            Create an account
          </a>
        </p>
      }
    >
      <div className="flex flex-col gap-3">
        {methods.passkey ? (
          <Button
            type="button"
            size="lg"
            className="relative h-12 w-full"
            disabled={pending}
            onClick={() =>
              void attempt(async () => {
                await auth.signInWithPasskey?.()
                navigateTo(await afterPasskey(auth, next))
              })
            }
          >
            Sign in with passkey
            {lastUsed === "passkey" ? <LastUsed /> : null}
          </Button>
        ) : null}
        {methods.social.map((provider) => (
          <Button
            key={provider}
            type="button"
            variant="outline"
            size="lg"
            className="relative h-11 w-full"
            disabled={pending}
            onClick={() =>
              void attempt(
                () =>
                  auth.signInWithSocial?.(provider, returnTarget(next, "/sign-in")) ??
                  Promise.resolve(),
              )
            }
          >
            Continue with {SOCIAL_LABEL[provider]}
            {lastUsed === provider ? <LastUsed /> : null}
          </Button>
        ))}
        {hasPasskeyRow && hasEmailRow ? (
          <div className="flex items-center gap-2.5 text-[13px] text-muted-foreground">
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
            or use email
            <span className="h-px flex-1 bg-border" aria-hidden="true" />
          </div>
        ) : null}
        <form
          noValidate
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            event.stopPropagation()
            void form.handleSubmit()
          }}
        >
          <FieldGroup>
            <form.Field name="email" validators={emailValidators}>
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
                    aria-invalid={invalidOf(field)}
                    required
                    disabled={pending}
                  />
                  <FieldIssues field={field} />
                </Field>
              )}
            </form.Field>
            {methods.password ? (
              <form.Field name="password" validators={passwordValidators}>
                {(field) => (
                  <Field>
                    <div className="flex items-baseline justify-between gap-2">
                      <FieldLabel htmlFor={`${id}-password`}>Password</FieldLabel>
                      {auth.requestPasswordReset ? (
                        <button
                          type="button"
                          className="text-sm text-foreground underline underline-offset-4"
                          disabled={pending}
                          onClick={() => {
                            setError(null)
                            setForgot(true)
                          }}
                        >
                          Forgot password?
                        </button>
                      ) : null}
                    </div>
                    <Input
                      id={`${id}-password`}
                      name="password"
                      type="password"
                      autoComplete="current-password"
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
            ) : null}
            <ErrorAlert message={error} />
            {methods.password ? (
              // One filled button per card: the passkey when it's offered (the board), else this one.
              // An outline one is the 44px size of the other ways to sign in below it.
              <Button
                type="submit"
                size={methods.passkey ? "default" : "lg"}
                variant={methods.passkey ? "outline" : "default"}
                className="w-full"
                disabled={pending}
              >
                {pending ? "Please wait" : "Sign in with email"}
              </Button>
            ) : null}
          </FieldGroup>
        </form>
        {methods.magicLink ? (
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full"
            disabled={pending}
            onClick={() => void sendMagicLink()}
          >
            Email me a sign-in link
          </Button>
        ) : null}
        {methods.sso ? (
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full"
            disabled={pending}
            onClick={() => void sendSso()}
          >
            Sign in with SSO
          </Button>
        ) : null}
      </div>
    </AuthCard>
  )
}

const signUpSchema = z.object({
  name: z.string().trim().min(1, "Enter your name."),
  email: z.email("Enter a valid email address."),
  password: z.string().min(8, "Use at least 8 characters."),
})

/** The name and email a passkey sign-up needs before the browser's passkey prompt. */
const passkeyIdentitySchema = z.object({
  name: z.string().trim().min(1, "Enter your name."),
  email: z.email("Enter a valid email address."),
})

/**
 * Create an account. Signing up also signs the new user in and creates their personal organization.
 * `onPasskeySignUp` (from the sign-up container) makes the account with a passkey instead of a
 * password; the button shows only when the server offers passkeys and the callback is given.
 */
export function SignUpPage({
  auth,
  next,
  signInHref,
  onPasskeySignUp,
}: {
  auth: WebAuth
  next: string
  signInHref: string
  /** Emails the sign-up link (see lib/passkey-signup.ts). Resolves once the link is sent. */
  onPasskeySignUp?: (values: { name: string; email: string }) => Promise<void>
}) {
  const id = useId()
  const [methods, setMethods] = useState<SignInMethods>(PASSWORD_ONLY_METHODS)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [breached, setBreached] = useState(false)
  const [linkSentTo, setLinkSentTo] = useState<string | null>(null)

  /** As the sign-in page's social buttons: pending during the redirect, and any error shown. */
  async function socialSignUp(provider: SocialProvider) {
    setPending(true)
    setError(null)
    try {
      await (auth.signInWithSocial?.(provider, returnTarget(next, "/sign-in")) ?? Promise.resolve())
    } catch (caught) {
      setError(messageOf(caught))
      setPending(false)
    }
  }

  const form = useForm({
    defaultValues: { name: "", email: "", password: "" },
    validators: { onSubmit: signUpSchema },
    onSubmit: async ({ value }) => {
      setPending(true)
      setError(null)
      setBreached(false)
      try {
        navigateTo(
          (await auth.signUp({
            name: value.name,
            email: value.email,
            password: value.password,
          })) ?? next,
        )
      } catch (caught) {
        // A breached password is a field error, not a general failure: it names the password field.
        if (isPasswordCompromised(caught)) setBreached(true)
        else setError(messageOf(caught))
        setPending(false)
      }
    },
  })

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const loaded = await auth.signInMethods?.()
        if (live && loaded) setMethods(loaded)
      } catch {
        // Email and password only.
      }
    })()
    return () => {
      live = false
    }
  }, [auth])

  /** The passkey button: name and email are checked here (the password isn't asked for), then the prompt. */
  async function passkeySignUp() {
    const values = form.state.values
    const checked = passkeyIdentitySchema.safeParse({ name: values.name, email: values.email })
    if (!checked.success || !onPasskeySignUp) {
      setError(checked.error?.issues[0]?.message ?? "Enter your name and email first.")
      return
    }
    setPending(true)
    setError(null)
    setBreached(false)
    try {
      await onPasskeySignUp(checked.data)
      // The link is the next step: nothing is signed in until it is opened.
      setLinkSentTo(checked.data.email)
      setPending(false)
    } catch (caught) {
      setError(messageOf(caught))
      setPending(false)
    }
  }

  const passwordHelp = `${id}-password-help`
  const passwordError = `${id}-password-error`

  return (
    <AuthCard
      title="Create your account"
      description="You get a personal organization. You can invite others later."
      footer={
        <p>
          Already have an account?{" "}
          <a
            href={signInHref}
            className="font-semibold text-foreground underline underline-offset-4"
          >
            Sign in
          </a>
        </p>
      }
    >
      <form
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          event.stopPropagation()
          void form.handleSubmit()
        }}
      >
        <FieldGroup>
          <form.Field name="name">
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
                  aria-invalid={invalidOf(field)}
                  required
                  disabled={pending}
                />
                <FieldIssues field={field} />
              </Field>
            )}
          </form.Field>
          <form.Field name="email">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${id}-email`}>Work email</FieldLabel>
                <Input
                  id={`${id}-email`}
                  name="email"
                  type="email"
                  autoComplete="email"
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
          <form.Field name="password">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${id}-password`}>Password</FieldLabel>
                <Input
                  id={`${id}-password`}
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.currentTarget.value)}
                  onBlur={field.handleBlur}
                  minLength={8}
                  required
                  disabled={pending}
                  aria-invalid={breached || invalidOf(field) || undefined}
                  aria-describedby={breached ? `${passwordHelp} ${passwordError}` : passwordHelp}
                  className={breached ? "border-2 border-destructive" : undefined}
                />
                {breached ? (
                  <p
                    id={passwordError}
                    role="alert"
                    className="flex items-start gap-2 text-sm font-semibold text-destructive"
                  >
                    <span aria-hidden="true" className="mt-0.5">
                      ⊘
                    </span>
                    <span>{PASSWORD_COMPROMISED_MESSAGE}</span>
                  </p>
                ) : null}
                <FieldIssues field={field} hidden={breached} />
                <FieldDescription id={passwordHelp}>
                  Use at least 8 characters. Checked privately with Have I Been Pwned. Your password
                  is never sent.
                </FieldDescription>
              </Field>
            )}
          </form.Field>
          <ErrorAlert message={error} />
          <Button type="submit" size="lg" className="h-12 w-full" disabled={pending}>
            {pending ? "Please wait" : "Create account"}
          </Button>
        </FieldGroup>
      </form>
      {methods.passkey && onPasskeySignUp ? (
        <Button
          type="button"
          variant="outline"
          className="h-11 w-full text-sm"
          disabled={pending}
          onClick={() => void passkeySignUp()}
        >
          Sign up with a passkey
        </Button>
      ) : null}
      {linkSentTo ? (
        <output className="block text-sm text-muted-foreground">
          We sent a link to {linkSentTo}. Open it on this device to create your passkey.
        </output>
      ) : null}
      {methods.social.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            {methods.social.map((provider) => (
              <Button
                key={provider}
                type="button"
                variant="outline"
                className="h-11 flex-1 text-sm"
                disabled={pending}
                onClick={() => void socialSignUp(provider)}
              >
                {SOCIAL_LABEL[provider]}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      <p className="text-[13px] text-muted-foreground">
        By continuing you agree to the{" "}
        <a href="[PLACEHOLDER]" className="text-foreground underline underline-offset-4">
          Terms
        </a>{" "}
        and{" "}
        <a href="[PLACEHOLDER]" className="text-foreground underline underline-offset-4">
          Privacy Policy
        </a>
        .
      </p>
    </AuthCard>
  )
}

/** The server refused the password as breached (the haveIBeenPwned plugin's code). */
export function isPasswordCompromised(caught: unknown): boolean {
  if ((caught as { code?: string } | null)?.code === PASSWORD_COMPROMISED_CODE) return true
  return messageOf(caught) === PASSWORD_COMPROMISED_MESSAGE
}
