# Web app

`apps/app` (`@proof/app`) is TanStack Start in SPA mode, the D+ app. `vite build` writes
`apps/app/dist`, which `apps/api` serves from its origin. Dev: `vite dev` proxies `/api`, `/v1`,
`/mcp`, `/.well-known` and `/ofrep` to `API_URL`.

## Routes

- `/:org` (org slug; `OrgGate` sets the active org before org content renders)
- `/:org/runs/:runId`
- `/:org/settings/{general,members,api-keys,billing,agents,security}` (`/:org/settings/flags`
  redirects to `/admin/flags`)
- `/account/{profile,security}`, `/account/support` and `/account/support/:id` (the person's support
  tickets and one ticket's thread, `docs/support.md`)
- `/admin/{users,flags,support}` and `/admin/support/:id`, the admin console (see below)
- `/new`, `/two-factor`
- the OAuth, device, claim, reset and `/accept-invitation/:id` pages (`/invite/:id` is an alias;
  `/settings/agents` redirects)
- the invitation page reads `get_invitation_preview` (public: the link's id is the credential) before
  sign-in, so a logged-out visitor sees the organization, role and inviter, lands on sign-up (or
  sign-in when that address has an account) with the invited address locked in, and a signed-in
  person on another address is told so before they can accept

Org slugs can't take a reserved first segment (`RESERVED_ORG_SLUGS`, enforced server-side).
`apps/api/src/static.ts` serves every route; `apps/api/src/static.test.ts` derives the
list from `apps/app/src/routeTree.gen.ts`, and turbo hashes that file for api-app tests.

## Shape

Thin route file, then a container in `src/containers` (data, TanStack Query, mutations), then a
presentational page in `src/pages` (props in, callbacks out) built from `@proof/ui` and
`@proof/ui/dplus/*`. The shell components take links through `renderLink` and `ShellLinkProvider`
(TanStack Router's `Link` in `containers/router-link.tsx`).

Account security is split into `src/pages/account-security/*.tsx`: passkeys, two-factor, backup
codes, sessions, password, connected accounts, plus `shared.tsx`.

Shared pieces to reuse rather than rebuild:

- `@proof/ui/dplus/shell/page-header`: `PageHeader` (the bordered title band), `PageTabs` (link
  tabs under it) and `PageBody` (the content, one width for every page). Settings pages use
  `SettingsHeader`, which builds on them. Don't set a page's own `max-w` or centre it.
- `components/confirm-dialog.tsx`: `ConfirmDialog`, for destructive confirmations.
- `components/form.tsx`: `useAppForm` (TanStack Form + Zod), `TextField`, `PasswordField`,
  `SubmitButton`, `FieldIssues`, `FormError`, `FormDialog`. Field errors hold Zod issues: render
  `.message`.
- `lib/roles.ts`: `roleParts`, `hasRole`, `isOwner`. Don't compare role strings by hand.
- `containers/create-organization.tsx`: the create-organization container (slug availability check
  included).

## Data layer

- The product API (`/v1`) is called through `@proof/sdk`, via `productClient(orgId)` in
  `lib/product-client.ts`. It sends `X-Organization-Id`, turns off retries, and maps a
  `ProofError` to a `WebError` with the server's hint. `ResponseBody<op>`, `RequestBody<op>` and
  `QueryParams<op>` are its types. The response types in `lib/*-api.ts` are aliases of them (for
  example `ResponseBody<"list_member_security">`), not hand-written copies.
- Better-auth clients come from `makeAuthClient` in `lib/web-auth.ts`; `createWebAuth` wraps them.
- TanStack Query with the client in router context. Keys come from `lib/query-keys.ts`
  (`qk.org(orgId)…`) and per-area key files. Recent additions: `qk.organizationSlugAvailable()`,
  `qk.org().membersSecurity()`, `qk.org().agentsCount()`.
- Better-auth org calls always pass `organizationId`. `/v1` calls send `X-Organization-Id`
  (`ORGANIZATION_HEADER` from `@proof/api`), and `resolvePrincipal` answers 409 when it disagrees
  with the caller's org, so two tabs on two orgs can't write to the wrong one.
- Tables: TanStack Table. Long lists: TanStack Virtual. Debounce and run polling: TanStack Pacer,
  which pauses in background tabs. Shortcuts: TanStack Hotkeys (Ctrl/⌘K palette, G H, G A, G O,
  `?`).
- Run summaries: react-markdown with no raw HTML, and sugar-high tokens rendered as React spans
  (`.run-code` in `app.css`).
- Plugin endpoints the typed client lacks go through `client.$fetch`, with a method/path table test.

## Feature flags

`containers/org-features.tsx` (`OrgFeatures`, inside `OrgGate`) binds an OpenFeature provider to
the organization the page shows: `@openfeature/ofrep-web-provider` against this origin's
`/ofrep/v1/evaluate/flags` (session cookie and `X-Organization-Id`, `network-first` so a paused flag
never shows on from a stale cache), with `targetingKey` set to the org id. Read a flag with
`useFlag(key)` from `lib/flags.ts`: keys are typed to `packages/flags`, and the catalog default
answers until the provider does. Keep the call in the route file or a container and pass a boolean
down, so pages stay props-in (the org home's `whats-new-card` is the example). Tests pass
`createProvider` an `InMemoryProvider` (`containers/org-features.test.tsx`).

`OrgFeatures` mounts the org's pages only once the provider is set: a flag hook that first reads the
default provider never hears the new one become ready.

## Admin console

`/admin/*` is for the people who run the product, in the app shell with no org slug. Its tabs
(`lib/admin-nav.ts`) show by who may open them (`useAdminAccess`, `containers/admin-access.ts`):

- **Users** (`/admin/users`): platform admins, the better-auth user role `admin`. Search, ban,
  impersonate, revoke sessions, set role.
- **Feature flags** (`/admin/flags`): members of the operator organization, whose id
  `get_my_operator_organization` (`/v1/me/operator-organization`, session only) returns whatever
  org the session is on. `AdminFlagsContainer` moves the session to that org (`OrgGate`), since the
  rollout operations answer only to it. Rollouts, targets, reclaim, delete. It has no board or e2e
  journey: the operator organization is set by `OPERATOR_ORGANIZATION_ID` at server start, which
  the e2e stack can't know before it creates its organizations.

- **Support** (`/admin/support`, `/admin/support/:id`): support staff, the operator organization's
  members whose role holds `support:read`. The support queue (`docs/support.md`). The session stays
  on its organization: support checks the operator membership itself.

`/admin` lands on the first tab the person may open. The sidebar's outlined **Admin** link, below
Agent docs, shows only to someone with at least one tab. Each tab still answers "Not available" to
anyone it isn't for, and the server decides every call.

## Theme

Light, Dark or System, in `lib/theme.ts` (localStorage `proof.theme`). The boot script is inline
(`src/theme-boot.js?raw`, allowed by the CSP hash). Never put un-hashed files under `/assets`: that
path is served immutable. `app.css` `@source`s both `packages/ui/src/components/ui` and
`packages/ui/src/dplus`.

## Devtools

`src/devtools.tsx` mounts TanStack Devtools (Router, Query, Form, Pacer, Hotkeys), lazily, behind
`import.meta.env.DEV && MODE !== "test"`. The dist has none (form-core's tiny
`devtools-event-client` does ship).

## Billing

`lib/billing/` holds the `BillingAdapter`. It is the fixture (labelled `[SAMPLE DATA]`, prices
`[PRICE]`, changes disabled) unless `GET /api/auth/sign-in-methods` reports Stripe with at least one
plan. A failed check is an error, asked again on the next visit, not the fixture. "Requests today"
is real (the web app's own reads aren't counted).

## Runs

Approvals take effect 30 seconds after the decision (server `effectiveAt`). The countdown corrects
for clock skew from the response `Date` header (`lib/server-clock.ts`).

## Tests

Web tests use jsdom and Testing Library. See `docs/testing.md`.
