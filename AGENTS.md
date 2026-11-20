# proof

Turborepo + pnpm 12 monorepo, TypeScript. `apps/api` is a reference Hono API; add apps beside it.
Reference detail is in `docs/` and `.claude/skills/agent-api/SKILL.md`; sections link to it.
`GLOSSARY.md` names the concepts (organization, grant, operation, run, approval, ...); use those
words in code, docs and UI, and add a line there before introducing a new one.

## Setup

```bash
mise trust && mise install   # Node 24, pnpm 12, gitleaks; a fresh clone is untrusted until this
pnpm install
cp .env.example .env         # mise loads it; BETTER_AUTH_SECRET: openssl rand -base64 32
docker compose up -d db      # optional local Postgres; tests don't need it
pnpm wt new <branch>         # a worktree in ../proof.<name> with its own database
```

Worktrees: `pnpm wt new`, `ls`, `rm <branch>`, `prune` (after merging; `--yes` applies),
`reset-db` (`scripts/worktree.mjs`, `docs/tooling.md`). Each gets `proof_wt_<name>` through
`.env.worktree`. Agents run these themselves, never the user: make a worktree with `pnpm wt new`
(or EnterWorktree, whose hook runs it), and after a branch merges or closes, run
`pnpm wt prune --yes`. Never a bare `git worktree add`.

## Layout

- `apps/api` — Hono on Node (`@hono/node-server`), run with `tsx`. `createApp`
  (`apps/api/src/app.ts`) serves REST, `/mcp`, OpenAPI, llms.txt, `/skill.md`, `/health`, `/status`, OAuth
  discovery, `/api/auth/*` and OFREP (`/ofrep/v1/*`, a protocol route like `/api/auth/*`). Operations are in `src/operations/`, invoke hooks in `src/hooks.ts`,
  tenant helpers in `src/tenant.ts`, tenant data in `src/data/`. `apps/api/src/server.ts` only wires
  env, DB and listener. `src/product.ts` is the one source for the product's name, version, public URL
  and MCP registry entry.
- `apps/app` — `@proof/app`, TanStack Start in SPA mode (the D+ app). See `docs/web-app.md`.
- `apps/site` — `@proof/site`, the static Astro marketing site (home, pricing, blog, changelog,
  legal) built from `@proof/ui`. Markup lives in `.tsx` components, not `.astro`. See
  `docs/site.md`.
- `apps/agent` — `@proof/agent`, the org's eve agent, built from Foreman (vercel-labs/eve-software-factory-template,
  MIT, commit `2e1652f`, eve pinned `1.0.0`): Slack, hq memory (reads from hq, writes only as proposals) and
  the daily spend cap (`agent/hooks/spend.ts`, `agent/lib/spend/`), founder-only Slack approvals (it
  verifies a card click and forwards the raw bytes to hq, which decides it: `agent/lib/slack/`,
  `apps/hq/src/slack/`), the nightly digest (`agent/schedules/nightly-digest.ts`) and GitHub App
  installation tokens (`agent/lib/github/app-token.ts`). Its env is `@proof/env/agent`. Install with
  `pnpm install --ignore-scripts`. `pnpm --filter @proof/agent eval` runs the offline evals against the real hq.
- `packages/api` — operation registry (`defineOperation`, `defineRegistry`, `invoke`), OpenAPI,
  llms.txt, server.json, pagination. Framework-agnostic.
- `packages/sdk` — `@proof/sdk`, the typed client generated from `apps/api/openapi.json`.
- `packages/cli` — `@proof/cli`, binary `proof`: `login`, `logout`, `whoami`, `ops`, `call`.
- `packages/mcp` — stateless Streamable HTTP MCP handler; RFC 9728 resource metadata.
- `packages/ui` — shadcn/ui (`base-sera`), D+ pieces, Storybook. See `docs/ui.md`.
- `packages/db` — Drizzle (Postgres), migrations in `drizzle/`, `@proof/db/testing`. See
  `docs/database.md`.
- `packages/auth` — better-auth with organizations, org API keys (`sk_`), OAuth 2.1, device grant.
  `packages/auth/src/access.ts` is the permission catalog (browser-safe). See `docs/auth.md`.
  In-app notifications (@byo-oss/notifications): send only through the catalog in
  `packages/auth/src/notifications.ts`, never `auth.api.notify`. See `docs/notifications.md`.
