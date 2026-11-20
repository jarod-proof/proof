import { useState } from "react"

import { Button } from "@proof/ui/components/ui/button"

import type { WebAuth } from "../lib/web-auth"
import { messageOf } from "../lib/messages"
import { type CredentialValues, CredentialsForm } from "./credentials-form"

/**
 * Signs the person in or up in place, for pages that need a session but are not an OAuth step (the
 * invitation and device pages). The caller reloads its own state once `onSignedIn` fires.
 *
 * `email` fixes the address (an invitation is for one), and `initialMode` opens on sign-up for
 * someone known to have no account yet.
 */
export function SignInOrUp({
  auth,
  hint,
  email,
  initialMode = "sign-in",
  onSignedIn,
}: {
  auth: WebAuth
  hint: string
  email?: string
  initialMode?: "sign-in" | "sign-up"
  onSignedIn: () => void
}) {
  const [mode, setMode] = useState<"sign-in" | "sign-up">(initialMode)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(values: CredentialValues) {
    setPending(true)
    setError(null)
    try {
      if (mode === "sign-in") {
        await auth.signIn({ email: values.email, password: values.password })
      } else {
        await auth.signUp({ name: values.name, email: values.email, password: values.password })
      }
      setPending(false)
      onSignedIn()
    } catch (caught) {
      setError(messageOf(caught))
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{hint}</p>
      <fieldset className="flex gap-2">
        <legend className="sr-only">Sign in or create an account</legend>
        <Button
          type="button"
          size="sm"
          variant={mode === "sign-in" ? "default" : "outline"}
          aria-pressed={mode === "sign-in"}
          onClick={() => setMode("sign-in")}
        >
          I have an account
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mode === "sign-up" ? "default" : "outline"}
          aria-pressed={mode === "sign-up"}
          onClick={() => setMode("sign-up")}
        >
          Create an account
        </Button>
      </fieldset>
      <CredentialsForm
        mode={mode}
        pending={pending}
        error={error}
        defaultEmail={email}
        lockEmail={email !== undefined}
        submitLabel={mode === "sign-in" ? "Sign in" : "Create account"}
        onSubmit={submit}
      />
    </div>
  )
}
