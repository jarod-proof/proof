# Support

Customer support is [`@byo-oss/support`](https://github.com/byo-oss/support), a better-auth plugin:
tickets, replies, internal notes and canned replies in this app's database, with thread mail out
and Wraps inbound mail in. It is mounted in `createAuth` (`packages/auth/src/index.ts`) right after
`organization()`, and configured in `packages/auth/src/support.ts`. The routes are better-auth's,
under `/api/auth/support/*`; they are not operations, so they are not in the REST API, MCP or the
SDK. The web app mounts the package's React components (see [Web app](#web-app)).

## Who is who

- **Support staff** are members of the operator organization (`OPERATOR_ORGANIZATION_ID`) whose
  role holds `support` actions (`packages/auth/src/access.ts`): owners and admins hold all five
  (`read`, `reply`, `update`, `manage` canned replies, `delete`), members hold `read`, `reply` and
  `update`, and viewers and the capability roles hold none. Support checks the operator membership
  itself, whatever organization the session has active. Unset, nobody is staff.
- **Customers** are signed-in users. They see their own tickets, and tickets shared with an
  organization they are a member of now.
- **Sessions:** cookie sessions only (`acceptSupportSession`). A request that also carries
  `x-api-key` or `Authorization` gets 403 `SESSION_NOT_ACCEPTED`; a key or token alone has no
  session (401). An impersonated session gets 403 `IMPERSONATED_SESSION_NOT_ALLOWED` from the
  impersonation guard (`guards.ts`) before support's own refusal.
- `support` is a person-only resource (`PERSON_ONLY_RESOURCES`): no API key may hold it, and no
  OAuth scope grants it (`OAUTH_SCOPE_GRANTS`). Impersonation grants (`IMPERSONATION_GRANTS`) don't
  include it either.

## Web app

`apps/app` depends on `@byo-oss/support` itself (the React import and Tailwind's `@source` in
`app.css` need it there), and `supportClient()` is in `@proof/auth/client`, so `WebAuth.support`
is the typed client the components take as is.

- **Support widget** (`SupportWidget`, `containers/support-widget.tsx`): last in the top bar of
  every signed-in shell, for the organization the page shows. Not in the admin console, and not
  while an admin is impersonating (support refuses that session). Closed, it refreshes its unread
  count once a minute (`badgePollInterval`).
- **Requester's page** `/account/support` and `/account/support/$id` (`supportTicketPaths.requester`,
  the thread mail and "new reply" link): the widget inline (`variant="inline"`,
  `containers/support-ticket.tsx`), on the thread the URL names or the requester's list. One route
  (`routes/account/support.{-$id}.tsx`): the widget's `onTicketChange` moves the URL when they open
  a ticket, create one or go Back, without remounting it. The top bar's widget stays closed there.
