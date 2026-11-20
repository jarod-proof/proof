import { useState } from "react"

import { Button } from "@proof/ui/components/ui/button"

import type { WebAuth } from "../lib/web-auth"
import { messageOf } from "../lib/messages"
import { ErrorAlert } from "./auth-card"

/**
 * For pages that act for the signed-in person: when this is not them (a shared computer, or the
 * invitation was sent to another address), they can sign out here and sign in as someone else.
 */
export function NotYou({ auth, onSignedOut }: { auth: WebAuth; onSignedOut: () => void }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function signOut() {
    setPending(true)
    setError(null)
    try {
      await auth.signOut()
      onSignedOut()
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <ErrorAlert message={error} />
      <p className="text-sm text-muted-foreground">
        Not you?{" "}
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-sm"
          disabled={pending}
          onClick={() => void signOut()}
        >
          Sign out and use another account
        </Button>
      </p>
    </div>
  )
}
