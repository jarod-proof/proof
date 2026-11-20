# Glossary

The words the code, the database, the API docs and the UI share. Use these names, in this sense,
everywhere: a new concept gets a line here before it gets code. Keep each entry to one or two lines.

## Tenancy and access

- **Organization** — the tenant. Every request acts in exactly one; every customer-data table has
  `organizationId`. A signup creates a **personal organization** for the new user.
- **Member** — a user's place in an organization, with a **role**: `owner`, `admin`, `member` or `viewer`,
  or a **capability role** (`approver`, `operator`, `billing`): a fixed role that bundles the permissions for
  one job. Roles are fixed in `packages/auth/src/access.ts`; a member may hold several.
- **Catalog** — the one list of resources and actions (`statements` in `packages/auth/src/access.ts`) that
  roles, API-key permissions, OAuth scopes and operations are all expressed in.
- **Permission** — one `resource: [actions]` entry from the catalog, e.g. `project: ["read"]`.
- **Grant** — a permission set a caller holds. Effective access is role ∩ credential, and a request needs a
  single grant that covers all of it.
- **Scope** — a coarse OAuth permission set shown on the consent screen: `read`, `write`, `admin`.
- **Caller** / **principal** — who is making a request: the organization, the **actor** (a user or an API
  key), the grants and the credential kind (`via`). Resolved by `resolvePrincipal` on every request.
- **Active organization** — the organization a session is acting in; the web app sends it as the
  `X-Organization-Id` header and the server refuses a mismatch.
- **Claimed organization** — one whose owner has verified their email. Unclaimed organizations (from
  **provisional signup**, the credential-less `POST /v1/signup`) get the smaller daily limit.
- **Proof** — a gdp-ts value that a fact was checked (`CallerActsFor`, `ProjectInOrg`). Only `proofs/`
  can mint one; every function that touches tenant data takes one.
- **Fresh session** — a session signed in within the last hour (`FRESH_AGE_SECONDS`). Sensitive actions
  (`fresh: true` operations, `FRESH_SESSION_PATHS`) need one, or they fail with `SESSION_NOT_FRESH`.
- **Auth event** — a mapped better-auth call (a sign-in, a failed sign-in, a password change) recorded as an
  audit row for the person's organization. Not the same as an **audit event**: an auth event with no account
  is only logged.

## Credentials and agents

- **API key** — an organization-owned `sk_` credential with its own permissions, never more than its
  creator's. Rate limited per key.
- **OAuth client** — an app (an AI tool, a CLI) that holds a user's consent for an organization and acts
  with a JWT access token carrying an `org` claim.
- **Device grant** — the sign-in for CLIs and agents: `POST /api/auth/device/code`, a person approves at
  `/device`, the client polls for the token. `proof login` is the reference client.
- **Connected agent** — an API key or an OAuth client that can act in the organization right now
  (`list_connected_agents`, `revoke_agent_access`). Not to be confused with a workspace agent.
- **Workspace agent** (or just **agent** in the product) — a worker the organization configures: name,
  default autonomy, the actions that always wait for a person, an energy budget. Has runs.

## Runs

- **Run** — one execution of a workspace agent. Status: `queued`, `running`, `needs_you`, `done`, `failed`.
  Reports its own footprint (energy, tokens, tool calls).
- **Step** — one ordered item of a run's work, as the run view lists it, with optional "38 of 61" progress.
- **Approval** — an action a run wants to take that a person must allow first. `pending`, `approved` or
  `denied`; a decision takes effect 30 seconds later (`effectiveAt`) and can be undone until then.
- **Needs you** — the run status (and the inbox section) for runs waiting on a person: an approval, or a
  failure to look at. The UI's `solar` accent marks it.
- **Steer** — a message a person sends to a running run (`steer_run`). **Defer** pushes a run's attention
  to a later time.
- **Inbox** — the person's list of runs that need them, across the organization.
- **Notification** — an in-app message to one person (`notification` table, @byo-oss/notifications), optionally
  stamped with an organization, shown under the top bar's bell. Not the **Inbox**.
- **Notification event** — one typed event (`NotificationEvent`, `packages/auth/src/notifications.ts`)
  that every notification is sent through; its recipients come from the permission catalog.
- **Delivery** — one notification queued for another channel (email), a `notification_delivery` row.
  It is sent, skipped (read or seen first, throttled) or failed; see `docs/notifications.md`.

## The API

- **Operation** — one unit of the API, defined once with `defineOperation` (name, permissions, input,
  output, examples, handler). REST routes, MCP tools, OpenAPI, `llms.txt` and the SDK are generated from it.
- **Registry** — the list of operations an app serves (`createOperations`); the **surfaces** are REST, MCP,
  the SDK and the CLI.
- **Example** — an operation's documented input (and output or expected error) in `examples`. The
  contract test runs every one; the authorization test reuses the first.
