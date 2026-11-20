# Testing

- Vitest per package, `*.test.ts` beside the source. `pnpm test`, or `pnpm test:coverage` to enforce
  thresholds.
- `apps/api/src/onboarding.test.ts` is the agent's-eye check: it follows the install text in `/` and
  the well-known documents rather than constants. If you change the snippets or discovery, it should
  still pass.
- Thresholds live in `packages/config/vitest.base.ts` (80% lines, functions and statements; 70%
  branches) and only go up. Generated `src/auth-schema.ts`, stories, tests and `*.types.ts` are
  excluded from coverage.
- Type-level tests go in `*.types.ts`. `pnpm typecheck` checks them; Vitest doesn't run them.
- Database tests use `createTestDb()` from `@proof/db/testing`: in-process Postgres (PGlite) with
  the real migrations applied. Regenerate the migration after any schema change, or those tests run
  against a stale schema.
- hq's daily-cap race (`apps/hq/src/data/spend.test.ts`) needs real Postgres and real, separate
  connections, which PGlite cannot give. It runs against a worktree's database (`DATABASE_URL`, a
  `*_wt_*` name) or `HQ_TEST_DATABASE_URL` (a `*_test` name), with hq's tables migrated (`pnpm wt`
  or `pnpm wt reset-db`), and is skipped anywhere else. It writes and deletes rows dated in 2200.
  `turbo.jsonc` lists both variables for `@proof/hq#test` so turbo's strict env mode passes them.
- The shared config allows 30 seconds per test and 60 seconds per hook, because PGlite startup is
  slow on cold CI runners.
- **Workers:** `packages/config/vitest.base.ts` caps `maxWorkers` at a quarter of the cores per
  package. Turbo runs every package's tests at once, and vitest's default of a worker per core
  starved the PGlite instances past their timeouts (auth's signup test went from 40-47 seconds to
  about 11). Don't raise it back to the default.
- Web tests (`apps/app`) use jsdom and Testing Library. `packages/ui` tests render with
  `react-dom/server`, and its a11y checks run under jsdom.

## Auth flows

`apps/api/src/auth-flows.test.ts` is the guard against better-auth breaking things in minor and
patch releases. It drives sign-up, sign-in and sign-out, sessions, password reset, email
verification, change password, organizations and invitations, CSRF and disabled endpoints, all over
HTTP.

- It uses the real `createClient` through `browser()` (`apps/api/src/browser.test.helpers.ts`, a
  cookie jar that sends Origin), and asserts status codes, error codes, redirects and emails.
- Auth emails go to a fake SES: `t.outbox`, and wait with `delivered()`. A send error throws, but
  better-auth swallows some (reset requests), so always assert the email arrived.
- Add a test there for every auth flow the product relies on.
- Don't call `auth.api.*` for the step under test. That skips HTTP, cookies and origin checks.
- better-auth disables its origin and CSRF checks under a test runner, so `createAuth` turns them
  back on. Cookie requests in tests therefore need an `origin` header (`as()` and `browser()` add
  it).

## Coverage and accessibility

- `apps/api/src/server.ts` is excluded from coverage (`apps/api/vitest.config.ts`). It only wires
  env, the database and the listener.
- Test UI with `expectNoA11yViolations(html)` from `@proof/ui/a11y` (axe-core). The test file
  needs `// @vitest-environment jsdom`, and an app needs `jsdom` as its own devDependency.
- jsdom can't check colour contrast or landmarks, so `packages/ui/src/a11y.ts` turns those rules
  off.
