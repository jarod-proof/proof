# Observability

- Wrap every route handler in `observe` from `@proof/observability`. `apps/api` has its own
  request-id and access-log middleware instead.
- Health is liveness only. `/health` (`createHealthHandler({})`) pings no dependency and answers
  `{ status: "ok", checks: {} }`.
- Vendor health comes from the vendors themselves. `GET /status` reads each vendor's status page
  (Atlassian Statuspage, status.io, or AWS Health for `aws`, `aws@<region>` or
  `aws:<service>@<region>`). It caches each result for 60 seconds and reports `unknown` when a page
  can't be reached.
- `STATUS_PROVIDERS` sets the list. Unset, it is a broad default: all of AWS, Cloudflare, Vercel,
  Neon and PlanetScale. Narrow it to what the app uses.
- Any open AWS event, in any region, shows `aws` as degraded.
- `observe` reports only 5xx responses (thrown or returned) and non-exposed errors. 4xx are logged.
- Server-error logs include only the allowlisted request headers (`safeHeaders`), never the full
  set.
- No error-tracking SDK is installed yet. `apps/api/src/server.ts` registers a reporter that logs
  each reported error once, from REST, MCP tools, the invoke hooks and analytics alike. Add an
  error tracker in that reporter, and keep the log line. An app that registers none reports nowhere.

## The API's access log

`apps/api` writes one `request` line per request: `requestId`, `method`, `path`, `status`, `ms`
and `agent`, plus what the request learned on the way:

- `operation`: the REST route's operation, or the MCP tool called (the last one, if a request
  carries several).
- `outcome`: `ok`, or the error code. An MCP tool that fails still answers 200, so only `outcome`
  says it failed.
- `organizationId`, `actorType` (`user` or `apiKey`), `actorId`, `via` (`session`, `api-key`,
  `oauth`) and `oauthClientId`: the caller, as ids, the same ones the audit trail keeps.

A request with no credential has no caller fields. Paths with a token in them are redacted
(`loggedPath`).

## Logging and errors

- `createLogger({ name })` from `@proof/logger` is pino with secret redaction. Use it, never
  `console.*` or pino directly. `apps/api/src/server.ts` creates the API's logger.
- `AppError` (`@proof/errors`) takes `hint`, `docs`, `headers` and `context`. Clients get
  `error.toPublic()`, never an `INTERNAL` message.
- `setErrorReporter` registers the reporter once at startup. `reportError` passes reported errors to
  it.
- `parseStatusProviders` (`@proof/observability`) parses `STATUS_PROVIDERS`.

## Helpers

- `observe(handler, { logger })` wraps a Web `Request`/`Response` handler with a request id, an
  access log and error handling.
- `createHealthHandler(checks)` is the health handler; the API passes `{}`.
- `createStatusHandler(providers)` serves `/status`, and `parseStatusProviders` builds its list.