- `packages/auth-proofs` — gdp-ts proofs (`lib/ids.ts`, `proofs/`,
  `packages/auth-proofs/src/mistakes.types.ts`).
- `packages/logger`, `packages/errors` — pino with redaction; `AppError`, `ErrorCode`,
  `reportError`.
- `packages/observability` — `observe`, health and status handlers. See `docs/observability.md`.
- `packages/flags` — `@proof/flags`: the feature flag catalog (`src/catalog.ts`), evaluator and
  stale signals; browser-safe. See `docs/feature-flags.md`.
- `packages/plans` — `@proof/plans`: the plan catalog (`src/catalog.ts`, @byo-oss/entitlements'
  `defineEntitlements`): Free, Pro and Team, their features and limits and their copy. Browser-safe;
  the API (`auth.entitlements`, `packages/auth/src/entitlements.ts`), the web app's billing page and
  the pricing site all read it.
- `packages/storage` — `@proof/storage`, the file store uploads go to (S3, R2, Vercel Blob or a
  local directory, by `STORAGE_DRIVER`) and image checks. See `docs/storage.md`.
- `packages/analytics` — `@proof/analytics`, product analytics: the event catalog (browser-safe at
  `@proof/analytics/events`) and the provider (log or PostHog, by `ANALYTICS_PROVIDER`). The web
  app posts page views to `POST /api/events`. See `docs/analytics.md`.
- `packages/env` — the only place env vars are read (Zod). `packages/config` — shared tsconfig and
  Vitest base.
- `scripts/` — `scripts/worktree.mjs` (`pnpm wt`),
  `scripts/generate-stories.mjs`, `scripts/release.mjs` (applies migrations),
  `scripts/e2e-stack.mjs` (with `scripts/e2e-dkim-dns.mjs`), `scripts/seed-demo-run.mjs`,
  `scripts/flags.mjs` (`pnpm flags`).
- `Dockerfile`, `docker-compose.yml` — the API image; compose's `migrate` runs `scripts/release.mjs`
  first.
- `skills/proof` — the template skill for customers' agents, served at `/skill.md`; `server.json`
  — the MCP registry record; `.github/workflows/release.yml` publishes both packages and the record
  (`docs/tooling.md`, "Releasing").

## Before you call a change done

Pnpm does not chain script names, so run each one:

```bash
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm baseline && \
  pnpm format:check && pnpm build
```

After an API change, run `pnpm --filter @proof/api-app test -u` and
`pnpm --filter @proof/sdk generate` first. CI adds gitleaks, commitlint, a generated-files check,
an OpenAPI check, `pnpm audit`, the e2e suite and a Docker build (`docs/tooling.md`). `pnpm format`
fixes formatting.

## Rules

- **Commits:** Conventional Commits (`feat`, `fix`, `chore`, `docs`, `test`, `ci`, `refactor`,
  `perf`, `build`, `style`, `revert`). Header and body lines are 100 characters or fewer; PR titles
  follow the same format.
- **Hooks:** pre-commit runs gitleaks, baseline and format; commit-msg runs commitlint. Never use
  `--no-verify`. For a gitleaks hit on a test fixture, add `// gitleaks:allow` on that line only.
- **Logging:** use `@proof/logger`, never `console.*` or pino directly. Throw `AppError`; send
  clients `error.toPublic()`, never an `INTERNAL` message. Register the reporter once with
  `setErrorReporter`.
- **Observability:** wrap every route handler in `observe`. `/health` is liveness only. Details:
  `docs/observability.md`.
- **Accessibility:** oxlint's `jsx-a11y` rules are errors outside the vendored `ui/components` and
  `hooks` (`.oxlintrc.json` overrides). Test UI with `expectNoA11yViolations(html)` from
  `@proof/ui/a11y`; the test file needs `// @vitest-environment jsdom`.
- **Env:** add each variable to `packages/env` and `.env.example`, and read it from there, never
  `process.env` (baseline `use-proof-env`). Never read or edit `.env`.
