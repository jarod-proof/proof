// Auth tables (user, session, account, verification, organization, member, ...) are generated:
//   pnpm --filter @proof/auth generate
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core"
import { organization } from "./auth-schema"

export * from "./auth-schema"

// Example tenant-owned table. Every app table that holds customer data has `organizationId`, and
// every query on it filters by the caller's organization (see the agent-api skill).
export const project = pgTable(
  "project",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("project_organizationId_idx").on(t.organizationId)],
)

// Who did what, in which organization. `at` has millisecond precision so a cursor built from it
// round-trips exactly (keyset pagination on (at, id)).
export const auditEvent = pgTable(
  "audit_event",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    at: timestamp("at", { precision: 3 }).notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    clientId: text("client_id"),
    operation: text("operation").notNull(),
    outcome: text("outcome").notNull(),
    requestId: text("request_id"),
  },
  (t) => [index("audit_event_org_at_idx").on(t.organizationId, t.at, t.id)],
)

// Calls per organization, per UTC day, per operation. Incremented with an upsert.
export const usageDaily = pgTable(
  "usage_daily",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    day: text("day").notNull(),
    operation: text("operation").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [unique("usage_daily_org_day_op_key").on(t.organizationId, t.day, t.operation)],
)

// Idempotency-Key records. A key is reserved before the handler runs (`in_progress`), then stored
// with its response (`done`), so concurrent retries can't both run the operation.
export const idempotencyKey = pgTable(
  "idempotency_key",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    operation: text("operation").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull(),
    response: jsonb("response"),
    createdAt: timestamp("created_at", { precision: 3 }).notNull(),
    expiresAt: timestamp("expires_at", { precision: 3 }).notNull(),
  },
  (t) => [
    unique("idempotency_key_org_key_key").on(t.organizationId, t.key),
    index("idempotency_key_expiresAt_idx").on(t.expiresAt),
  ],
)

// One row per signup attempt, successful or not. Counted per IP and per email domain to rate limit
// provisional signups. No organization: an attempt can be refused before anything is created.
export const signupAttempt = pgTable(
  "signup_attempt",
  {
    id: text("id").primaryKey(),
    ip: text("ip").notNull(),
    emailDomain: text("email_domain").notNull(),
    createdAt: timestamp("created_at", { precision: 3 }).notNull(),
  },
  (t) => [
    index("signup_attempt_ip_createdAt_idx").on(t.ip, t.createdAt),
    index("signup_attempt_domain_createdAt_idx").on(t.emailDomain, t.createdAt),
  ],
)

// Workspace agents: the workers an organization configures. Settings are what the agent-permissions
// board shows: the default autonomy, the three actions that always wait for a person, and the energy
// budget a run may spend. `pinned` puts it in the sidebar. Deleting one deletes its runs.
export const agent = pgTable(
  "agent",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** suggest_only | ask_first | autonomous */
    autonomy: text("autonomy").notNull().default("ask_first"),
    alwaysAskExternalPost: boolean("always_ask_external_post").notNull().default(true),
    alwaysAskMergeOrDeploy: boolean("always_ask_merge_or_deploy").notNull().default(true),
    alwaysAskOverEnergyBudget: boolean("always_ask_over_energy_budget").notNull().default(true),
    energyBudgetWh: doublePrecision("energy_budget_wh"),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { precision: 3 }).defaultNow().notNull(),
  },
  (t) => [index("agent_organizationId_idx").on(t.organizationId)],
)

// One execution of an agent. `status` is queued | running | needs_you | done | failed. The footprint
// is what the run reports about itself; duration is startedAt to finishedAt. No prices are stored.
export const run = pgTable(
  "run",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agent.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: text("status").notNull().default("queued"),
    summary: text("summary"),
    startedByType: text("started_by_type"),
    startedById: text("started_by_id"),
    startedAt: timestamp("started_at", { precision: 3 }),
    finishedAt: timestamp("finished_at", { precision: 3 }),
    /** Set by defer_run: the run waits until this time, shown as Queued. */
    deferredUntil: timestamp("deferred_until", { precision: 3 }),
    energyWh: doublePrecision("energy_wh").notNull().default(0),
    tokens: integer("tokens").notNull().default(0),
    toolCalls: integer("tool_calls").notNull().default(0),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    index("run_organizationId_createdAt_idx").on(t.organizationId, t.createdAt, t.id),
    index("run_agentId_idx").on(t.agentId),
  ],
)

