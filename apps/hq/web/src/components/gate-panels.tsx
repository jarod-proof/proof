import { Button } from "@proof/ui/components/ui/button"
import type { ReactNode } from "react"

import { HqError } from "../api/errors"
import { describeError } from "./states"

/** A full-page, centred card: what the gate shows instead of a screen. */
export function GateShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <div className="flex w-full max-w-md flex-col gap-3 rounded-shell border border-border bg-panel p-6">
        {children}
      </div>
    </main>
  )
}

/** A signed-in account that is not a founder: the explanation and a way out, never a screen. */
export function NotFounderPanel({
  email,
  onSignOut,
  pending,
  error,
}: {
  email: string | null
  onSignOut(): void
  pending: boolean
  error: string | null
}) {
  const { title, body } = describeError(
    new HqError({ kind: "forbidden", status: 403, message: "not a founder" }),
  )
  return (
    <GateShell>
      <h1 className="m-0 text-xl font-semibold text-foreground">{title}</h1>
      <p className="m-0 text-sm text-soft">{body}</p>
      {email ? (
        <p className="m-0 text-sm text-muted-foreground">
          Signed in as <span className="font-mono break-all text-foreground">{email}</span>
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        className="min-h-touch self-start"
        disabled={pending}
        onClick={onSignOut}
      >
        Sign out
      </Button>
      {error ? (
        <p role="alert" className="m-0 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </GateShell>
  )
}

/** hq failed to boot (503): said plainly, with Retry, and nothing that looks like a sign-in. */
export function RefusedPanel({
  error,
  onRetry,
  retrying,
}: {
  error: HqError
  onRetry(): void
  retrying: boolean
}) {
  const { title, body } = describeError(error)
  return (
    <GateShell>
      <h1 className="m-0 text-xl font-semibold text-foreground">{title}</h1>
      <p role="alert" className="m-0 text-sm text-soft">
        {body}
      </p>
      <Button
        type="button"
        variant="outline"
        className="min-h-touch self-start"
        disabled={retrying}
        onClick={onRetry}
      >
        Retry
      </Button>
    </GateShell>
  )
}
