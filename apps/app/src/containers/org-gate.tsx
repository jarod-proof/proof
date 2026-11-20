import { type ReactNode, useEffect } from "react"

import { Button } from "@proof/ui/components/ui/button"

import type { WebAuth, WebOrganization } from "../lib/web-auth"
import { useSessionQuery, useSetActiveOrganization } from "./shell-data"

/**
 * Renders its children only once the session's active organization is `organization`. The page's
 * URL names the org; the session is shared by every tab, so this sets it (with the id, explicitly)
 * and waits for the refetch before showing anything org-scoped.
 */
export function OrgGate({
  auth,
  organization,
  signInHref = "/sign-in",
  children,
}: {
  auth: WebAuth
  organization: WebOrganization
  /** Where a signed-out person goes (with `next` back to this page). */
  signInHref?: string
  children: ReactNode
}) {
  const session = useSessionQuery(auth)
  const setActive = useSetActiveOrganization(auth)
  const activeId = session.data?.activeOrganizationId ?? null
  const mismatch = session.isSuccess && session.data !== null && activeId !== organization.id
  const { reset, mutate, status } = setActive
  // better-auth refuses set-active while impersonating (read-only by design), so never ask.
  const impersonating = Boolean(session.data?.impersonatedBy)

  // Another tab (or the server) changed the active org: a new attempt is allowed.
  useEffect(() => {
    reset()
  }, [activeId, organization.id, reset])

  // One attempt per change. A failure stays visible until the person retries (no loop).
  useEffect(() => {
    if (mismatch && !impersonating && status === "idle") mutate(organization.id)
  }, [mismatch, impersonating, status, mutate, organization.id])

  if (session.isSuccess && session.data === null) {
    // The cached session was for someone who has since signed out, or expired in another tab.
    return (
      <div role="alert" className="flex flex-col items-start gap-3 p-6">
        <p>Your session has ended.</p>
        <a href={signInHref} className="underline">
          Sign in again
        </a>
      </div>
    )
  }
  if (session.isError) {
    return <Failed message="Could not load your session." onRetry={() => void session.refetch()} />
  }
  if (!session.isSuccess) {
    return <output className="block p-6 text-muted-foreground">Loading…</output>
  }
  if (!mismatch) return <>{children}</>
  if (impersonating) {
    return (
      <output className="block p-6 text-muted-foreground">
        You can't switch organizations while impersonating. Stop impersonating to continue.
      </output>
    )
  }
  if (status === "error" || status === "success") {
    return <Failed message={`Could not switch to ${organization.name}.`} onRetry={() => reset()} />
  }
  return (
    <output className="block p-6 text-muted-foreground">Switching to {organization.name}…</output>
  )
}

function Failed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 p-6">
      <p>{message}</p>
      <Button type="button" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}
