# proof

Opinionated TypeScript monorepo template: Turborepo + pnpm, shadcn/ui + Storybook, Drizzle (Postgres),
better-auth, typed env, and agent-ready guardrails. Agent-native API surface: define an operation once and
get a REST route, an MCP tool, OpenAPI and `llms.txt`, with organization-scoped permissions, API keys and
OAuth 2.1 for agents.

## Use it

```bash
mise trust && mise install        # Node 24, pnpm 12, gitleaks
pnpm install
cp .env.example .env              # mise loads it; fill in BETTER_AUTH_SECRET (openssl rand -base64 32)
docker compose up -d db           # local Postgres (tests don't need it)
```

## What's in it

| | |
|---|---|
| `packages/ui` | shadcn/ui components, `cn`, Tailwind v4 theme, Storybook (+ MCP at `/mcp`), axe test helper |
| `packages/db` | Drizzle ORM, committed migrations, `@proof/db/testing` (in-process PGlite) |
| `apps/api` | Reference API ([Hono](https://hono.dev) on Node): REST, `/mcp`, `/openapi.json`, `/llms.txt`, OAuth discovery, the registry record |
| `apps/app` | TanStack Start SPA: sign-in, sign-up, consent, device login, agent settings. Built to `apps/app/dist` and served by `apps/api` |
| `packages/api` | Operation registry: `defineOperation` once → REST, MCP, OpenAPI 3.1, `llms.txt` / `llms-full.txt`; `invoke` with before/after hooks and pagination helpers |
| `packages/mcp` | Stateless MCP server (Streamable HTTP) from the registry; RFC 9728 resource metadata |
| `packages/auth` | better-auth + Wraps, organizations + roles from one permission catalog, org API keys, OAuth 2.1 (MCP clients register themselves; tokens bound to an org), device grant, provisional signup |
| `packages/auth-proofs` | [gdp-ts](https://github.com/rauchg/gdp-ts) proofs for tenant isolation (`callerActsFor`, `projectInOrg`), lint-enforced |
| `packages/sdk` | Typed API client generated from `apps/api/openapi.json` (retries, idempotency keys, paginate) |
| `packages/cli` | `proof` command: `login` (device grant), `whoami`, `ops`, `call <operation>` |
| `packages/env` | Validated environment variables (the only place env is read) |
| `packages/logger`, `packages/errors` | Structured logging and typed app errors |
| `packages/observability` | Request ids, access logs, error handling and health checks for Web-standard handlers |
| `packages/config` | Shared tsconfig and Vitest base config |
| `skills/proof` | Template agent skill to ship to your customers' agents (`npx skills add <owner>/<repo>`) |

## Commands

```bash
pnpm turbo run lint typecheck test build   # all via Turborepo
pnpm test:coverage               # thresholds only go up
pnpm baseline                    # bans/ratchets (code-baseline)
pnpm storybook                   # http://localhost:6006
pnpm --filter @proof/api-app dev     # API on BETTER_AUTH_URL (default http://localhost:3000)
pnpm --filter @proof/app dev         # web app dev server (proxies the API; API_URL sets its target)
pnpm --filter @proof/auth generate   # regenerate auth tables after changing auth plugins
pnpm --filter @proof/db db:generate  # new migration after schema changes
pnpm --filter @proof/sdk generate    # regenerate the SDK types after changing openapi.json
```

Commits must be [Conventional Commits](https://www.conventionalcommits.org). Pre-commit runs gitleaks,
baseline and format; commit-msg runs commitlint. CI runs all of it plus build, coverage, an OpenAPI
breaking-change check (pull requests) and a Docker build.

## Agents

`AGENTS.md` (also `CLAUDE.md`) holds the conventions. `.claude/settings.json` pre-approves this stack's
commands and denies destructive ones; skills live in `.claude/skills`.

## Docs

- [`AGENTS.md`](AGENTS.md): the conventions and the done-checks, for agents and people.
- [`docs/web-app.md`](docs/web-app.md): the web app's routes, data layer and forms.
- [`docs/auth.md`](docs/auth.md): sign-in methods, two-factor, admin, SSO, SCIM and Stripe.
- [`docs/database.md`](docs/database.md): tables, migrations and which ones are applied.
- [`docs/testing.md`](docs/testing.md): test layout, thresholds and the auth-flow tests.
- [`docs/observability.md`](docs/observability.md): `observe`, health and vendor status.
- [`docs/storage.md`](docs/storage.md): uploads and the file store (S3, R2, Vercel Blob, local).
- [`docs/analytics.md`](docs/analytics.md): product analytics and the provider (log, PostHog).
- [`docs/ui.md`](docs/ui.md): vendored shadcn components, D+ pieces and stories.
- [`docs/tooling.md`](docs/tooling.md): Storybook, portless, baseline, e2e, turbo, CI and dependencies.
- [`docs/roadmap.md`](docs/roadmap.md): what is not built yet.
- [`.claude/skills/agent-api/SKILL.md`](.claude/skills/agent-api/SKILL.md): the agent-native API in detail.

## Agent-native API

Every operation in `apps/api/src/operations/` (one file per domain) is served as REST, as an MCP tool at `/mcp` (except the
credential-free `signup`, which is REST only), and in `/openapi.json`, `/llms.txt` and `/llms-full.txt`. Every
request acts in one organization. Access is the member's role (owner, admin, member, viewer) narrowed by the
credential: an org API key's permissions, or an OAuth token's scopes (`read`, `write`, `admin`). MCP clients find
the authorization server through `/.well-known/oauth-protected-resource`, register themselves, and get a token
bound to the organization the user picks. Calls are metered per organization per day, writes are idempotent
on request and audited. `apps/api/openapi.json` is a committed snapshot of the contract, so every API change
shows up in review, and contract tests run every documented example over REST and MCP.

## Agent onboarding

- **Install the MCP server.** `<your API>/llms.txt` has install snippets for Claude Code, Cursor, VS Code and Codex.
  The MCP endpoint is `<your API>/mcp`; its registry record is `<your API>/.well-known/mcp/server.json`.
- **Sign in from a terminal or agent.** `proof login --base-url <your API>` (the `proof` bin of `packages/cli`). It
  shows a code to approve in the browser at `/device` and saves the token under `~/.config/proof`
  (`PROOF_CONFIG_DIR` overrides it). In this repo, build it with `pnpm --filter @proof/cli build` and run
  `node packages/cli/dist/bin.js login --base-url <your API>`.
- **Self-signup, no credential.** `POST <your API>/v1/signup` with `{ "email": "..." }` returns an API key (shown once)
  and emails a claim link. Until the link is followed, the organization has the lower daily limit.

## Deploy

1. Build the image from the repo root: `docker build -t proof-api .`. It runs `apps/api` with tsx and serves the
   built web app from `WEB_DIST_DIR`.
2. Apply migrations before the new version takes traffic: `DATABASE_URL=... node scripts/release.mjs`. Compose runs
   this as its `migrate` service; a platform's release command can run it too.
3. Set the environment (see `.env.example`):
   - required: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (the public origin, no trailing slash), `EMAIL_FROM`.
   - `WEB_DIST_DIR`: the image sets `/app/apps/app/dist`; set it only to serve another build.
   - `TRUST_PROXY=true` only behind a proxy that overwrites `X-Forwarded-For` (signup limits use the client IP).
   - `UNCLAIMED_ORG_DAILY_REQUEST_LIMIT` (default 500): requests per organization per UTC day while its owner's
     email is unverified. Once claimed, the plan's limit applies (`packages/plans/src/catalog.ts`).
   - optional: `WRAPS_API_KEY`, `PORT` (the image listens on 3000), `LOG_LEVEL`.
   - `API_URL` is for the web dev server's proxy only; leave it unset in production.

## Before you publish

- **Name the server.** The registry only accepts a name you can prove: `io.github.<owner>/<name>`, or
  `com.acme/<name>` for a domain proved with a DNS TXT record (`mcp-publisher login dns`), which also covers
  subdomains such as `api.acme.com`. Prefer the domain once the product has one: the name then belongs to the
  product, not to a GitHub account.
  To change it, set `registry` in `apps/api/src/server.ts` and `DEFAULT_REGISTRY_META` in
  `packages/api/src/server-json.ts` to the same value. Either way,
  replace the placeholder title and description in `apps/api/src/server.ts`. The discovery test pins the committed `server.json` to
  `DEFAULT_REGISTRY_META` and to `ROOT_INFO` in `apps/api/src/discovery.test.ts`; update `ROOT_INFO` too.
- **Regenerate the root `server.json`:** `UPDATE_SERVER_JSON=1 pnpm --filter @proof/api-app test discovery`, then commit it.
  Its origin is still the placeholder; publish the live record at `<your API>/.well-known/mcp/server.json`.
- **Submit it** to the MCP registry, the Claude connectors directory and Smithery. Each needs your account.
- **Publish the skill.** `skills/proof` is what customers' agents install (`npx skills add <owner>/<repo>`).
  `apps/api/src/skill-parity.test.ts` must pass first.
- **Add a `LICENSE`.** None is set.

## Not included yet

Custom roles per organization, Stripe billing (metering and limits exist; plans and checkout don't), publishing
(above), a deploy target beyond the image and release step, the e2e job ([tester-army/e2e](https://github.com/tester-army/e2e)
needs an app to point at and a model credential), and the LLM onboarding eval. See `docs/roadmap.md` for the full list.
