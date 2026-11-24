import { HqError } from "../api/errors"
import { Button } from "@proof/ui/components/ui/button"

export type ErrorContext = "default" | "sign-in"

/**
 * The one table of error copy. Nothing else in the app words an HqError. `"sign-in"` words the few
 * kinds that mean something else on the sign-in form: a 401 there is a wrong email or password (not
 * an ended session) and a 403 is better-auth refusing the account (not "founders only").
 */
export function describeError(
  error: HqError,
  context: ErrorContext = "default",
): { title: string; body: string } {
  if (context === "sign-in") {
    if (error.kind === "unauthorized") return { title: "Wrong email or password", body: "" }
    if (error.kind === "forbidden") {
      return {
        title: "This account cannot sign in yet",
        body: "Verify the email address first, then try again.",
      }
    }
  }
  switch (error.kind) {
    case "unauthorized":
      return { title: "Sign in required", body: "Your session ended. Sign in again to continue." }
    case "forbidden":
      return {
        title: "Founders only",
        body: "This account is signed in but is not a founder, so hq refused the request.",
      }
    case "untrusted-origin":
      return {
        title: "Open the app on its canonical host",
        body: "hq only accepts changes from the organization's canonical host. Open the app on the org's canonical host and try again.",
      }
    case "not-found":
      return { title: "Not found", body: "hq has nothing at that address." }
    case "conflict":
      return {
        title: "Already decided",
        body: "That was already decided. Reload to see how it ended.",
      }
    case "bad-request":
      return {
        title: "Request not accepted",
        body: "hq could not use that request. Reload and try again.",
      }
    case "rate-limited": {
      const seconds = error.retryAfterSeconds ?? 5
      return {
        title: "Too many attempts",
        body: `Try again in ${seconds} ${seconds === 1 ? "second" : "seconds"}.`,
      }
    }
    case "refused":
      return {
        title: "hq refused to start",
        body: "hq refused to start, so it serves nothing right now. Nothing is wrong with your account. Ask a founder to check hq's deployment, then retry.",
      }
    case "unreachable":
      return { title: "Could not reach the server", body: "Check your connection, then retry." }
    case "server":
      return {
        title: "hq had a problem",
        body: "hq answered with a server error. Retry in a moment.",
      }
  }
}

/**
 * An error as one line of sentences (title, then body when there is one), for the places that show
 * a single `role="alert"` line. Anything that is not an HqError reads as a server problem.
 */
export function errorMessage(error: unknown, context: ErrorContext = "default"): string {
  const hqError =
    error instanceof HqError
      ? error
      : new HqError({ kind: "server", status: 0, message: "unexpected" })
  const { title, body } = describeError(hqError, context)
  return body ? `${title}. ${body}` : `${title}.`
}

export function ErrorBlock({ error, onRetry }: { error: HqError; onRetry?: () => void }) {
  const { title, body } = describeError(error)
  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-2 rounded-card border border-border bg-card p-4"
    >
      <p className="m-0 text-sm font-medium text-destructive">{title}</p>
      <p className="m-0 text-sm text-soft">{body}</p>
      {onRetry ? (
        <Button type="button" variant="outline" className="min-h-touch" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  )
}

export function LoadingBlock({ label }: { label: string }) {
  return (
    <output
      aria-busy="true"
      className="block rounded-card border border-border bg-muted p-4 text-sm text-muted-foreground"
    >
      Loading {label}
    </output>
  )
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-card border border-border bg-muted p-4">
      <p className="m-0 text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="m-0 text-sm text-muted-foreground">{description}</p> : null}
    </div>
  )
}

/** A value hq has no source for: never a number, always this. */
export function NotConnected({ source, what }: { source: string; what: string }) {
  return (
    <output className="flex flex-col gap-1 rounded-card border border-border bg-muted p-3.5">
      <span className="text-xs text-muted-foreground">{what}</span>
      <span className="text-sm font-medium text-soft">Not connected</span>
      <span className="text-xs text-faint">{source} is not connected to hq yet.</span>
    </output>
  )
}
