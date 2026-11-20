# Auth plugins

All `@better-auth/*` packages are at the pinned version (`better-auth` and `@better-auth/*` are
exact pins; see `docs/tooling.md`). Flows are tested in `apps/api/src/auth-flows.test.ts`.

The Wraps plugin does contact sync and sends the SES auth emails. Organizations are on: signup
creates a personal org. Org-owned API keys (`sk_`) and the OAuth 2.1 and jwt plugins are in
`packages/auth`, which also has `packages/auth/src/access.ts` (the permission catalog),
`packages/auth/src/permissions.ts` (grant math and OAuth scope grants), `resolvePrincipal`
(`packages/auth/src/principal.ts`), `packages/auth/src/device.ts` (the device grant) and
`packages/auth/src/signup.ts` (provisional signup).

## Sign-in methods

- Password, magic link (Wraps SES), passkey (rpID = the base URL host, or the shared parent of it
  and `WEB_ORIGINS`; see `passkeyRpID`), GitHub and Google (only when both env values are set), and
  SSO (`@better-auth/sso`; domain verification is required before a provider signs anyone in).
- `GET /api/auth/sign-in-methods` tells the web app which are on. `lastLoginMethod` drives the "Last
  used" badge. Sessions record `loginMethod` and `loginTwoFactor`.
- No `bearer` plugin: session tokens must not pass as API credentials.

## Passkey sign-up

Email first, so no credential or session is issued for an address until its mailbox is proven.

- `POST /passkey-signup/start` creates the unverified user (its personal org comes from the user
  create hook) and emails a single-use link valid for `PASSKEY_SIGNUP_TTL_MS` (30 minutes). It
  returns no token and sets no cookie.
- `GET /passkey-signup/verify` (the link) marks the address verified, consumes the token and signs
  the person in. The landing page `/sign-up/passkey` (`apps/app/src/routes/sign-up_.passkey.tsx`)
  then adds the passkey as a normal session-bound registration.
- A refused link redirects to `/sign-up/passkey?error=PASSKEY_SIGNUP_EXPIRED`, not to a JSON body.
  A mail scanner that prefetches the GET consumes the link, as it does a magic link.
- Skipping the passkey leaves the account with no passkey or password, so the magic link is the
  only way in until one is added.

Code: `packages/auth/src/passkey-signup.ts`.

## Two-factor

- TOTP, backup codes and trusted devices. The challenge goes to `/two-factor` and keeps the query,
  so OAuth resumes.
- A magic link for a 2FA user opens the challenge, not a session.
- Social and SSO sign-ins don't ask for TOTP (the provider's MFA applies).
- Owners reset a member's 2FA with `reset_member_two_factor`. It is refused with CONFLICT while the
  member belongs to any other shared organization, because the 2FA belongs to the account.

## Passwords

`haveIBeenPwned` is on (`PASSWORD_COMPROMISED`). Tests stub fetch to `api.pwnedpasswords.com`.

## Account

- Email change: a link to the new address and a notice to the old one. There is no native cancel.
  The link needs the user's own session. Opened signed out, it sends them to sign-in and changes
  nothing.
- Deletion needs an emailed confirmation. It is refused (`OWNS_ORGANIZATION`) while the user owns a
  shared organization.
- Account linking with `LAST_SIGN_IN_METHOD` protects the last way in
  (`packages/auth/src/account-plugin.ts`).
- `GET /api/auth/security/summary` (`packages/auth/src/security-summary.ts`).

## Rate limits

- `authRateLimit` (`packages/auth/src/rate-limit.ts`) is better-auth's `rateLimit`. `createAuth` leaves
  it off unless its `rateLimit` option is passed; `apps/api/src/server.ts` passes `{}` (on) unless
  `AUTH_RATE_LIMIT=off`. The env check refuses `off` outside development and test
  (`packages/env/src/index.ts`).
- Counts live in the `rate_limit` table (see `docs/database.md`), keyed by client IP and path, so every
  instance shares them.
- `STRICT_RULES` covers sign-in, magic link, 2FA codes, password reset, verification mail, sign-up,
  passkey verification, SSO sign-in, and change email and password. Other writes share the global
  limit (120 requests per 60 seconds).
