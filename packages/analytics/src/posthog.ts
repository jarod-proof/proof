// PostHog over its capture API (POST /batch/), with no SDK. Each organization is a PostHog group of
// type "organization", so usage rolls up per tenant. API keys get their own distinct id
// (`api_key:<id>`); people are their user id.
import { AppError } from "@proof/errors"

import type { AnalyticsProvider, CapturedEvent } from "./index"

export interface PostHogConfig {
  /** The project API key (`phc_...`). It is public by design; it can only write events. */
  apiKey: string
  /** The ingestion host. Default US cloud, https://us.i.posthog.com (EU: https://eu.i.posthog.com). */
  host?: string
  /** For tests. */
  fetch?: typeof fetch
  /** Give up on a send after this long. Default 10 seconds. */
  timeoutMs?: number
}

export const POSTHOG_US_HOST = "https://us.i.posthog.com"

const distinctId = (e: CapturedEvent) =>
  e.actor.type === "user" ? e.actor.userId : `api_key:${e.actor.keyId}`

/** One event in PostHog's shape. Page views become `$pageview`, so PostHog's web views work. */
function toPostHog(e: CapturedEvent) {
  const pageView = e.name === "page.viewed"
  return {
    event: pageView ? "$pageview" : e.name,
    distinct_id: distinctId(e),
    timestamp: e.timestamp.toISOString(),
    properties: {
      ...(pageView ? { $pathname: e.properties.route } : e.properties),
      actor_type: e.actor.type,
      ...(e.organizationId && { $groups: { organization: e.organizationId } }),
    },
  }
}

export function createPostHogProvider(config: PostHogConfig): AnalyticsProvider {
  const url = `${(config.host ?? POSTHOG_US_HOST).replace(/\/$/, "")}/batch/`
  const doFetch = config.fetch ?? fetch
  return {
    async send(batch) {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: config.apiKey, batch: batch.map(toPostHog) }),
        signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
      })
      if (!res.ok) {
        throw new AppError("INTERNAL", `PostHog refused ${batch.length} events: ${res.status}`, {
          context: { status: res.status },
        })
      }
    },
  }
}