- **Contract** — the committed `apps/api/openapi.json` plus the examples: a diff is a public API change.
- **Hint** — the `hint` field on an error, written for an agent: what to do next.
- **Idempotency key** — a client-chosen key on a write; the same request replays the stored response, a
  different one is `CONFLICT`.
- **Audit event** — a row recording who did which operation in which organization. Writes are audited;
  `FORBIDDEN` and `BAD_REQUEST` attempts are not (yet).
- **Metering** — calls per organization per UTC day against its limit; read-only session calls are free.
- **File store** — where uploaded files live: S3, Cloudflare R2, Vercel Blob or a local directory,
  chosen by `STORAGE_DRIVER` (`@proof/storage`). Unset, uploads are off.
- **Analytics event** — one typed product event (`AnalyticsEvent`, `packages/analytics/src/events.ts`):
  an operation call, a new account, a counted auth event or a page view, with its actor and organization.
  Ids only.
- **Analytics provider** — where analytics events go: the log, PostHog or nowhere, chosen by
  `ANALYTICS_PROVIDER` (`@proof/analytics`). Unset, nothing is captured.
- **Upload** — an image a person or agent sends to be kept in the file store: a person's **avatar**
  (`user.image`) or an organization's **logo** (`organization.logo`). The row keeps its public URL.
- **File sweep** — removing everything under a deleted organization's or person's prefix
  (`org/<id>/`, `user/<id>/`) from the file store, once its row is gone (`apps/api/src/file-sweep.ts`).
  Not the **support sweep** (`support-sweep.ts`): the BYO plugins' scheduled mail and cleanup.

## Feature flags

- **Operator organization** — the one organization that runs the product (`OPERATOR_ORGANIZATION_ID`).
  Only it manages feature flags: its members, keys and agents call the **operator operations**
  (`audience: "operator"`), which other organizations neither see nor may call.
- **Admin console** — the web app's `/admin` pages for the people who run the product: Users for
  platform admins (the user role `admin`), Feature flags for the operator organization's members.
- **Feature flag** — a boolean release switch declared in code (`defineFlag` in
  `packages/flags/src/catalog.ts`): key, description, owner, default. Removing it from the catalog
  makes every call site that still reads it a compile error.
- **Rollout** — a flag's runtime state (a `feature_flag` row): `enabled`, the organizations it
  **targets**, and a **percentage** of every other organization. No row means the default everywhere.
- **Target** — an organization a flag is turned on (allow-list) or off (deny-list) for, whatever the
  percentage.
- **Bucket** — an organization's fixed place, 0 to 9999, for one flag (a hash of key and org id).
  Raising the percentage only adds organizations; it never moves one out.
- **Evaluation** — the value a flag has for one organization, with its OpenFeature reason (`STATIC`,
  `TARGETING_MATCH`, `SPLIT`, `DISABLED`). Always for the caller's own organization.
- **Exposure** — one evaluation, counted per flag, value and UTC day (`feature_flag_exposure_daily`):
  the evidence for the **stale signals** (inactive, one value only, reclaimed but still in code).
- **Reclaim** — the decision that ends a rollout: the flag serves one value to everyone and can no
  longer change. Then its code is removed, and after that deploy its rollout is deleted.

## Plans

- **Plan** — what an organization's subscription includes: Free, Pro or Team, declared once in
  `packages/plans/src/catalog.ts` (`@proof/plans`) for the API, the web app and the pricing page.
  Without a subscription an organization is on Free. Prices are in Stripe, not in the catalog.
- **Entitlement** — what the plan allows an organization: a **feature** (on or off) or a **limit**
  (requests per UTC day, seats, agents, run history days), checked through
  `@byo-oss/entitlements` (`auth.entitlements`). A refusal names the plan that would allow it.
- **Seat** — a member who holds any role but viewer. Viewers are free on every plan.
- **Override** — a staff grant for one organization (a feature, a limit or another plan), with a
  reason and an optional expiry, set only by the operator organization's owners and admins.

## Support

- **Support ticket** — a customer's request to the people who run the product (`@byo-oss/support`,
  `docs/support.md`): replies, internal notes and events. Owned by its **requester**; may be shared
  with the requester's organization. A ticket opened by email has no organization.
- **Support staff** — the operator organization's members whose role holds `support` actions. The
  package and its UI call them **agents**; in this app "agent" alone means a workspace agent.
- **Support queue** — the staff's list of tickets (the package's `SupportInbox`). Not the **Inbox**.
- **Internal note** — a staff-only message on a ticket. Never shown, mailed or notified to a customer.

## The brain (`apps/hq`)

