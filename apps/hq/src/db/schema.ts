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
  uniqueIndex,
} from "drizzle-orm/pg-core"

// The work pipeline's vocabulary lives in the pure machine; the schema imports it, never the
// reverse. Text enums are TypeScript-only (no database enum type), so a new value costs no migration.
import {
  ATTEMPT_KINDS,
  ATTEMPT_RESULTS,
  ATTEMPT_STATUSES,
  SIGNAL_SOURCES,
  VERIFIER_KINDS,
  WORK_ACTORS,
  WORK_STATES,
} from "../work/machine"
import {
  CONTRACT_ITEM_STATUSES,
  MERGE_APPROVAL_STATUSES,
  PULL_REQUEST_STATES,
  type PullRequestCheck,
  type QuestionOptionInput,
  QUESTION_STATUSES,
  REVIEWER_VERDICTS,
  WINDOW_STATUSES,
  WORK_EVENT_KINDS,
} from "../work/types"

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

// ---------------------------------------------------------------------------------------------
// The work pipeline (Phase 4): signals become work items that move through the state machine of
// work/machine.ts. Every state change is an append-only `work_item_events` row.
// ---------------------------------------------------------------------------------------------

/** Who made a work item or recorded a signal: a person, an agent key, or hq itself. */
export const WORK_AUTHOR_TYPES = [...AUTHOR_TYPES, "system"] as const
export type WorkAuthorType = (typeof WORK_AUTHOR_TYPES)[number]

export {
  CONTRACT_ITEM_STATUSES,
  MERGE_APPROVAL_STATUSES,
  QUESTION_STATUSES,
  WINDOW_STATUSES,
  WORK_EVENT_KINDS,
}
export type ContractItemStatus = (typeof CONTRACT_ITEM_STATUSES)[number]
export type QuestionStatus = (typeof QUESTION_STATUSES)[number]
export type MergeApprovalStatus = (typeof MERGE_APPROVAL_STATUSES)[number]
export type WindowStatus = (typeof WINDOW_STATUSES)[number]
export type WorkEventKind = (typeof WORK_EVENT_KINDS)[number]

/**
 * One piece of work. `number` is the display id's number (`FAC-<number>`): the database hands it
 * out (generated always as identity): an insert that sets it is refused (OVERRIDING SYSTEM VALUE
 * aside), and the unique constraint on it stops a number being used twice. `cycle` counts how many
 * times the item has been reopened (starting at 1); `attempt_limit` is the item's own, null until
 * an attempt records one.
 */
export const workItems = hq.table(
  "work_items",
  {
    id: text("id").primaryKey(),
    number: integer("number").notNull().generatedAlwaysAsIdentity(),
    title: text("title").notNull(),
    repo: text("repo").notNull(),
    source: text("source", { enum: SIGNAL_SOURCES }).notNull(),
    state: text("state", { enum: WORK_STATES }).notNull(),
    cycle: integer("cycle").notNull().default(1),
    dedupeKey: text("dedupe_key"),
    attemptLimit: integer("attempt_limit"),
    createdByType: text("created_by_type", { enum: WORK_AUTHOR_TYPES }).notNull(),
    createdById: text("created_by_id").notNull(),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
    stateChangedAt: at("state_changed_at").notNull(),
  },
  (t) => [
    unique("work_items_number_unique").on(t.number),
    index("work_items_state_idx").on(t.state),
    index("work_items_dedupe_created_idx").on(t.dedupeKey, t.createdAt),
  ],
)

/** One occurrence of something that may need work. The first makes an item; the rest attach to it. */
export const signals = hq.table(
  "signals",
  {
    id: text("id").primaryKey(),
    source: text("source", { enum: SIGNAL_SOURCES }).notNull(),
    externalId: text("external_id").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    repo: text("repo").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    url: text("url"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    occurredAt: at("occurred_at").notNull(),
    receivedAt: at("received_at").notNull(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItems.id),
    // person | agent | system: the data layer maps a founder actor to `person` (decision at W2).
    recordedByType: text("recorded_by_type", { enum: WORK_AUTHOR_TYPES }).notNull(),
    recordedById: text("recorded_by_id").notNull(),
  },
  (t) => [
    unique("signals_source_external_id_unique").on(t.source, t.externalId),
    index("signals_dedupe_occurred_idx").on(t.dedupeKey, t.occurredAt),
    index("signals_item_idx").on(t.itemId),
  ],
)

/**
 * One try at an item: an investigation or a fix, claimed by a session. `number` counts per item
 * and keeps counting across cycles; `cycle` is the item's cycle when the attempt was inserted
 * (no default: the data layer copies it). One requested or running attempt per item, enforced
 * here by a partial unique index.
 */
export const attempts = hq.table(
  "attempts",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItems.id),
    number: integer("number").notNull(),
    cycle: integer("cycle").notNull(),
    kind: text("kind", { enum: ATTEMPT_KINDS }).notNull(),
    status: text("status", { enum: ATTEMPT_STATUSES }).notNull(),
    result: text("result", { enum: ATTEMPT_RESULTS }),
    requestedBy: text("requested_by"),
    instructions: text("instructions"),
    claimedAt: at("claimed_at"),
    startedAt: at("started_at"),
    leaseExpiresAt: at("lease_expires_at"),
    lastHeartbeatAt: at("last_heartbeat_at"),
    finishedAt: at("finished_at"),
    durationMs: integer("duration_ms"),
    files: jsonb("files").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    note: text("note"),
    branch: text("branch"),
    reviewerVerdict: text("reviewer_verdict", { enum: REVIEWER_VERDICTS }),
    reviewerSummary: text("reviewer_summary"),
    reviewedHeadSha: text("reviewed_head_sha"),
    /** The run that did the work; its cost is the sum of that run's `spend` rows. */
    runId: text("run_id"),
    /** A soft reference into Phase 2's redacted session store: no foreign key, no transcript here. */
    sessionId: text("session_id"),
    /**
     * The agent's own handle for the session that runs the attempt: an intake ticket id, or for a
     * station attempt the idempotency key `<sessionId>:<callId>:<station>`.
     */
    externalRef: text("external_ref"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    unique("attempts_item_number_unique").on(t.itemId, t.number),
    uniqueIndex("attempts_one_active_per_item_idx")
      .on(t.itemId)
      .where(sql`${t.status} in ('requested', 'running')`),
    uniqueIndex("attempts_item_external_ref_idx")
      .on(t.itemId, t.externalRef)
      .where(sql`${t.externalRef} is not null`),
  ],
)

