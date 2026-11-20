import { OFREPWebProvider } from "@openfeature/ofrep-web-provider"
import { useBooleanFlagValue } from "@openfeature/react-sdk"
import { type FlagKey, flags } from "@proof/flags"

import { organizationHeaders } from "./org-header"

// Feature flags in the browser, through OpenFeature: the OFREP web provider asks the API
// (POST /ofrep/v1/evaluate/flags, cached by ETag) for every flag at once, for the organization the
// page shows. The server always evaluates for the caller's organization; the context's
// targetingKey (that organization's id) only keeps the SDK's cache per organization.

/** The OpenFeature domain the app's flags are bound to. */
export const FLAG_DOMAIN = "proof-web"

/** The evaluation context for an organization's pages. */
export const flagContext = (organizationId: string) => ({ targetingKey: organizationId })

/**
 * The provider for one organization: same-origin requests (the session cookie goes with them) with
 * X-Organization-Id, so the server refuses an answer for another org. `network-first`: a flag
 * paused on the server is never shown on from a stale cache; the cache only covers an outage.
 */
export function createFlagProvider(organizationId: string, fetchImpl?: typeof fetch) {
  const send = fetchImpl ?? fetch
  return new OFREPWebProvider({
    baseUrl: typeof window === "undefined" ? "" : window.location.origin,
    headers: Object.entries(organizationHeaders(organizationId)),
    cacheMode: "network-first",
    fetchImplementation: (input, init) => send(input, { ...init, credentials: "same-origin" }),
  })
}

/**
 * A flag's value for the organization the page shows, typed to the catalog's keys (removing a flag
 * from packages/flags makes each call a compile error). Until the provider answers, and when it
 * can't, the catalog default.
 */
export function useFlag(key: FlagKey): boolean {
  return useBooleanFlagValue(key, flags[key].default)
}
