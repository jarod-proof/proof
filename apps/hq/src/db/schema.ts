import { sql } from "drizzle-orm"
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core"

/**
 * hq's own tables live in the `hq` Postgres schema, beside starter's auth tables in `public`
 * (both sets sit in the hq database, HQ_DATABASE_URL). Task 5 adds the brain's entries and
 * proposals; Task 6 adds runs and the spend ledger.
 */
export const hq = pgSchema("hq")

/** The kinds of entry the brain holds. A slug is unique within its kind. */
export const ENTRY_KINDS = ["fact", "voice", "decision", "playbook", "customer"] as const
export type EntryKind = (typeof ENTRY_KINDS)[number]

/** Who wrote a version or made a proposal: a signed-in person, or an agent (a key, an AI client). */
export const AUTHOR_TYPES = ["person", "agent"] as const
export type AuthorType = (typeof AUTHOR_TYPES)[number]

export const PROPOSAL_STATUSES = ["pending", "approved", "rejected"] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

// Timestamps are stamped from the app's clock (`now()`), not by column defaults, so tests can move
// time, and they carry a time zone so the stored instant never depends on the session's.
const at = (name: string) => timestamp(name, { withTimezone: true })

/** One thing the org knows. Its content is in `entry_versions`; an entry is only the identity. */
export const entries = hq.table(
  "entries",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ENTRY_KINDS }).notNull(),
    slug: text("slug").notNull(),
    createdAt: at("created_at").notNull(),
  },
  (t) => [unique("entries_kind_slug_unique").on(t.kind, t.slug)],
)

