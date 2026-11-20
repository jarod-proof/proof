// The analytics event catalog: every event the app captures, by name. Browser-safe (zod and types
// only): the web app imports it as `@proof/analytics/events`, and the server entry re-exports it.
//
// Events carry ids and catalog words, never emails, names, IPs or operation input. A new event gets
// a line here first; a provider adapter never sees anything that isn't in this union.
import { z } from "zod"

/** Where the web app sends its events (apps/api, session cookie only). */
export const ANALYTICS_EVENTS_PATH = "/api/events"

/** The most events one request to ANALYTICS_EVENTS_PATH may carry. */
export const MAX_CLIENT_EVENTS = 20

/**
 * A route as the router names it (`/$org/runs/$runId`), not the address the person is on: the
 * template carries no organization slug or row id.
 */
const routeTemplate = z
  .string()
  .min(1)
  .max(200)
  .regex(/^\/[\w$./-]*$/, "a route template such as /$org/runs/$runId")

/**
 * The events the web app may send. The endpoint accepts these and nothing else, so it can't be used
 * to write arbitrary events into the provider.
 */
export const clientEventSchema = z.discriminatedUnion("name", [
  z.strictObject({
    name: z.literal("page.viewed"),
    properties: z.strictObject({ route: routeTemplate }),
  }),
])

/** The body of a request to ANALYTICS_EVENTS_PATH. */
export const clientEventBatchSchema = z.strictObject({
  events: z.array(clientEventSchema).min(1).max(MAX_CLIENT_EVENTS),
})

export type ClientEvent = z.infer<typeof clientEventSchema>

/** The auth events (packages/auth/src/auth-events.ts) worth counting, when they succeed. */
export const TRACKED_AUTH_EVENTS = [
  "auth.sign_up_started",
  "auth.invitation_accepted",
  "auth.sign_in",
  "auth.sign_out",
  "auth.two_factor_enabled",
  "auth.passkey_added",
  "auth.api_key_created",
  "auth.user_deleted",
] as const

export type TrackedAuthEventName = (typeof TRACKED_AUTH_EVENTS)[number]

/** How the caller authenticated: the `via` of a caller (`session`, `api-key`, `oauth`). */
export type CredentialKind = string

/** Every event the app captures. */
export type AnalyticsEvent =
  | ClientEvent
  | {
      /** One operation call, REST or MCP, that reached the handler or was refused by the hooks. */
      name: "operation.called"
      properties: {
        operation: string
        /** "ok", or the error code. */
        outcome: string
        via: CredentialKind
        /** The OAuth client that made the call, for OAuth callers. */
        oauthClientId?: string
      }
    }
  | {
      /** A new account, by any sign-up path, in its new personal organization. */
      name: "account.created"
      properties?: undefined
    }
  | { name: TrackedAuthEventName; properties?: undefined }

export type AnalyticsEventName = AnalyticsEvent["name"]