- **Authorization:** declare what an operation needs in `permissions`, and guard tenant data with
  gdp-ts proofs. Don't hand-roll role or ownership checks in handlers. Every query lives in
  `apps/api/src/data/` behind a proof (baseline `api-queries-in-data-layer`). An operation under a
  new path prefix needs a fixture in `apps/api/src/authorization.test.ts`, which runs every
  operation as a no-grant key, a viewer and another organization.
- **UI:** semantic tokens and dark-mode variants only, no raw colours such as `bg-white` (baseline
  `shadcn-strict`). Use `cn` from `cn`, never clsx or tailwind-merge.
- **Formatting and lint:** Biome formats (no semicolons, 100 columns); Oxlint lints, type-aware:
  floating or misused promises are errors, so a promise you mean to drop takes `void`. Biome skips
  `.claude/` and lockfiles, and does not format Markdown.
- **pnpm 12:** dependency build scripts must be approved in `pnpm-workspace.yaml` (`allowBuilds`).
  Don't hand-edit `minimumReleaseAgeExclude`. It lists only our own packages (`@byo-oss/*`,
  `@wraps.dev/*`), by name, so our releases install the day they publish. Every other package
  waits out the 24-hour release age.
- **Vendored shadcn:** `packages/ui/src/components/ui/` and `src/hooks/` come from the shadcn CLI
  (`base-sera`). Add with `npx shadcn@latest add`, never by hand, then restyle to the D+ system.
  Details and stories: `docs/ui.md`.
- **Vendored skills** in `.claude/skills` are third-party; don't edit them. Refresh with
  `npx skills update`. `.claude/skills/agent-api` and `.claude/skills/feature-flags` are ours; keep
  them current.

## Agent-native API

Load the `agent-api` skill before touching operations, permissions, roles, OAuth scopes, tenant
tables, `apps/api`, `packages/api`, `packages/mcp`, `packages/auth-proofs`, `packages/sdk`,
`packages/cli` or `resolvePrincipal`. The rules that hold even without it:

- **One registry.** Define operations in `apps/api/src/operations/<domain>.ts`. Never hand-write a
  REST route, MCP tool, OpenAPI entry or docs entry.
- **One organization per request.** `ctx.caller.organizationId` is the only org a request acts in.
- **One permission catalog.** `statements` in `packages/auth/src/access.ts` drives roles, key
  permissions, OAuth scopes and operations. Declare the least each operation needs.
- **Tenant data takes proofs.** Use `inCallerOrg`, `requireInOrg` and `orNotFound`
  (`apps/api/src/tenant.ts`). Another org's row is NOT_FOUND, never FORBIDDEN.
- **The contract is a snapshot.** After an intended change run
  `pnpm --filter @proof/api-app test -u` and `pnpm --filter @proof/sdk generate`, then review
  the `apps/api/openapi.json` diff as a public API change. Removing, renaming or tightening breaks
  deployed agents: add an operation or `/v2`.
- **Errors** are thrown `AppError`s, never returned shapes. Only 5xx and unexposed errors are
  reported.
- **Public operations** use `auth: "none"` (REST only, no hooks; `signup` is the one). Never add a
  credential-free route by hand. What only a signed-in person does for themselves (their avatar)
  uses `auth: "person"`: session only, REST only.
- **Person-only actions** (`PERSON_ONLY_ACTIONS`, the owner-only resources, `subscription`) are
  never granted to API keys or OAuth tokens.
- **Operator operations** (`audience: "operator"`, the feature flag rollouts) answer only to the
  operator organization (`OPERATOR_ORGANIZATION_ID`): data behind `inOperatorOrg` and the
  `OperatorOrg` proof.

## Feature flags

Ship a risky or gradual change behind a flag: load the `feature-flags` skill. It covers declaring,
gating, targeting, ramping, reclaiming and removing a flag, and `pnpm flags stale`.

## Web app

Details: `docs/web-app.md`.

- Routes: `/:org` (with `/runs/:runId` and `/settings/*`), `/account/*`, `/new`, `/admin/*` (the
  admin console: users, feature flags, the support queue), and the OAuth pages. Theme:
  `lib/theme.ts`.
- Route files are thin. Data and mutations live in `src/containers`; presentational pages in
  `src/pages` take props and callbacks.