- GET requests are not limited and write no `rate_limit` row (the last rule, `"/**"`, skips a GET
  that only the global limit covers), so session reads, listings and discovery cost nothing. A GET
  that carries a code or a single-use token is limited: the emailed links (`/verify-email`,
  `/reset-password/:token`, `/magic-link/verify`, `/passkey-signup/verify`, `/delete-user/callback`)
  and the social and SSO callbacks. `GET /device` (the short user code) keeps the device plugin's own
  rule, 5 tries per code lifetime. SCIM GETs are not limited: they authenticate with a bearer token in
  the header. A new GET that takes a secret in its query needs a `STRICT_RULES` entry.
- `apps/api/src/app.ts` sets the client IP into `CLIENT_IP_HEADER`, which better-auth reads through
  `authIpAddress`. Any copy the client sent is dropped. The address is the socket's, or the rightmost
  `X-Forwarded-For` hop when `TRUST_PROXY` is on.
- Set `TRUST_PROXY=true` behind a reverse proxy only if the proxy overwrites `X-Forwarded-For`. With it
  off, every request is keyed on the proxy's address, so one client can lock out everyone; the server
  logs a warning once per process when `X-Forwarded-For` arrives without `TRUST_PROXY`.
- Test helpers pass `rateLimit: false`. One flow test in `apps/api/src/auth-flows.test.ts` opts in and
  expects a 429.

## Fresh sessions

- A session signed in over `FRESH_AGE_SECONDS` (one hour) ago may not do sensitive actions.
  `session.freshAge` is the same value, so better-auth's own age checks (session listing, unlink
  account) agree (`packages/auth/src/fresh-session.ts`). Change password and two-factor disable ask
  for the current password instead; session revocation is left open so an old session can still sign
  an intruder out.
- `freshSessionGuard` refuses `FRESH_SESSION_PATHS` with `SESSION_NOT_FRESH`: every endpoint that adds
  a credential, changes who can act, or removes security config and isn't age-checked upstream. That
  is the sign-in email, account deletion, passkeys, two-factor enable and backup codes, social linking, API keys, SCIM token minting, SSO
  providers and domain verification, invitations, member roles and removal, org roles and delete,
  OAuth clients and consent, device approval, and the platform admin actions. A request with no session passes through to the
  endpoint's own `UNAUTHORIZED`.
- Operations marked `fresh: true` get the same refusal (`assertFreshSession` in
  `apps/api/src/hooks.ts`): `create_api_key`, `revoke_agent_access`, `reset_member_two_factor`,
  `decide_approval`, `undo_approval` and `revoke_scim_token`. API keys and OAuth tokens are exempt.
- The web app's `ReauthProvider` (`apps/app/src/components/reauth-dialog.tsx`, mounted in
  `routes/__root.tsx`) runs `withReauth` (`apps/app/src/lib/reauth.ts`). On `SESSION_NOT_FRESH` it asks
  the person to sign in again, then retries once. The session it replaces is revoked
  (`retireReplacedSession`), so no stale duplicate stays valid.

## Auth audit events

- `authEvents` (`packages/auth/src/auth-events.ts`) maps better-auth endpoints to `AUTH_EVENT_NAMES`
  and calls `onAuthEvent` after the response is sent, so the lookup and the write never change how long
  a request takes (a failed sign-in can't reveal whether the address has an account). Tests await
  `drainAuthEvents()` or poll for the row. `apps/api/src/server.ts` passes `recordAuthEvent`
  (`apps/api/src/data/audit.ts`), which writes an `audit_event` row.
- Email sign-up is not an auth event. `onSignUp` (a `createAuth` option) is called once per new
  account, by every sign-up path, from the user-create hook, with the account's personal
  organization. `apps/api` counts it in analytics (`account.created`, `docs/analytics.md`). It
  never fails the sign-up.
- `auth.invitation_accepted` belongs to the invited organization, read from the result (a new
  account has no active one). The invitation page's funnel is the `invitation` table (sent against
  accepted) plus this event; a visit before sign-in has no session, so it is not counted.
