import { useId, useRef, useState } from "react"

import { Button } from "@proof/ui/components/ui/button"

import { accountErrorMessage } from "../../lib/account-api"
import { ConfirmDialog } from "../../components/confirm-dialog"

// The sections of the Security page (board Security). Each takes its data and callbacks as props.
// Errors a call throws are shown in the section; the container has already mapped their copy.

import { ROW, TEXT, META } from "./shared"
import { FormError } from "../../components/form"

// ---- Sessions -------------------------------------------------------------------------------------

export interface SessionRow {
  token: string
  device: string
  method: string | null
  when: string
  current: boolean
}

export interface SessionsSectionProps {
  sessions: SessionRow[]
  /** The list needs a recent sign-in before it can be read. */
  needsSignIn: boolean
  /** Asks the person to confirm it's them, then reloads the list. Resolves when that is done. */
  onSignInAgain: () => Promise<void>
  onRevoke: (token: string) => Promise<void>
  onRevokeOthers: () => Promise<void>
}

export function SessionsSection({
  sessions,
  needsSignIn,
  onSignInAgain,
  onRevoke,
  onRevokeOthers,
}: SessionsSectionProps) {
  const headingId = useId()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  // The session being signed out: its button waits, so a second click doesn't send a second revoke.
  const [revoking, setRevoking] = useState<string | null>(null)
  const revokingRef = useRef<string | null>(null)
  const others = sessions.filter((session) => !session.current)

  async function signInAgain() {
    setSigningIn(true)
    setError(null)
    try {
      await onSignInAgain()
    } catch (caught) {
      setError(accountErrorMessage(caught))
    } finally {
      setSigningIn(false)
    }
  }

  const revoke = async (token: string) => {
    if (revokingRef.current !== null) return
    revokingRef.current = token
    setRevoking(token)
    setError(null)
    try {
      await onRevoke(token)
    } catch (caught) {
      setError(accountErrorMessage(caught))
    } finally {
      revokingRef.current = null
      setRevoking(null)
    }
  }

  const signOutOthers = async () => {
    setBusy(true)
    setError(null)
    try {
      await onRevokeOthers()
      setConfirming(false)
    } catch (caught) {
      setError(accountErrorMessage(caught))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section aria-labelledby={headingId} className="flex flex-col">
      <div className="mb-1.5 flex flex-wrap items-center gap-3">
        <h2 id={headingId} className="flex-1 text-base font-bold">
          Where you're signed in
        </h2>
        {others.length > 0 ? (
          <Button variant="outline" onClick={() => setConfirming(true)}>
            Sign out everywhere else
          </Button>
        ) : null}
      </div>
      <FormError message={error} />
      {needsSignIn ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-border py-2.5 text-sm">
          <p className="flex-1">
            Sign in again to see your sessions. Listing them needs a recent sign-in.
          </p>
          <Button variant="outline" disabled={signingIn} onClick={() => void signInAgain()}>
            Sign in again
          </Button>
        </div>
      ) : null}
      {sessions.map((session) => (
        <div key={session.token} className={ROW}>
          <div className={TEXT}>
            <span className="font-semibold">
              {session.device}
              {session.current ? (
                <span className="ml-1.5 rounded bg-solar px-1.5 text-xs font-extrabold text-solar-foreground">
                  This device
                </span>
              ) : null}
            </span>
            <span className={META}>
              {session.method ? `Signed in with ${session.method}` : "Signed in"} · {session.when}
            </span>
          </div>
          {session.current ? null : (
            <Button
              variant="outline"
              aria-label={`Sign out ${session.device}`}
              disabled={revoking === session.token}
              onClick={() => void revoke(session.token)}
            >
              Sign out
            </Button>
          )}
        </div>
      ))}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Sign out everywhere else?"
        description={`This signs out ${others.length} other ${others.length === 1 ? "session" : "sessions"}, including any on other devices. This one stays signed in.`}
        confirmLabel="Sign out others"
        destructive
        pending={busy}
        error={error}
        onConfirm={() => void signOutOthers()}
      />
    </section>
  )
}