- Call the product API through `@proof/sdk` (`productClient(orgId)`, `lib/product-client.ts`).
  Better-auth org calls always pass `organizationId`.
- Forms use `useAppForm` and the fields in `components/form.tsx`, with Zod. Query keys come from
  `lib/query-keys.ts`; role checks from `lib/roles.ts`.
- Never put un-hashed files under `/assets` (served immutable). `apps/api/src/static.ts` serves
  `PAGE_PATHS`, which must match `apps/app/src/routes`.

## Advisor checkpoints

- Consult the advisor before locking a multi-file plan (auth proofs, DB schema or migrations), when
  the same test or compiler error fails twice, and on the full diff before declaring done.
- Don't consult it for routine bash, formatting or single-file edits.

## Testing

Details: `docs/testing.md`.

- Vitest per package, `*.test.ts` beside the source. `pnpm test:coverage` enforces thresholds, which
  only go up. Keep `maxWorkers` capped in `packages/config/vitest.base.ts`.
- Database tests use `createTestDb()` (PGlite with the real migrations). Regenerate the migration
  after any schema change.
- Type-level tests go in `*.types.ts`; `pnpm typecheck` runs them, Vitest doesn't.
- Auth flows are tested over HTTP in `apps/api/src/auth-flows.test.ts` with `browser()`. Don't call
  `auth.api.*` for the step under test. Every auth flow the product relies on needs a test there.
- `apps/api/src/onboarding.test.ts` follows the install text and discovery documents: keep it
  passing when you change them.

## Database and auth

Details: `docs/database.md`.

- App tables go in `packages/db/src/schema.ts`; every customer-data table has `organizationId`.
- New migration: `pnpm --filter @proof/db db:generate`, then commit the SQL. Auth option or plugin
  change: `pnpm --filter @proof/auth generate`, then `pnpm format`.
- Applying migrations (`db:migrate`, `drizzle-kit push`) is denied for agents. Ask the user, or use
  `scripts/release.mjs` in a deploy. The exception is `pnpm wt`: it migrates only a worktree's own
  `*_wt_*` database, and agents run it themselves.

## Tooling

Details: `docs/tooling.md`.

- Storybook (`pnpm storybook`, port 6006) serves MCP at `/mcp` while it runs. `pnpm dev` runs the
  apps on portless `*.localhost` URLs (`portless.json`).
- baseline (`baseline.toml`): presets, our error rules (no console, no other loggers, `cn` only, no
  kits outside `packages/ui`, no `process.env` outside `packages/env`, no `any` in types, no bare
  `new Error` in `apps/api`, no server imports in client packages) and ratchets whose ceilings only
  go down (`baseline ratchet down <id>`; never raise one). Warnings don't fail the run; errors do.
- e2e (`pnpm e2e`) runs in CI without the `visual` tag. Turbo's graph is in `turbo.jsonc`; its
  `transit` task carries the package graph into test hashes.
- `pnpm audit` runs in CI. Ignore an advisory only in `auditConfig.ignoreGhsas`
  (`pnpm-workspace.yaml`) with a comment giving the reason; `pnpm audit --ignore` rewrites that file.
- Dependencies align through the pnpm `catalog:`. TypeScript is 7; only `openapi-typescript` gets
  TypeScript 5, through `.pnpmfile.mjs`.

## Agent permissions

`.claude/settings.json` pre-approves pnpm (including `pnpm wt`), turbo, baseline, gitleaks and local
git (status, diff, log, add, commit). It denies force-push, `--no-verify`, `git reset --hard`, DB
migrations and `.env` access. Its `WorktreeCreate` and `WorktreeRemove` hooks run `pnpm wt`
(`docs/tooling.md`). Anything else, such as `git push`, `docker` or installing skills,
needs the user. The Stop hook (`scripts/claude-stop-check.mjs`) blocks ending a turn while baseline
or typecheck fail; it steps aside on its second run in a turn (`stop_hook_active`), so an unfixable
failure is reported, not looped on.

## Skills (this repo)

gdp-ts, shadcn, turborepo, portless and better-auth (best-practices, create-auth,
email-and-password), pinned in `skills-lock.json`. Ours: `agent-api`, `feature-flags`.

## Not yet

The roadmap and known gaps: `docs/roadmap.md`.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