- A refused call, including a validation failure (`isAPIError`), is an event whose outcome is its
  error code. Failed social and SSO callbacks are not
  recorded.
- The row goes to the event's organization, else the account's personal organization, and only when
  the person is a member there. An event with no account (an unknown email, a signed-out password
  reset) is logged and not stored.
- Gaps: a password reset is never stored (it has no session, so no account), and `audit_event` has no
  `ip` column, so the client IP is not kept.

## Client ID metadata documents

- The `cimd` plugin (`@better-auth/cimd`, pinned in the catalog with the other better-auth packages)
  is on, so an MCP client may use an HTTPS URL as its `client_id`. The server fetches that document,
  validates it and creates the client. The authorization server metadata advertises
  `client_id_metadata_document_supported: true`. Dynamic registration (`/oauth2/register`) stays on as
  the fallback for clients that don't use metadata documents.
- The fetch goes through `fetchClientMetadataResource` from `@better-auth/cimd/node`, which keeps
  the plugin's defaults: HTTPS only, every resolved address must be public-routable (the connection
  is pinned to the address checked), and redirects are refused. A `client_id` on a private, loopback
  or link-local address is refused before any fetch. `originBoundFields` and the metadata fetch
  limits keep the plugin defaults. Don't swap in a plain `fetch` (it resolves DNS after the check).
- `AuthOptions.clientMetadataFetch` is the seam tests use (`createTestApp` forwards it). Production
  leaves it unset, so the Node transport is used.
- Tests: `apps/api/src/auth-flows.test.ts` ("client ID metadata documents"). They prove the
  advertised flag, the refusals before any fetch, a stubbed document that is accepted, and one whose
  `client_id` doesn't match the URL that is refused.
- `metadataProfile` stays at the default. The `mcp-2026-07-28` profile only adds requirements
  (`client_name`, `redirect_uris`) and pins draft-00, while the MCP SDK here (`@modelcontextprotocol/sdk`
  1.32.1) speaks 2025-11-25 as its latest revision.

## OAuth resume

Every step that resumes an authorization carries `oauth_query`. The magic link callbackURL holds it
(`packages/auth/src/resume.ts`).

## Roles

- Fixed roles are `owner`, `admin`, `member` and `viewer`, plus three capability roles for people:
  `approver` (reads runs and approves them), `operator` (reads, runs and steers, no approvals or agent
  changes) and `billing` (the subscription only), all in `packages/auth/src/access.ts`.
- A member may hold several (`viewer,approver`); a request is allowed when one role covers all of it.
  Owners and admins assign them. Keys and OAuth tokens never hold `run: approve` or `subscription`.
- Per-organization custom roles are on the roadmap (`docs/roadmap.md`).

## admin

- `adminRoles: ["admin"]`. Admins are promoted in the database only
  (`update "user" set role='admin' …`).
- Impersonation is read-only and fails closed (`packages/auth/src/guards.ts`). An impersonated
  session gets 403 `IMPERSONATED_SESSION_NOT_ALLOWED` for every better-auth request except
  stop-impersonating and sign-out. A GET passes only if it is listed as a read; each GET the plugins
  mount is classified in `packages/auth/src/guards.test.ts`.
- The product API gives it read-only grants (`IMPERSONATION_GRANTS`).
- Support's GETs are refused to an impersonated session too, though they only read: support is for
  the person themselves (`docs/support.md`).

## sso, scim, stripe

- Owner-only resources: `sso` and `scim`. `subscription` is for owners and admins. All three are in
  `OAUTH_EXCLUDED` (`packages/auth/src/owner-only.ts`, `packages/auth/src/scim-token.ts`).
- Provisioned users join as `member` (`SCIM_MEMBER_ROLE`); a role given later is kept while they stay
  active (`packages/auth/src/scim-projection.ts`).
- Deprovisioning (active false, or the SCIM user deleted) removes only a membership the directory
  created (`member.source = "scim"`) and ends the user's grants, SCIM tokens and notifications for that
  org (the notifications in the same transaction; see `docs/notifications.md`). A member
  added by hand or invited stays (logged as `scim.deprovision.hand_made_kept`). An owner is never
  removed (`scim.deprovision.owner_kept`): change the role first. Admins are removed.