// The ordered steps of a run, as the run view lists them. `progressDone`/`progressTotal` carry
// "38 of 61" when a step reports it.
export const runStep = pgTable(
  "run_step",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    detail: text("detail"),
    /** queued | running | needs_you | done | failed */
    status: text("status").notNull().default("queued"),
    progressDone: integer("progress_done"),
    progressTotal: integer("progress_total"),
    startedAt: timestamp("started_at", { precision: 3 }),
    finishedAt: timestamp("finished_at", { precision: 3 }),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    unique("run_step_run_position_key").on(t.runId, t.position),
    index("run_step_organizationId_idx").on(t.organizationId),
  ],
)

// An action a run wants to take that a person must allow first, e.g. "Post summary to #releases".
// `status` is pending | approved | denied. A decision is effective 30 seconds after it is made
// (`effectiveAt`); until then the agent sees the approval as pending, and undo_approval can reverse it.
export const approval = pgTable(
  "approval",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    stepId: text("step_id").references(() => runStep.id, { onDelete: "set null" }),
    /** The exact action it will take, in words. */
    action: text("action").notNull(),
    detail: text("detail"),
    status: text("status").notNull().default("pending"),
    requestedAt: timestamp("requested_at", { precision: 3 }).defaultNow().notNull(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { precision: 3 }),
    effectiveAt: timestamp("effective_at", { precision: 3 }),
    /** Set when a decision was undone (the approval is back to pending). */
    undoneAt: timestamp("undone_at", { precision: 3 }),
  },
  (t) => [
    index("approval_run_idx").on(t.runId),
    index("approval_organizationId_status_idx").on(t.organizationId, t.status),
  ],
)

// Messages a person sends to a run while it works (steer_run).
export const steerMessage = pgTable(
  "steer_message",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    authorId: text("author_id").notNull(),
    createdAt: timestamp("created_at", { precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    index("steer_message_organizationId_idx").on(t.organizationId),
    index("steer_message_run_created_idx").on(t.runId, t.createdAt),
  ],
)

// Feature flag rollouts. A flag is declared in code (packages/flags); this is its runtime state,
// managed by the operator organization (OPERATOR_ORGANIZATION_ID) and read for every organization
// when flags are evaluated. No row means the code default everywhere. `enabled` is the kill switch
// (off serves the default to all); percentage is whole percent of the organizations that are not
// targets; once reclaimed, `reclaimedValue` is served to all.
export const featureFlag = pgTable(
  "feature_flag",
  {
    key: text("key").primaryKey(),
    /** The operator organization that manages it. */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    percentage: integer("percentage").notNull().default(0),
    reclaimedValue: boolean("reclaimed_value"),
    reclaimedAt: timestamp("reclaimed_at", { precision: 3 }),
    createdAt: timestamp("created_at", { precision: 3 }).notNull(),
    updatedAt: timestamp("updated_at", { precision: 3 }).notNull(),
  },
  (t) => [index("feature_flag_organizationId_idx").on(t.organizationId)],
)

// The organizations a flag is turned on (allow-list) or off (deny-list) for, whatever its
// percentage. `organizationId` is the target, so deleting an organization drops it from every
// list, and evaluating flags for an organization reads only its own rows.
export const featureFlagTarget = pgTable(
  "feature_flag_target",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    flagKey: text("flag_key")
      .notNull()
      .references(() => featureFlag.key, { onDelete: "cascade" }),
    value: boolean("value").notNull(),
    createdAt: timestamp("created_at", { precision: 3 }).notNull(),
  },
  (t) => [
    unique("feature_flag_target_org_flag_key").on(t.organizationId, t.flagKey),
    index("feature_flag_target_flagKey_idx").on(t.flagKey),
  ],
)

// Evaluations per flag, value and UTC day, across all organizations: the evidence for stale
// signals (inactive, one value only), and `errors`, the API requests that evaluated the flag to
// this value and then failed with a 5xx (the evidence to compare before reclaiming). Counted in
// memory and added with an upsert; no foreign key, since a flag with no rollout is still evaluated.
export const featureFlagExposureDaily = pgTable(
  "feature_flag_exposure_daily",
  {
    flagKey: text("flag_key").notNull(),
    day: text("day").notNull(),
    value: boolean("value").notNull(),
    count: integer("count").notNull().default(0),
    errors: integer("errors").notNull().default(0),
  },
  (t) => [unique("feature_flag_exposure_daily_key").on(t.flagKey, t.day, t.value)],
)
