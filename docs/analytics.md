# Analytics

Product analytics go to the **analytics provider** (GLOSSARY) that `ANALYTICS_PROVIDER` picks:

| `ANALYTICS_PROVIDER` | Where events go |
|---|---|
| unset | `log` when `NODE_ENV=development`, `none` otherwise |
| `none` | nowhere: nothing is captured |
| `log` | the API's log, one `analytics <name>` line per event |
| `posthog` | PostHog, over its capture API (`POSTHOG_API_KEY`, `POSTHOG_HOST`) |

With no provider, the API's access log still names each request's operation, caller and outcome
(`docs/observability.md`), so usage is readable from the logs alone.

Change the provider by changing the env. No code changes. `@proof/env` refuses to start with
`posthog` and no `POSTHOG_API_KEY`. `.env.example` lists the variables.

## What is captured

Every **analytics event** is in one catalog, `AnalyticsEvent` in
`packages/analytics/src/events.ts`. A provider never sees anything else.

| Event | From | When |
|---|---|---|
| `operation.called` | the invoke hooks (`apps/api/src/hooks.ts`) | every operation call, REST or MCP, with `operation`, `outcome` (`ok` or the error code), `via` and the OAuth client |
| `account.created` | createAuth's `onSignUp` (`apps/api/src/analytics.ts`) | a new account, by every sign-up path (email, social, passkey, provisional), in its new personal organization |
| `auth.*` | `onAuthEvent` (`apps/api/src/analytics.ts`) | the successful auth events in `TRACKED_AUTH_EVENTS`: passkey sign-up started, invitation accepted, sign-in, sign-out, 2FA on, passkey added, API key created, account deleted |
| `page.viewed` | the web app (`usePageViews`, `apps/app/src/lib/analytics.ts`) | each new path a signed-in person settles on, by route template |

- Each event names its **actor**, a user id or `api_key:<id>`, and its organization. PostHog
  groups events by organization (group type `organization`), so usage rolls up per tenant, agents
  included.
- A person's reads in the web app (`readOnly` operations over a session) are skipped, as metering
  skips them. They are the app's polling, and page views already say what the person looked at.
- Calls the hooks refuse (`RATE_LIMITED`, `CONFLICT`, `SESSION_NOT_FRESH`) are captured with that
  outcome. `FORBIDDEN` and `BAD_REQUEST` are refused before the hooks run and are not, the same gap
  as the audit trail.
- Events carry ids and catalog words only. They never carry emails, names, IPs, operation input,
  organization slugs or row ids. Page views send `/$org/runs/$runId`, not the address.

## How it works

- `@proof/analytics` has one interface, `Analytics` (`capture`, `flush`, `shutdown`), and one
  adapter per provider (`AnalyticsProvider.send(batch)`). `createAnalyticsFor(config)` picks the
  adapter. The package reads no env: `apps/api/src/analytics.ts` builds the config.
- `capture` only queues. It never waits on the network and never throws, so it is safe on the
  request path. The queue sends every 10 seconds or at 20 events. A failed send is reported
  (`reportError`) and dropped, never retried. Over 1,000 queued events (the vendor is down), new
  ones are dropped and the count is reported.
- `apps/api/src/server.ts` sends what is queued on `SIGTERM` and `SIGINT`.
- The browser sends no events to a vendor. `usePageViews` batches page views and posts them to
  `POST /api/events` on the API's origin, with the session cookie, and the API forwards them. So:
  - no vendor script runs in the page, and the CSP stays `connect-src 'self'`;
  - ad blockers that block vendor hosts don't drop events;
  - swapping providers is a server change only.
- `POST /api/events` is not an operation. It is not part of the API agents use, and the invoke
  hooks would meter and audit every page view. It takes a web app session only, from a trusted
  origin (API keys and OAuth tokens are FORBIDDEN). It accepts only the browser's events
  (`clientEventBatchSchema`: known names, strict fields, at most 20 events, a 16 KB body). The
  actor and organization come from the session, never from the body. It is not in OpenAPI.
- `ANALYTICS_EVENTS_PATH` and the client schema come from `@proof/analytics/events`, the
  browser-safe entry (zod and types only). The web app imports that entry, never the root.

## Add an event

1. Add a line for it to `AnalyticsEvent` in `packages/analytics/src/events.ts`, named
   `<noun>.<past tense verb>` in GLOSSARY words, with properties that are ids and enums only.
2. Server side: call `analytics.capture(event, { actor, organizationId })` where it happens. The
   caller's `actor` and `organizationId` are the subject.
3. Browser side: also add it to `clientEventSchema`, which is what the endpoint accepts, and add a
   method for it on `WebAnalytics`.
4. If a provider maps names (PostHog sends `page.viewed` as `$pageview`), update its adapter.
5. Test that it is captured (`createMemoryProvider`, then `flush`), as in
   `apps/api/src/analytics.test.ts`.

## Add a provider

Write `packages/analytics/src/<vendor>.ts` exporting `create<Vendor>Provider(config)`, an
`AnalyticsProvider`. `send` posts one batch and throws when the vendor refuses it. Add the vendor
to `AnalyticsConfig` and `createAnalyticsFor`, its variables to `packages/env` and `.env.example`
(with a startup check for the required ones), and a case to `analyticsFromEnv`. Test the payload
against a fake `fetch`, as `posthog.test.ts` does.

## PostHog

- Create a project and copy its project API key (`phc_...`) to `POSTHOG_API_KEY`. For EU cloud set
  `POSTHOG_HOST=https://eu.i.posthog.com`; for a self-hosted instance set its URL.
- Turn on group analytics with a group type named `organization`. Group properties (the
  organization's name or plan) are not sent yet.
- API keys are distinct ids of their own (`api_key:<id>`), so they appear as persons. That is what
  puts their calls in the organization's group.

## Not yet

- Signed-out page views (sign-in, sign-up). They need an anonymous id, which is a cookie, which
  needs consent handling.
- Group properties for organizations (`$groupidentify`), and person properties.
- UI events beyond page views, and an `organization.created` event.
- Per-person opt-out.
- A per-session rate limit on `POST /api/events`. Only the 20-event cap and the 16 KB body bound it.
- Impersonation: while an admin acts as someone, their page views and writes count as that person's.
