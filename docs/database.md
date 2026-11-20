# Database and auth

- App tables go in `packages/db/src/schema.ts`. Auth tables (`user`, `session`, `account`,
  `verification`) are generated into `src/auth-schema.ts`. Regenerate them with
  `pnpm --filter @proof/auth generate` after changing auth options or plugins.
- New migration: `pnpm --filter @proof/db db:generate`, then commit the SQL in
  `packages/db/drizzle/`.
- Applying migrations (`db:migrate`, `drizzle-kit push`) is denied for agents. Ask the user to run
  them, or to run `scripts/release.mjs` in a deploy.
- Each git worktree made with `pnpm wt` has its own database, `proof_wt_<name>`, with that
  branch's migrations applied. `pnpm wt reset-db` rebuilds it. Agents run these; the main database
  stays the user's. See `docs/tooling.md` (Worktrees).

## Migrations

- `0001_agent_auth` adds the API key, JWKS and OAuth tables (apikey, jwks, oauth_*).
- `0002_organizations` adds organization, member, invitation, `session.active_organization_id` and
  the example `project` table.
- `0003_agent_distribution` adds `audit_event`, `usage_daily`, `idempotency_key`,
  `signup_attempt` and the device grant's `device_code` table. The first three cascade from
  `organization`. `signup_attempt` is keyed by IP and email domain, not by org.
- `0004_auth_plugins` (passkey, two_factor, admin fields), `0005_sso_scim_stripe`, `0006_agent_runs`
  (agent, run, run_step, approval, steer_message; tenant tables), `0007_session_login_method`,
  `0008_sso_domain_verification` and `0009_steer_message_org_index`.
- `0010_notifications` adds @byo-oss/notifications' `notification` table. The table is generated into
  `auth-schema.ts`, and the migration appends two custom statements: the
  `(user_id, organization_id, created_at)` index, and a cascading foreign key from
  `organization_id` to `organization`. @byo-oss/notifications' schema option can't declare either. Neither
  is in the Drizzle snapshot, so `db:generate` leaves them alone; `drizzle-kit push` would drop
  them. `organization_id` is nullable: a personal notice (account security, removal from an org)
  belongs to the user, not to a tenant. With `support_ticket.organization_id` (0013), it is one of
  the two customer-data columns allowed to be null. See `docs/notifications.md`.
- `0011_auth_hardening` adds:
  - `rate_limit`, the counts for the auth rate limits (`packages/auth/src/rate-limit.ts`);
  - composite indexes for the OAuth grant check (`oauth_consent` and `oauth_refresh_token`, by
    client, organization and user; `grantStands` in `packages/auth/src/principal.ts`), declared in
    `withGrantIndexes()` in `packages/auth/src/index.ts` so `auth generate` keeps them. A plain
    `CREATE INDEX` blocks writes while it builds; on a large table, run
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS` by hand, with the same names and columns, before
    applying 0011; its own statements are `IF NOT EXISTS`, so they then skip. `IF NOT EXISTS` goes
    by name only, and a failed `CONCURRENTLY` build leaves an invalid index it would skip too, so
    check `pg_index.indisvalid` is true for both first. They made the
    single-column `clientId` indexes on those tables redundant; 0016 drops them;
  - `member.source`: `"scim"` for a membership the directory created, else null. SCIM
    deprovisioning removes only those (`packages/auth/src/scim-projection.ts`).
- `0013_notification_email` adds better-inbox 0.6's email delivery: `notification.seen_at`, the
  `notification_delivery` queue (indexed by status and due time, and by person, type and channel
  for throttling; declared in `withDeliveryIndexes()` so `auth generate` keeps them) and
  `inbox_presence` (when each person's bell last polled). See `docs/notifications.md`.
  @byo-oss/notifications 0.8 declares `onDelete: "cascade"` on its references; the generated schema
  already had it, so 0.8 needs no migration.
- `0014_support` adds `@byo-oss/support`'s tables, generated into `auth-schema.ts`:
  `support_ticket`, `support_message`, `support_ticket_tag`, `support_canned_reply`,
  `support_counter` and `support_delivery` (`docs/support.md`). They are the documented exception to
  "every customer-data table has `organizationId`", checked in `packages/db/src/schema.test.ts`:
  - `support_ticket.organization_id` cascades from `organization` but is nullable: a ticket opened
    by email has no organization, and a requester keeps their own tickets.
  - `support_message`, `support_ticket_tag` and `support_delivery` have no `organization_id`. They
    belong to a ticket and cascade from it.
  - `support_canned_reply` and `support_counter` belong to the support staff (the operator
    organization), not to a customer.
  - Don't query or write them from app code: go through `auth.api.*` and the package's functions.
  - `support_delivery` exists only with thread mail on, so `auth.cli.ts` turns it on with
    placeholders. `support_attachment` (attachments) is not generated: attachments are off.
  - `support_ticket.merged_into_id` (a merged ticket's target) has no foreign key: support clears
    it when it deletes the target, and a link to a ticket that is gone stays on the merged ticket.
- `0015_entitlements` adds `@byo-oss/entitlements`' tables, generated into `auth-schema.ts`:
  `entitlement_snapshot` (one row per organization: the cached billing state), `entitlement_override`
  (staff grants, kept after they end) and `entitlement_usage` (the metered counters, the daily
  `requests` meter among them). Each `organization_id` cascades from `organization` through a
  foreign key the plugin schema declares (no hand-appended statement, unlike 0010); the override's
  `created_by`/`removed_by` are `set null` on user delete. Don't read them from app code: go through
  `auth.entitlements` and `auth.api.*` (`packages/auth/src/entitlements.ts`). `usage_daily` (0003) is
  no longer written: the meter moved to `entitlement_usage`.
- `0016_drop_oauth_client_id_indexes` drops `oauthConsent_clientId_idx` and
  `oauthRefreshToken_clientId_idx`, which 0011's composite indexes cover. Those lead with
  `client_id`, so the `oauth_client` cascade stays indexed. `withGrantIndexes()` turns off the
  plugin field's index so `auth generate` doesn't bring them back. A plain `DROP INDEX` takes an
  `ACCESS EXCLUSIVE` lock: it blocks reads and writes on the table while it waits for and holds
  that lock. The drop is quick, but it queues behind long transactions and everything queues behind
  it. Don't run `DROP INDEX CONCURRENTLY` by hand first: 0016's statements have no `IF EXISTS`, so
  it would then fail. On a large, busy table, apply it in a quiet window. Not applied yet: the user
  applies migrations, agents don't.

## Cleanup

`pnpm --filter @proof/api-app cleanup` (`apps/api/src/cleanup.ts`, `apps/api/src/data/cleanup.ts`)
deletes, in batches of 1000: signup attempts older than 25 hours (the window is coupled by hand to
`signup.ts`), expired idempotency keys, and expired `device-org:` verification rows. It is
cross-tenant and takes no proof, and only the entry calls it, never a request. Schedule it hourly;
it exits 1 on failure.