/** Every version of an entry, forever: an edit adds a row, nothing is updated or deleted. */
export const entryVersions = hq.table(
  "entry_versions",
  {
    id: text("id").primaryKey(),
    entryId: text("entry_id")
      .notNull()
      .references(() => entries.id),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    body: jsonb("body").$type<EntryBody>().notNull(),
    /** Where the content came from, e.g. `proposal:<id>`; null for a person's own edit. */
    source: text("source"),
    authorType: text("author_type", { enum: AUTHOR_TYPES }).notNull(),
    authorId: text("author_id").notNull(),
    runId: text("run_id"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [unique("entry_versions_entry_version_unique").on(t.entryId, t.version)],
)

/**
 * A change an agent or an external write asks for. Only a founder turns it into a version
 * (the trust rule). `base_version` is the version the proposer read; null when the entry is new.
 */
export const proposals = hq.table(
  "proposals",
  {
    id: text("id").primaryKey(),
    entryId: text("entry_id").references(() => entries.id),
    kind: text("kind", { enum: ENTRY_KINDS }).notNull(),
    slug: text("slug").notNull(),
    baseVersion: integer("base_version"),
    title: text("title").notNull(),
    body: jsonb("body").$type<EntryBody>().notNull(),
    reason: text("reason").notNull(),
    status: text("status", { enum: PROPOSAL_STATUSES }).notNull(),
    proposedByType: text("proposed_by_type", { enum: AUTHOR_TYPES }).notNull(),
    proposedById: text("proposed_by_id").notNull(),
    runId: text("run_id"),
    decidedBy: text("decided_by"),
    decidedAt: at("decided_at"),
    /** The founder's note with the decision. */
    decisionNote: text("decision_note"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [index("proposals_status_created_idx").on(t.status, t.createdAt)],
)

/**
 * The founders: the one source for who may decide a proposal, edit an entry, grant spend or click
 * Approve in Slack. A row maps an hq account to a Slack user. Nothing in the API writes it: hq
 * syncs it from HQ_FOUNDERS (data/founders.ts: a local hq at boot, a deployed one at predeploy),
 * adding the listed and removing the rest.
 */
export const founders = hq.table(
  "founders",
  {
    userId: text("user_id").primaryKey(),
    slackUserId: text("slack_user_id").notNull(),
    createdAt: at("created_at").notNull(),
  },
  (t) => [unique("founders_slack_user_id_unique").on(t.slackUserId)],
)

/**
 * What a Slack click already did, so a replay does nothing twice. `key` names the thing decided
 * (`grant:<request id>`); the first click to insert it wins, in the same transaction as its effect.
 */
export const slackActions = hq.table("slack_actions", {
  key: text("key").primaryKey(),
  /** What the click did: `grant` or `deny`. */
  outcome: text("outcome").notNull(),
  slackUserId: text("slack_user_id").notNull(),
  userId: text("user_id").notNull(),
  /** Slack's `action_ts` for the click, for the audit trail. */
  actionTs: text("action_ts"),
  createdAt: at("created_at").notNull(),
})

/** An entry's content: prose in `text`, plus any structured fields the kind needs. */
export interface EntryBody {
  text: string
  [field: string]: unknown
}

/** What ran: a Slack chat or schedule on Eve, a build in a sandbox, a review on the box. */
export const RUNNERS = ["eve", "sandbox", "box"] as const
export type Runner = (typeof RUNNERS)[number]

export const RUN_OUTCOMES = ["succeeded", "failed", "stopped"] as const
export type RunOutcome = (typeof RUN_OUTCOMES)[number]

/** Where spend came from. Only `eve` (chat and schedules) counts toward the daily cap. */
export const SPEND_SOURCES = ["eve", "build", "box"] as const
export type SpendSource = (typeof SPEND_SOURCES)[number]

/** What a finished run reports: what worked, what failed, and what made it stop. */
export interface RunSummary {
  worked: string[]
  failed: string[]
  stop: string[]
}

/** One execution the factory ran. Its cost is the sum of its `spend` rows. */
export const runs = hq.table(
  "runs",
  {
    id: text("id").primaryKey(),
    task: text("task").notNull(),
    trigger: text("trigger").notNull(),
    runner: text("runner", { enum: RUNNERS }).notNull(),
    startedAt: at("started_at").notNull(),
    endedAt: at("ended_at"),
    outcome: text("outcome", { enum: RUN_OUTCOMES }),
    link: text("link"),
    summary: jsonb("summary").$type<RunSummary>(),
  },
  (t) => [index("runs_started_idx").on(t.startedAt)],
)

// Money is numeric(10,4): exact decimals, 0.0001 dollar at the finest. Rows are read as text and
// computed on as integer units of $0.0001 (src/data/money.ts), never as JS floats. `day` is the UTC
// day: a date with no time zone, derived from the app's clock.

/** One model charge. `estimated` is true when the provider reported no cost and an estimate stood in. */
export const spend = hq.table(
  "spend",
  {
    id: text("id").primaryKey(),
    runId: text("run_id"),
    day: date("day", { mode: "string" }).notNull(),
    source: text("source", { enum: SPEND_SOURCES }).notNull(),
    amountUsd: numeric("amount_usd", { precision: 10, scale: 4 }).notNull(),
    model: text("model").notNull(),
    estimated: boolean("estimated").notNull(),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    index("spend_day_source_idx").on(t.day, t.source),
    check("spend_amount_nonnegative", sql`${t.amountUsd} >= 0`),
  ],
)

/** Where a spend grant request stands. Only a pending one can be decided, once. */
export const GRANT_REQUEST_STATUSES = ["pending", "granted", "rejected", "expired"] as const
export type GrantRequestStatus = (typeof GRANT_REQUEST_STATUSES)[number]

/**
 * What a Slack grant card is bound to: a request hq itself recorded (an agent asked, with a reason
 * and an amount fixed here). A click can only redeem a pending row by its id, once; the amount is
 * the row's, never the click's. Nothing but `request_spend_grant` inserts one.
 */
export const spendGrantRequests = hq.table(
  "spend_grant_requests",
  {
    id: text("id").primaryKey(),
    amountUsd: numeric("amount_usd", { precision: 10, scale: 4 }).notNull(),
    reason: text("reason").notNull(),
    runId: text("run_id"),
    status: text("status", { enum: GRANT_REQUEST_STATUSES }).notNull(),
    /** The key (or person) that asked: an id from the caller, for the audit trail. */
    requestedBy: text("requested_by").notNull(),
    createdAt: at("created_at").notNull(),
    decidedAt: at("decided_at"),
    decidedBy: text("decided_by"),
  },
  (t) => [
    index("spend_grant_requests_created_idx").on(t.createdAt),
    check("spend_grant_requests_amount_positive", sql`${t.amountUsd} > 0`),
    // The most one request (and so one click) may grant: the row is the last line of defence,
    // since a redeem trusts its amount. Keep in step with MAX_GRANT_REQUEST_USD (data/grant-requests.ts).
    check("spend_grant_requests_amount_max", sql`${t.amountUsd} <= 25`),
  ],
)

/** A founder's extra allowance for one day (a spend grant); it raises that day's remaining. */
export const spendGrants = hq.table(
  "spend_grants",
  {
    id: text("id").primaryKey(),
    day: date("day", { mode: "string" }).notNull(),
    amountUsd: numeric("amount_usd", { precision: 10, scale: 4 }).notNull(),
    grantedBy: text("granted_by").notNull(),
    reason: text("reason").notNull(),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    index("spend_grants_day_idx").on(t.day),
    check("spend_grants_amount_positive", sql`${t.amountUsd} > 0`),
  ],
)

/**
 * A reservation a turn takes before it starts: its estimate counts against the day until it is
 * settled into a `spend` row. A hold nobody settled still counts at its estimate, forever.
 */
export const spendHolds = hq.table(
  "spend_holds",
  {
    id: text("id").primaryKey(),
    day: date("day", { mode: "string" }).notNull(),
    estimateUsd: numeric("estimate_usd", { precision: 10, scale: 4 }).notNull(),
    runId: text("run_id"),
    createdAt: at("created_at").notNull(),
    settledAt: at("settled_at"),
  },
  (t) => [
    index("spend_holds_day_idx").on(t.day),
    check("spend_holds_estimate_positive", sql`${t.estimateUsd} > 0`),
  ],
)