/** A pull request as GitHub reported it to the agent; hq makes no call of its own. */
export const pullRequests = hq.table(
  "pull_requests",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItems.id),
    attemptId: text("attempt_id"),
    number: integer("number").notNull(),
    url: text("url").notNull(),
    branch: text("branch").notNull(),
    base: text("base").notNull(),
    headSha: text("head_sha").notNull(),
    isDraft: boolean("is_draft").notNull(),
    state: text("state", { enum: PULL_REQUEST_STATES }).notNull(),
    additions: integer("additions"),
    deletions: integer("deletions"),
    files: integer("files"),
    checks: jsonb("checks").$type<PullRequestCheck[]>().notNull().default(sql`'[]'::jsonb`),
    openedAt: at("opened_at").notNull(),
    mergedAt: at("merged_at"),
    closedAt: at("closed_at"),
    /** The GitHub login that merged it. */
    mergedBy: text("merged_by"),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [
    unique("pull_requests_item_number_unique").on(t.itemId, t.number),
    index("pull_requests_branch_idx").on(t.branch),
  ],
)

/** What the item's fix must satisfy, recorded before the first attempt; one set per cycle. */
export const contractItems = hq.table(
  "contract_items",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItems.id),
    cycle: integer("cycle").notNull(),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    verifierKind: text("verifier_kind", { enum: VERIFIER_KINDS }).notNull(),
    verifierConfig: jsonb("verifier_config").$type<Record<string, unknown>>(),
    status: text("status", { enum: CONTRACT_ITEM_STATUSES }).notNull(),
    evidence: text("evidence"),
    checkedAt: at("checked_at"),
    // person | agent | system: the data layer maps a founder actor to `person` (decision at W2).
    createdByType: text("created_by_type", { enum: WORK_AUTHOR_TYPES }).notNull(),
    createdById: text("created_by_id").notNull(),
  },
  (t) => [unique("contract_items_item_cycle_position_unique").on(t.itemId, t.cycle, t.position)],
)

/** A question the agent put to a founder. It waits until a founder answers; the default only advises. */
export const agentQuestions = hq.table(
  "agent_questions",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItems.id),
    attemptId: text("attempt_id"),
    prompt: text("prompt").notNull(),
    options: jsonb("options").$type<QuestionOptionInput[]>().notNull(),
    defaultOptionId: text("default_option_id"),
    status: text("status", { enum: QUESTION_STATUSES }).notNull(),
    answeredOptionId: text("answered_option_id"),
    answerNote: text("answer_note"),
    /** The founder's user id. */
    answeredBy: text("answered_by"),
    answeredAt: at("answered_at"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    index("agent_questions_item_idx").on(t.itemId),
    index("agent_questions_status_idx").on(t.status),
  ],
)

/**
 * A founder's go-ahead to merge one pull request at one head sha. A pull request has at most one
 * pending approval at a time (a push or a close voids it first); approving changes nothing on GitHub.
 */
export const mergeApprovals = hq.table(
  "merge_approvals",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItems.id),
    pullRequestId: text("pull_request_id")
      .notNull()
      .references(() => pullRequests.id),
    headSha: text("head_sha").notNull(),
    status: text("status", { enum: MERGE_APPROVAL_STATUSES }).notNull(),
    requestedAt: at("requested_at").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: at("decided_at"),
    note: text("note"),
  },
  (t) => [
    uniqueIndex("merge_approvals_one_pending_per_pull_request_idx")
      .on(t.pullRequestId)
      .where(sql`${t.status} = 'pending'`),
  ],
)

/** The span after a merge in which a recurrence of the signal reopens the item; one per cycle. */
export const verificationWindows = hq.table(
  "verification_windows",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItems.id),
    cycle: integer("cycle").notNull(),
    startsAt: at("starts_at").notNull(),
    endsAt: at("ends_at").notNull(),
    status: text("status", { enum: WINDOW_STATUSES }).notNull(),
    checkedAt: at("checked_at"),
    resultNote: text("result_note"),
  },
  (t) => [unique("verification_windows_item_cycle_unique").on(t.itemId, t.cycle)],
)

/**
 * Everything that happened to an item, forever: an event is never updated or deleted (a trigger,
 * migration `work_events_append_only`). Time in each stage is read from the `transition` rows.
 */
export const workItemEvents = hq.table(
  "work_item_events",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItems.id),
    at: at("at").notNull(),
    kind: text("kind", { enum: WORK_EVENT_KINDS }).notNull(),
    fromState: text("from_state", { enum: WORK_STATES }),
    toState: text("to_state", { enum: WORK_STATES }),
    actorType: text("actor_type", { enum: WORK_ACTORS }).notNull(),
    actorId: text("actor_id").notNull(),
    reason: text("reason"),
    note: text("note"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    cycle: integer("cycle").notNull(),
  },
  (t) => [index("work_item_events_item_at_idx").on(t.itemId, t.at)],
)