- **Founder** — a row of hq's `founders` table: an hq account and its Slack user. The table is the one
  source of who the founders are. It is set from `HQ_FOUNDERS` at every boot (the listed are added, the
  rest removed; an unverified or unknown address is skipped) and nothing in the API writes it, so no key
  can add one. hq's sign-up is closed unless `HQ_ALLOW_SIGNUP` (local and e2e stacks only: a deployed hq,
  one whose `NODE_ENV` is not development or test, refuses to boot with it on), and signing up makes no
  one a founder. In a deployed hq the account is made on the server by `pnpm --filter @proof/hq
  create-founder --email <e> --slack-id <U..> --password-out <file>` (verified address, generated
  password written only to that 0600 file), and is a founder because `HQ_FOUNDERS` pins it by id
  (`id:<user id>=<slack user id>`, which the script prints): an email entry is not honoured there, so an
  account someone else registered with the founder's address is never one, even after the founder
  verifies it. Only a founder uses hq, and only a founder decides a proposal, edits an entry, grants
  spend or clicks Approve in Slack. The agent's `AGENT_FOUNDER_PRINCIPALS` is derived from the table
  (`pnpm --filter @proof/hq founders:principals`, with `--check` to fail on drift; `pnpm hq:predeploy`
  runs the check before a deploy).
- **Card** — a Slack message block with buttons a founder clicks: a **proposal** card (Approve, Reject;
  its button ids carry the proposal and the version it was proposed against) or a **grant** card. The
  agent forwards the click, unchanged, to hq, which verifies Slack's signature over the same bytes and
  decides it as the founder the Slack user maps to. A replayed or stale click changes nothing.
- **Digest** — the nightly 07:00 UTC Slack message: yesterday's runs and spend and one card per pending
  proposal. Posted by the agent without a model call; its own run and a zero cost are recorded in hq.
- **Installation token** — a short-lived GitHub App token the agent mints from the app's private key
  (`apps/agent/agent/lib/github/app-token.ts`), narrowed to one repository and the permissions a lease
  needs.
- **Entry** — one thing the org knows: a `fact`, `voice`, `decision`, `playbook` or `customer`, named by
  a slug unique within its kind. Its content is in its **versions**.
- **Version** — one numbered, dated state of an entry, with its author (a person or an agent) and where it
  came from. An edit adds a version; none is ever updated or deleted.
- **Proposal** — an agent's or an outside write's request to add or change an entry. It stays `pending`
  until a founder approves (which writes the next version) or rejects it; the **base version** it was
  made against must still be the entry's newest, or approving is a CONFLICT.
- **HQ run** — one execution the factory ran and hq logged (`record_run`, `finish_run`): a chat or
  schedule on Eve, a build in a sandbox, a review on the box. Its cost is the sum of its spend. Not the
  product's **run** (a workspace agent's execution).
- **Spend** — one model charge in the ledger, by source (`eve`, `build`, `box`). `estimated` marks a cost
  the provider did not report, stored at the caller's estimate. Money is exact: integer units of $0.0001.
- **Daily cap** — $10.00 per UTC day on Eve chat and schedules (source `eve`) only; builds and box runs
  record their cost but sit outside it.
- **Hold** — a turn's estimated cost, reserved (`reserve_spend`) before it starts and settled
  (`settle_spend`) when it ends. A hold nobody settles in 15 minutes counts as spent at its estimate.
- **Allowance** — what is left of today's cap: cap plus **spend grants**, less settled spend and holds.
- **Spend grant** — a founder's extra allowance for one day (`grant_spend`, or a click on a **grant
  request**'s card). A person's action, never a key's. Not an auth **grant**.
- **Grant request** — what a Slack grant card is bound to: a pending row hq recorded when a key called
  `request_spend_grant` (up to $25, ten a UTC day), with the amount fixed in hq. A founder's click redeems
  it by id, once, within 24 hours, for that amount (the click's own amount is never read); an id hq never
  recorded, a replay or an expired request grants nothing. `SLACK_SIGNING_SECRET` is still a
  founder-level credential: with it, a click can approve any pending proposal, and whoever holds both
  it and the agent's hq key can request a grant and redeem it, so grants through Slack are bounded: at
  most $25 a request, 10 requests a UTC day, and $50 a UTC day in all (`HQ_SLACK_DAILY_GRANT_CAP_USD`;
  a click that would pass it is refused and the request stays pending). Treat the secret as a
  founder's.
- **Bigger-model request** — the agent's `request_bigger_model` tool: it asks a founder, in Slack, to
  approve a dearer model for one hard question, with an estimate. Nothing runs on the bigger model
  before a listed founder approves.

## The web app

- **App** — the signed-in product (`apps/app`, `@proof/app`) at `app.` on the product domain.
- **Site** — the public website at the apex domain: marketing, pricing, docs, changelog and `llms.txt`.
  It will live in `apps/site` (`@proof/site`), which does not exist yet. Not the **app**.
- **D+** — the design system: warm paper and ink, the `solar` "needs you" accent, 8px radius, 2px ink
  borders. Lives in `packages/ui/src/styles.css` and `src/dplus`.
- **Board** — a design board in `docs/build-app/boards`; each page follows its board's journey, and the
  e2e test for the page follows the same journey.
- **Container** / **page** — the web app's split: a container (`src/containers`) owns data and mutations, a
  page (`src/pages`) is presentational, props in and callbacks out.
- **Shell** — the app frame (sidebar, topbar, command palette) in `@proof/ui/dplus/shell`.