- **Support queue** (`SupportInbox`, `containers/support-admin.tsx`): the admin console's Support
  tab, one route for `/admin/support` and `/admin/support/$id` (`routes/admin/support.{-$id}.tsx`;
  `supportTicketPaths.staff`, the staff notifications' link). The URL opens the ticket
  (`ticketId`) and follows the one staff open (`onTicketChange`); one route keeps the queue mounted,
  so its search, filters and selection stay as tickets open. The tab shows to operator members whose
  role holds `support:read`; the page asks support itself first (`GET /support/agent/tags`): 403 is
  "Not available", 401 goes to sign-in. The session stays on its organization (no `OrgGate`). The
  assignee and @mention pickers list the operator organization's members whose role holds
  `support:read` (better-auth's `list-members` and `checkRolePermission`, `lib/support-api.ts`).
- **Words:** the queue's heading is "Support queue" (`SUPPORT_QUEUE_LABELS`); no visible string says
  "agent" or "inbox".
- **Theme:** the components use shadcn tokens, so they follow the app's theme and dark mode.

## Configuration

| Variable | What it does |
|---|---|
| `OPERATOR_ORGANIZATION_ID` | The staff organization. Unset: every staff route answers 403. |
| `SUPPORT_REPLY_DOMAIN` | Turns on thread mail: agent replies are mailed to the requester with `Reply-To: support+<token>@<domain>`. Unset: nothing is mailed. |
| `SUPPORT_EMAIL_FROM` | The sender, verified in SES. Unset: `EMAIL_FROM`. |
| `WRAPS_INBOUND_KEY`, `WRAPS_INBOUND_BUCKET` | Turn on inbound mail at `POST /api/auth/support/inbound`. Need `SUPPORT_REPLY_DOMAIN`; `@proof/env` names what is missing. Unset: 404 `INBOUND_NOT_CONFIGURED`. |
| `WRAPS_INBOUND_REGION` | The bucket's region. Default `us-east-1`. |
| `SUPPORT_INBOUND_SECRET` | The other inbound source: any relay that POSTs the raw message (`message/rfc822`) with `Authorization: Bearer <secret>` (support's `rawRelay`: Postmark, Mailgun, a Cloudflare Email Worker). Needs `SUPPORT_REPLY_DOMAIN`; not with the Wraps variables. |
| `SUPPORT_REPLY_DELAY_MS` | The delay before an agent's reply is mailed. Unset: support's 2 minutes. |
| `SUPPORT_SWEEP_INTERVAL_MS` | How often the API runs the sweep (below). Default a minute. |

- Thread mail goes the auth emails' way (`supportMailer`, the same `authMailer` builder as the
  notification email, `packages/auth/src/mailer.ts`): through SES with Wraps, or into the dev
  mail sink under `DEV_MAIL_SINK`. Mail goes only to a verified address, two minutes after the reply,
  and is skipped if the requester saw the reply first. Its ticket link is
  `<web origin>/account/support/<id>`. It has the notification email's sending rules: a non-ASCII
  sender display name is sent RFC 2047 encoded, and a bad address or an SES `MessageRejected` or
  `InvalidParameterValue` fails the send at once (a `PermanentMailError` in support), except an
  unverified identity, which retries.
- Inbound: point the Wraps EventBridge API destination at `/api/auth/support/inbound` with the
  header `X-Wraps-Inbound-Key: <WRAPS_INBOUND_KEY>`, and route the reply domain's mail (plus-addresses
  included) and the public support address to Wraps. The raw message is read from the bucket with the
  AWS credential chain, which needs `s3:GetObject` and `s3:ListBucket`.
- Inbound mail threads onto a ticket only when it is DKIM-signed, aligned with its From domain, and
  comes from the requester's verified address (or a member's, on a shared ticket). Anything else
  opens a new private ticket. Support checks the signature against DNS, so the API needs DNS
  (`SupportConfig.inbound.resolver` replaces it; the API tests serve their own keys through it).
- Attachments are off (`attachments` is not set), so uploads answer `STORAGE_NOT_CONFIGURED`.

## Scheduled work

`apps/api/src/support-sweep.ts` runs `sweepAll` from `@byo-oss/core` every minute
(`SUPPORT_SWEEP_INTERVAL_MS`) in the API process: delayed and retried reply mail, closing
tickets solved a week ago, and (notifications' sweep) delayed and retried notification emails. A run has a 20-second budget (or the interval, if shorter) and never
overlaps the last one; the timer is stopped on SIGTERM. Several replicas are safe: support claims
each delivery with a lease.

## Notifications

`supportEvents` (`packages/auth/src/support.ts`) routes support's events through the notification
catalog (`docs/notifications.md`): a new ticket and a customer reply to the staff, a mention to the
agent mentioned, an agent's reply to the requester. An internal note is never routed.

## Cleanup

Support's own hooks clean up after `/organization/delete`, `/organization/remove-member` and
`/organization/leave`, and after a user is deleted. They are not wired into `organizationHooks` as
well. Deletes that skip those endpoints (account deletion's personal organization, SCIM
deprovisioning) still cascade ticket rows through the foreign keys, but a staff member removed by
SCIM keeps their assigned tickets until `deleteMemberData` runs.

## Tables

Migration `0014_support` creates support's tables, generated into `packages/db/src/auth-schema.ts`.
They are the documented exception to the organization rule (`docs/database.md`). Don't query them
from app code.