- `list_scim_tokens` and `revoke_scim_token` are owner-only (`scim` resource). Revoking keeps the
  users provisioned by the token.
- A token ends (its credential is revoked, users kept) when its creator is removed, leaves, is demoted
  below `scim:create`, or deletes their account (`endScimTokensOf`, `packages/auth/src/scim-token.ts`).
- better-auth's SCIM routes are mounted for PUT, PATCH and DELETE as well (`apps/api/src/app.ts`).
- Stripe is test mode only (`sk_test_`). It is mounted with `STRIPE_SECRET_KEY` and
  `STRIPE_WEBHOOK_SECRET`, plans come from `STRIPE_PLANS`, and the plugin goes last.
- scim needs `drizzleAdapter(..., { transaction: true })`, so its hooks use `getCurrentAdapter`
  (PGlite deadlocks otherwise).

## Dev mail sink

`DEV_MAIL_SINK=true` (refused unless `NODE_ENV` is development or test) keeps auth emails in memory
instead of sending them through SES. `GET /api/dev/mail?to=` returns them, and the e2e tests read
their links there.

## Auth email locally

To send real auth emails from `pnpm dev`, reuse an AWS account where Wraps is already deployed
(`wraps email init`): its SES must be out of the sandbox, with the domain of `EMAIL_FROM` verified.
In `.env`:

- `AWS_PROFILE`: an SSO profile for that account (`aws sso login` first). The AWS SDK reads it; no
  code passes it. The region is Wraps' default, `us-east-1`.
- `EMAIL_FROM`: an address on the verified domain.
- `DEV_MAIL_SINK` unset, or the emails stay in memory.

The identity's default configuration set (`wraps email init` names it `wraps-email-<domain>`)
publishes its SES events to EventBridge, local sends included. The deployed `wraps-email-role` trusts
only AWS services, so local sends run as your SSO role, not that one.

If the AWS CLI works but sends fail with Wraps' `CredentialsError`, check the profile for a
`credential_process` line (left by `aws-sso-util`): the JS SDK runs it instead of `sso_session`, and a
stale one fails.

## Exports from `@proof/auth`

- `revokeGrants(db, scope, now)` (`packages/auth/src/member-grants.ts`) ends a grant: it deletes the
  consent, and revokes the refresh and access tokens. `revokeMemberGrants` is the member-scoped form
  used when someone is removed or leaves.
- `memberGrants` (`packages/auth/src/membership.ts`) gives a member's grants in an org.
- `personalSlug(userId)` (`packages/auth/src/membership.ts`) builds a personal organization's slug.
  It is used by `apps/api/src/data/members.ts`.
- `PERSON_ONLY_ACTIONS` (`packages/auth/src/access.ts`) lists the actions no API key may hold:
  `run: ["approve"]`, `entitlements: ["override"]` and the brain's `hq_entry: ["update"]`,
  `hq_proposal: ["decide"]`, `hq_spend: ["grant"]`. A key records spend with `hq_spend: ["record"]` (reserve, settle, record) and asks for a grant with
  `hq_spend: ["request"]` (`request_spend_grant`: a pending request, nothing granted until a
  founder clicks its Slack card). `PERSON_ONLY_RESOURCES` is the owner-only resources plus `subscription` and
  `support` (`docs/support.md`).
- `provisionalSignup` (`packages/auth/src/signup.ts`) reads the database from `auth.db`. It has no
  WeakMap registry.
- JWKS are cached for 60 seconds per auth instance (`JWKS_TTL_MS` in
  `packages/auth/src/principal.ts`).

## Generated files

`packages/db/src/auth-schema.ts` and the drizzle meta come out unformatted. Run `pnpm format` after
generating them.

## Entry points

- `createAuth({ db, secret, baseURL, emailFrom })` (`packages/auth/src/index.ts`) builds the auth
  instance. `auth.db` is its database.
- `createClient()` (`packages/auth/src/client.ts`) is the browser client. It imports only
  `packages/auth/src/access.ts` from the package, so it must not import server modules.
