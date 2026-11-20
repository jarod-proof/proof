import { FieldIssues, invalidOf } from "../components/form"
import { useForm } from "@tanstack/react-form"
import { useEffect, useId, useState } from "react"
import { z } from "zod"

import type { SignInMethods } from "@proof/auth/client"
import { Button } from "@proof/ui/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@proof/ui/components/ui/field"
import { Input } from "@proof/ui/components/ui/input"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@proof/ui/components/ui/input-otp"

import { AuthCard, ErrorAlert } from "../components/auth-card"
import { type AccountApi, accountErrorMessage } from "../lib/account-api"
import {} from "../lib/messages"
import { navigateTo } from "../lib/navigation"

export interface TwoFactorPageProps {
  /** Where to go once the second step passes, when nothing else applies. */
  next: string
  /** A link's callbackURL (a magic link with two-factor): the authorization it was headed to, if any. */
  callbackURL?: string
  signIn: Pick<AccountApi, "completeSignInWithCode" | "completeSignInWithBackupCode">
  /** Resumes a pending OAuth authorization on this page's signed query (POST /oauth2/continue). */
  continueOAuth: () => Promise<string | undefined>
  /** The server's sign-in methods, to offer "Use a passkey instead" when passkeys are on. */
  methods?: () => Promise<SignInMethods | undefined>
  /** Passkey sign-in (the browser's WebAuthn prompt). Offered only when `methods` says passkeys are on. */
  signInWithPasskey?: () => Promise<void>
}

/**
 * The callbackURL when it is this site (a path, or an absolute URL on this origin). Anything else is
 * refused, so the page cannot be used to send someone to another site.
 */
export function sameSiteCallback(value: string | undefined, origin: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value, origin)
    return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : undefined
  } catch {
    return undefined
  }
}

const CODE_LENGTH = 6

/**
 * The second step of a password sign-in (the twoFactor plugin redirects here with the sign-in's
 * query kept). An app code (six slots; pasting the whole code works), or a backup code.
 */
