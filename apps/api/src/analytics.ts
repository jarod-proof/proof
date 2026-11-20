// The API's side of analytics (docs/analytics.md): the provider @proof/env names, and the auth
// events worth counting. Operation calls are captured by the invoke hooks (hooks.ts) and the web
// app's events by POST /api/events (app.ts).
import {
  type Analytics,
  createAnalyticsFor,
  TRACKED_AUTH_EVENTS,
  type TrackedAuthEventName,
} from "@proof/analytics"
import type { AuthEvent, AuthEventName } from "@proof/auth"
import type { Logger } from "@proof/logger"

// Every tracked name is a real auth event: a rename in auth-events.ts fails here.
const tracked: ReadonlySet<string> = new Set(TRACKED_AUTH_EVENTS satisfies readonly AuthEventName[])
const isTracked = (name: AuthEventName): name is TrackedAuthEventName => tracked.has(name)

export interface AnalyticsEnv {
  NODE_ENV?: "development" | "test" | "production"
  ANALYTICS_PROVIDER?: "none" | "log" | "posthog"
  POSTHOG_API_KEY?: string
  POSTHOG_HOST?: string
}

/** The analytics the environment names. Unset is the log in development, and nowhere otherwise. */
export function analyticsFromEnv(env: AnalyticsEnv, logger: Logger): Analytics {
  const provider = env.ANALYTICS_PROVIDER ?? (env.NODE_ENV === "development" ? "log" : "none")
  switch (provider) {
    case "none":
      return createAnalyticsFor({ provider: "none" })
    case "log":
      return createAnalyticsFor({ provider: "log", logger })
    case "posthog":
      // @proof/env refuses posthog without its key.
      return createAnalyticsFor({
        provider: "posthog",
        apiKey: env.POSTHOG_API_KEY ?? "",
        host: env.POSTHOG_HOST,
      })
  }
}

/** A new account (createAuth's `onSignUp`): every sign-up path, in its personal organization. */
export function captureSignUp(
  analytics: Analytics,
  { userId, organizationId }: { userId: string; organizationId: string },
): void {
  analytics.capture(
    { name: "account.created" },
    { actor: { type: "user", userId }, organizationId },
  )
}

/**
 * Captures an auth event when it is one we count, it succeeded, and it is about a known person.
 * The IP and the endpoint path stay in the audit trail; analytics gets the name and the ids.
 */
export function captureAuthEvent(analytics: Analytics, event: AuthEvent): void {
  if (!isTracked(event.name) || event.outcome !== "ok" || event.userId === null) return
  analytics.capture(
    { name: event.name },
    {
      actor: { type: "user", userId: event.userId },
      ...(event.organizationId && { organizationId: event.organizationId }),
    },
  )
}