export function TwoFactorPage({
  next,
  callbackURL,
  signIn,
  continueOAuth,
  methods,
  signInWithPasskey,
}: TwoFactorPageProps) {
  const id = useId()
  const [useBackup, setUseBackup] = useState(false)
  const [passkeyOffered, setPasskeyOffered] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const form = useForm({
    defaultValues: { code: "", trustDevice: true },
    onSubmit: async ({ value }) => {
      await complete(value.code.trim(), value.trustDevice)
    },
  })

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const loaded = await methods?.()
        if (live && loaded?.passkey) setPasskeyOffered(true)
      } catch {
        // No list: no passkey link.
      }
    })()
    return () => {
      live = false
    }
  }, [methods])

  // Where a passed code goes: the server's continuation, then a magic link's authorization, then an
  // OAuth authorization this page's signed query carries, then the page the sign-in was for.
  async function resumeTarget(): Promise<string> {
    const origin = window.location.origin
    const linked = sameSiteCallback(callbackURL, origin)
    if (linked) return linked
    if (new URLSearchParams(window.location.search).has("client_id")) {
      const resumed = await continueOAuth()
      if (resumed) return resumed
    }
    return next
  }

  async function complete(value: string, trustDevice: boolean) {
    setPending(true)
    setError(null)
    try {
      const url = useBackup
        ? await signIn.completeSignInWithBackupCode(value)
        : await signIn.completeSignInWithCode(value, trustDevice)
      navigateTo(url ?? (await resumeTarget()))
    } catch (caught) {
      setError(accountErrorMessage(caught))
      setPending(false)
    }
  }

  async function passkey() {
    setPending(true)
    setError(null)
    try {
      await signInWithPasskey?.()
      navigateTo(
        new URLSearchParams(window.location.search).has("client_id")
          ? ((await continueOAuth()) ?? next)
          : next,
      )
    } catch (caught) {
      setError(accountErrorMessage(caught))
      setPending(false)
    }
  }

  return (
    <AuthCard
      title="Two-factor verification"
      description={
        useBackup
          ? "Enter one of the backup codes you saved. Each code works once."
          : "Enter the 6-digit code from your authenticator app."
      }
      footer={
        <div className="flex flex-col gap-2 text-sm">
          <button
            type="button"
            className="text-left text-foreground underline underline-offset-4"
            onClick={() => {
              setError(null)
              form.resetField("code")
              setUseBackup((value) => !value)
            }}
          >
            {useBackup ? "Use an app code instead" : "Use a backup code instead"}
          </button>
          {passkeyOffered ? (
            <button
              type="button"
              className="text-left text-foreground underline underline-offset-4"
              disabled={pending}
              onClick={() => void passkey()}
            >
              Use a passkey instead
            </button>
          ) : null}
          <p className="pt-2 text-[13px]">
            Lost your authenticator and backup codes? An organization owner can reset two-factor for
            you.
          </p>
        </div>
      }
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          event.stopPropagation()
          void form.handleSubmit()
        }}
      >
        <FieldGroup>
          <form.Field
            name="code"
            validators={{
              onSubmit: z
                .string()
                .trim()
                .min(
                  1,
                  useBackup ? "Enter a backup code." : "Enter the six-digit code from your app.",
                ),
            }}
          >
            {(field) => {
              const invalid = invalidOf(field)
              return (
                <Field>
                  {useBackup ? (
                    <>
                      <FieldLabel htmlFor={id}>Backup code</FieldLabel>
                      <Input
                        id={id}
                        name="code"
                        autoComplete="one-time-code"
                        inputMode="text"
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.currentTarget.value)}
                        onBlur={field.handleBlur}
                        aria-invalid={invalid || undefined}
                        disabled={pending}
                        required
                      />
                      <FieldDescription>Codes look like xxxxx-xxxxx.</FieldDescription>
                    </>
                  ) : (
                    <>
                      <FieldLabel htmlFor={id}>Code</FieldLabel>
                      <InputOTP
                        id={id}
                        name="code"
                        maxLength={CODE_LENGTH}
                        autoComplete="one-time-code"
                        inputMode="numeric"
                        value={field.state.value}
                        onChange={(next) => field.handleChange(next)}
                        onBlur={field.handleBlur}
                        disabled={pending}
                        containerClassName="justify-between"
                        aria-invalid={invalid || undefined}
                        aria-describedby={`${id}-help`}
                      >
                        <InputOTPGroup className="w-full justify-between gap-2">
                          {Array.from({ length: CODE_LENGTH }, (_, index) => (
                            <InputOTPSlot
                              key={index}
                              index={index}
                              className="h-14 w-full rounded-lg border-[1.5px] text-[22px] font-bold"
                            />
                          ))}
                        </InputOTPGroup>
                      </InputOTP>
                      <FieldDescription id={`${id}-help`}>
                        Pasting the whole code works too. The code changes every 30 seconds.
                      </FieldDescription>
                    </>
                  )}
                  <FieldIssues field={field} />
                </Field>
              )
            }}
          </form.Field>
          {useBackup ? null : (
            <form.Field name="trustDevice">
              {(field) => (
                <label className="flex min-h-11 items-center gap-2.5 text-[14.5px]">
                  <input
                    type="checkbox"
                    className="size-5 accent-foreground"
                    checked={field.state.value}
                    onChange={(event) => field.handleChange(event.currentTarget.checked)}
                    onBlur={field.handleBlur}
                    disabled={pending}
                  />
                  Trust this device for 30 days
                </label>
              )}
            </form.Field>
          )}
          <ErrorAlert message={error} />
          <Button type="submit" size="lg" className="h-12 w-full" disabled={pending}>
            {pending ? "Checking…" : "Verify"}
          </Button>
        </FieldGroup>
      </form>
    </AuthCard>
  )
}
