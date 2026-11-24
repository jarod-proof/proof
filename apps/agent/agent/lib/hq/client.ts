import { z } from "zod"

/**
 * The agent's client for hq, the org's brain (apps/hq): thin REST calls on the paths hq's operation
 * registry serves, authenticated with an hq API key.
 *
 * @remarks
 * The key's scope is read all, propose, runs and spend only: `hq_entry:read`, `hq_proposal:create`,
 * `hq_run:*`, `hq_spend:read`, `hq_spend:record` and `hq_spend:request` (asking for a grant). It
 * cannot decide a proposal, edit an entry or grant spend, and nothing here tries to: those are a
 * signed-in founder's, and a grant is redeemed only by a founder's click on a card that carries the
 * request id hq returned. The paths are held to
 * hq's operations by `tests/hq/client.test.ts`, which runs this client against hq itself.
 */

export type EntryKind = "fact" | "voice" | "decision" | "playbook" | "customer"
export type RunOutcome = "succeeded" | "failed" | "stopped"
export type Runner = "eve" | "sandbox" | "box"
export type SpendSource = "eve" | "build" | "box"

/** A failed hq call: the HTTP status and hq's error code (`CONFLICT`, `FORBIDDEN`, ...). */
export class HqError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = "HqError"
    this.status = status
    this.code = code
  }
}

const entrySummary = z.object({
  id: z.string(),
  kind: z.string(),
  slug: z.string(),
  version: z.number(),
  title: z.string(),
})

const searchReply = z.object({ hits: z.array(entrySummary.extend({ excerpt: z.string() })) })
const entryReply = entrySummary.omit({ version: true }).extend({
  version: z.number(),
  latestVersion: z.number(),
  body: z.object({ text: z.string() }).passthrough(),
})
const proposeReply = z.object({ proposalId: z.string(), status: z.literal("pending") })
const idReply = z.object({ id: z.string() })
const reserveReply = z.union([
  z.object({ holdId: z.string() }),
  z.object({ refused: z.literal(true), remainingUsd: z.number() }),
])
const settleReply = z.object({ amountUsd: z.number(), estimated: z.boolean() })
const recordSpendReply = z.object({ id: z.string(), amountUsd: z.number(), estimated: z.boolean() })
const grantRequestReply = z.object({
  requestId: z.string(),
  amountUsd: z.number(),
  expiresAt: z.string(),
})
const allowanceReply = z.object({
  day: z.string(),
  spentUsd: z.number(),
  reservedUsd: z.number(),
  capUsd: z.number(),
  grantedUsd: z.number(),
  remainingUsd: z.number(),
})

const proposalRow = z.object({
  id: z.string(),
  entryId: z.string().nullable(),
  kind: z.string(),
  slug: z.string(),
  baseVersion: z.number().nullable(),
  title: z.string(),
  body: z.object({ text: z.string() }).passthrough(),
  reason: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
  createdAt: z.string(),
})
const proposalsReply = z.object({
  proposals: z.array(proposalRow),
  nextCursor: z.string().nullable(),
})
const runRow = z.object({
  id: z.string(),
  task: z.string(),
  trigger: z.string(),
  runner: z.string(),
  startedAt: z.string(),
  outcome: z.string().nullable(),
  summary: z
    .object({ worked: z.array(z.string()), failed: z.array(z.string()), stop: z.array(z.string()) })
    .nullable(),
  costUsd: z.number(),
  costEstimated: z.boolean(),
})
const runsReply = z.object({ runs: z.array(runRow), nextCursor: z.string().nullable() })
const spendSummaryReply = z.object({
  day: z.string(),
  totalUsd: z.number(),
  estimatedUsd: z.number(),
  bySource: z.array(z.object({ source: z.string(), amountUsd: z.number() })),
})

// ---------------------------------------------------------------------------------------------
// The work pipeline (apps/hq/src/operations/work-*.ts). The agent's scope reaches these and no
// founder operation: nothing here answers a question, approves a merge, or names a state. Replies
// are parsed non-strictly (a field hq adds later is ignored), but a missing or mistyped one is a
// BAD_REPLY, so a drifted hq is loud.
// ---------------------------------------------------------------------------------------------

export type WorkState =
  | "signal"
  | "triage"
  | "plan"
  | "attempt"
  | "review"
  | "deploy"
  | "verify"
  | "done"
  | "reopened"
  | "stopped"
export type AttemptKind = "investigate" | "fix"
export type AttemptStatus = "requested" | "running" | "finished"
export type AttemptResult =
  | "investigated"
  | "approved"
  | "rejected"
  | "failed"
  | "needs_answer"
  | "abandoned"
export type SignalSourceName = "github_issue" | "ci_failure" | "manual" | "sentry" | "posthog"
export type VerifierKind = "reviewer" | "ci" | "signal_recurrence" | "sentry" | "posthog"

const workState = z.enum([
  "signal",
  "triage",
  "plan",
  "attempt",
  "review",
  "deploy",
  "verify",
  "done",
  "reopened",
  "stopped",
])
const attemptKind = z.enum(["investigate", "fix"])
const attemptStatus = z.enum(["requested", "running", "finished"])
const attemptResult = z.enum([
  "investigated",
  "approved",
  "rejected",
  "failed",
  "needs_answer",
  "abandoned",
])
const verifierKind = z.enum(["reviewer", "ci", "signal_recurrence", "sentry", "posthog"])
const checkState = z.enum(["passed", "failed", "pending"])

const recordSignalReply = z.object({
  signalId: z.string(),
  itemId: z.string(),
  displayId: z.string(),
  outcome: z.enum(["created", "attached", "reopened", "duplicate"]),
})
const attemptViewReply = z.object({
  id: z.string(),
  number: z.number(),
  cycle: z.number(),
  kind: attemptKind,
  status: attemptStatus,
  result: attemptResult.nullable(),
  requestedBy: z.string().nullable(),
  instructions: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  files: z.array(z.string()),
  note: z.string().nullable(),
  branch: z.string().nullable(),
  reviewer: z
    .object({
      verdict: z.enum(["approve", "request_changes", "reject"]),
      summary: z.string(),
      headSha: z.string().optional(),
    })
    .nullable(),
  runId: z.string().nullable(),
  sessionId: z.string().nullable(),
  externalRef: z.string().nullable(),
  leaseExpiresAt: z.string().nullable(),
  costUsd: z.number().nullable(),
  costEstimated: z.boolean(),
  endReason: z.enum(["merged", "stopped", "lease_expired"]).nullable(),
})
const pullRequestSummaryReply = z.object({
  number: z.number(),
  url: z.string(),
  state: z.enum(["open", "merged", "closed"]),
  isDraft: z.boolean(),
})
const workItemSummaryReply = z.object({
  id: z.string(),
  number: z.number(),
  displayId: z.string(),
  title: z.string(),
  repo: z.string(),
  source: z.string(),
  state: workState,
  cycle: z.number(),
  attention: z.string().nullable(),
  waitingSince: z.string().nullable(),
  attempts: z.object({
    used: z.number(),
    limit: z.number().nullable(),
    running: z.boolean(),
  }),
  pullRequest: pullRequestSummaryReply.nullable(),
  summary: z.string(),
  createdAt: z.string(),
  stateChangedAt: z.string(),
})
const questionViewReply = z.object({
  id: z.string(),
  attemptId: z.string().nullable(),
  prompt: z.string(),
  options: z.array(z.object({ id: z.string(), label: z.string(), detail: z.string().optional() })),
  defaultOptionId: z.string().nullable(),
  status: z.enum(["open", "answered", "withdrawn"]),
  answeredOptionId: z.string().nullable(),
  answeredBy: z.string().nullable(),
  answeredAt: z.string().nullable(),
  createdAt: z.string(),
})
const contractItemReply = z.object({
  id: z.string(),
  text: z.string(),
  verifier: z.object({ kind: verifierKind, label: z.string() }),
  status: z.enum(["pending", "passing", "failing"]),
  evidence: z.string().nullable(),
  checkedAt: z.string().nullable(),
})
const pullRequestViewReply = z.object({
  number: z.number(),
  url: z.string(),
  branch: z.string(),
  base: z.string(),
  headSha: z.string(),
  isDraft: z.boolean(),
  state: z.enum(["open", "merged", "closed"]),
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
  files: z.number().nullable(),
  checks: z.array(z.object({ name: z.string(), state: checkState })),
  mergedAt: z.string().nullable(),
  mergedBy: z.string().nullable(),
})
const workItemDetailReply = workItemSummaryReply.extend({
  signal: z
    .object({
      id: z.string(),
      source: z.string(),
      externalId: z.string(),
      url: z.string().nullable(),
      summary: z.string(),
      occurrences: z.number(),
      firstSeenAt: z.string(),
      lastSeenAt: z.string(),
      evidence: z.string().nullable(),
    })
    .nullable(),
  contract: z.array(contractItemReply),
  attemptList: z.array(attemptViewReply),
  questions: z.array(questionViewReply),
  pullRequest: pullRequestViewReply.nullable(),
  mergeApproval: z
    .object({
      id: z.string(),
      status: z.enum(["pending", "approved", "void"]),
      headSha: z.string(),
      decidedBy: z.string().nullable(),
      decidedAt: z.string().nullable(),
      note: z.string().nullable(),
    })
    .nullable(),
})
const listWorkItemsReply = z.object({
  items: z.array(workItemSummaryReply),
  nextCursor: z.string().nullable(),
})
const attemptRequestReply = z.object({
  attemptId: z.string(),
  itemId: z.string(),
  displayId: z.string(),
  kind: attemptKind,
  status: attemptStatus,
  title: z.string(),
  repo: z.string(),
  instructions: z.string().nullable(),
  externalRef: z.string().nullable(),
})
const listAttemptsReply = z.object({ attempts: z.array(attemptRequestReply) })
const heartbeatReply = z.object({ leaseExpiresAt: z.string() })
const recordPullRequestReply = z.object({
  matched: z.boolean(),
  itemId: z.string().nullable(),
  state: workState.nullable(),
})
const setContractReply = z.object({ contract: z.array(contractItemReply) })
const sweepReply = z.object({
  advanced: z.array(z.string()),
  passed: z.array(z.string()),
  reopened: z.array(z.string()),
  retriaged: z.array(z.string()),
  abandoned: z.array(z.string()),
  errors: z.array(
    z.object({ itemId: z.string().nullable(), rule: z.string(), message: z.string() }),
  ),
})

export type RecordSignalResult = z.infer<typeof recordSignalReply>
export type AttemptView = z.infer<typeof attemptViewReply>
export type WorkItemSummary = z.infer<typeof workItemSummaryReply>
export type WorkItemDetail = z.infer<typeof workItemDetailReply>
export type QuestionView = z.infer<typeof questionViewReply>
export type ContractItemView = z.infer<typeof contractItemReply>
export type AttemptRequest = z.infer<typeof attemptRequestReply>
export type SweepResult = z.infer<typeof sweepReply>

/** What `record_signal` takes (a signal never starts work; `manual` is a founder's alone). */
export interface RecordSignalInput {
  source: SignalSourceName
  externalId: string
  dedupeKey: string
  repo: string
  title: string
  summary: string
  url?: string
  occurredAt?: string
  payload?: Record<string, unknown>
}

export interface PullRequestCheck {
  name: string
  state: "passed" | "failed" | "pending"
}

/** What `record_pull_request` takes: the full set on every event, or `checks` alone later. */
export interface RecordPullRequestInput {
  itemId?: string
  branch: string
  number: number
  url: string
  base?: string
  headSha?: string
  isDraft?: boolean
  state?: "open" | "merged" | "closed"
  additions?: number
  deletions?: number
  files?: number
  checks?: PullRequestCheck[]
  mergedBy?: string
  mergedAt?: string
}

export interface ContractInput {
  text: string
  verifier: { kind: VerifierKind; config?: Record<string, unknown> }
}

export interface AskQuestionInput {
  itemId: string
  prompt: string
  options: { id: string; label: string; detail?: string }[]
  defaultOptionId?: string
  attemptId?: string
}

export interface FinishAttemptInput {
  attemptId: string
  result: Exclude<AttemptResult, "abandoned">
  note?: string
  files?: string[]
  branch?: string
  sessionId?: string
  reviewer?: {
    verdict: "approve" | "request_changes" | "reject"
    summary: string
    headSha?: string
  }
}

export type EntryHit = z.infer<typeof searchReply>["hits"][number]
export type ProposalRow = z.infer<typeof proposalRow>
export type RunRow = z.infer<typeof runRow>
export type SpendSummary = z.infer<typeof spendSummaryReply>
export type Entry = z.infer<typeof entryReply>
export type Reservation = z.infer<typeof reserveReply>
export type Allowance = z.infer<typeof allowanceReply>
export type GrantRequest = z.infer<typeof grantRequestReply>

export interface RunSummary {
  worked: string[]
  failed: string[]
  stop: string[]
}

export interface ProposeEntryInput {
  kind: EntryKind
  slug: string
  title: string
  body: { text: string }
  reason: string
  baseVersion?: number
  runId?: string
}

export interface HqClient {
  searchEntries(input: { query: string; kinds?: EntryKind[]; limit?: number }): Promise<EntryHit[]>
  getEntry(input: { id: string; version?: number }): Promise<Entry>
  /** The only way the agent changes the brain: a pending proposal a founder decides. */
  proposeEntry(input: ProposeEntryInput): Promise<{ proposalId: string; status: "pending" }>
  recordRun(input: {
    task: string
    trigger: string
    runner: Runner
    link?: string
  }): Promise<{ id: string }>
  finishRun(input: { id: string; outcome: RunOutcome; summary: RunSummary }): Promise<void>
  reserveSpend(input: { estimateUsd: number; runId?: string }): Promise<Reservation>
  /** Closes a hold. `amountUsd` left out, hq settles at the hold's estimate, marked estimated. */
  settleSpend(input: {
    holdId: string
    amountUsd?: number
    model: string
  }): Promise<{ amountUsd: number; estimated: boolean }>
  recordSpend(input: {
    runId?: string
    source: SpendSource
    amountUsd?: number
    estimatedUsd?: number
    model: string
  }): Promise<{ id: string; amountUsd: number; estimated: boolean }>
  getSpendAllowance(): Promise<Allowance>
  /**
   * Ask for a spend grant of up to $25: hq records a pending request and returns its id, to put on
   * the Slack grant card. It grants nothing; a founder's click on the card redeems it, once, for
   * the amount hq recorded, within 24 hours. hq takes ten requests a UTC day (RATE_LIMITED after).
   */
  requestSpendGrant(input: {
    amountUsd: number
    reason: string
    runId?: string
  }): Promise<GrantRequest>
  /** One page of proposals, newest first (the nightly digest reads the pending ones). */
  listProposals(input?: {
    status?: "pending" | "approved" | "rejected"
    cursor?: string
    limit?: number
  }): Promise<{ proposals: ProposalRow[]; nextCursor: string | null }>
  /** One page of runs, newest first, with their cost. */
  listRuns(input?: {
    cursor?: string
    limit?: number
  }): Promise<{ runs: RunRow[]; nextCursor: string | null }>
  /** What one UTC day spent, by source. `day` left out is yesterday as hq counts it. */
  getSpendSummary(input?: { day?: string }): Promise<SpendSummary>
  /**
   * The work pipeline. The agent records facts (a signal, an attempt, a pull request, a contract,
   * a question) and reads items; it never decides: answering a question, approving a merge,
   * stopping or reopening an item are a signed-in founder's, and have no method here.
   */
  recordSignal(input: RecordSignalInput): Promise<RecordSignalResult>
  startAttempt(input: {
    itemId: string
    kind: AttemptKind
    runId?: string
    attemptLimit?: number
    externalRef?: string
  }): Promise<AttemptView>
  claimAttempt(input: {
    attemptId: string
    runId?: string
    externalRef?: string
  }): Promise<AttemptView>
  listWorkItems(input: {
    state?: WorkState
    query?: string
    dedupeKey?: string
    pullRequestNumber?: number
    repo?: string
    limit?: number
  }): Promise<{ items: WorkItemSummary[]; nextCursor: string | null }>
  listAttempts(input: {
    status?: AttemptStatus
    itemId?: string
    externalRef?: string
  }): Promise<AttemptRequest[]>
  heartbeatAttempt(input: {
    attemptId: string
    branch?: string
    files?: string[]
    note?: string
  }): Promise<{ leaseExpiresAt: string }>
  finishAttempt(input: FinishAttemptInput): Promise<AttemptView>
  recordPullRequest(
    input: RecordPullRequestInput,
  ): Promise<{ matched: boolean; itemId: string | null; state: WorkState | null }>
  setContract(input: { itemId: string; items: ContractInput[] }): Promise<void>
  askQuestion(input: AskQuestionInput): Promise<QuestionView>
  getWorkItem(input: { itemId: string }): Promise<WorkItemDetail>
  runVerificationSweep(): Promise<SweepResult>
}

export interface HqClientOptions {
  baseUrl: string
  apiKey: string
  /** Injected in tests (an in-process hq); defaults to the global fetch. */
  fetch?: typeof fetch
  /** Per call, default 10 seconds: a turn must not hang on hq. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000

export function createHqClient(options: HqClientOptions): HqClient {
  const base = options.baseUrl.replace(/\/+$/, "")
  const send = options.fetch ?? fetch

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    let response: Response
    try {
      response = await send(`${base}${path}`, {
        method,
        headers: {
          "x-api-key": options.apiKey,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
    } catch (error) {
      // The key is in the request, never in the message.
      throw new HqError(
        `hq is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        0,
        "UNREACHABLE",
      )
    }
    const text = await response.text()
    let json: unknown
    try {
      json = text === "" ? {} : JSON.parse(text)
    } catch {
      throw new HqError(
        `hq answered ${response.status} with a body that is not JSON`,
        response.status,
        "BAD_REPLY",
      )
    }
    if (!response.ok) {
      const error = (json as { error?: { code?: unknown; message?: unknown } }).error
      throw new HqError(
        typeof error?.message === "string" ? error.message : `hq answered ${response.status}`,
        response.status,
        typeof error?.code === "string" ? error.code : "ERROR",
      )
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      throw new HqError(
        `hq answered ${response.status} with an unexpected shape`,
        response.status,
        "BAD_REPLY",
      )
    }
    return parsed.data
  }

  const enc = encodeURIComponent
  /** A query string from the defined values only: `?a=1&b=2`, or nothing. */
  const query = (params: Record<string, string | number | undefined>) => {
    const parts = Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => `${name}=${enc(String(value))}`)
    return parts.length === 0 ? "" : `?${parts.join("&")}`
  }

  return {
    searchEntries: async ({ query, kinds, limit }) =>
      (await call("POST", "/v1/search/entries", searchReply, { query, kinds, limit })).hits,
    getEntry: ({ id, version }) =>
      call(
        "GET",
        `/v1/entries/${enc(id)}${version === undefined ? "" : `?version=${version}`}`,
        entryReply,
      ),
    proposeEntry: (input) => call("POST", "/v1/proposals", proposeReply, input),
    recordRun: (input) => call("POST", "/v1/runs", idReply, input),
    finishRun: async ({ id, outcome, summary }) => {
      await call("POST", `/v1/runs/${enc(id)}/finish`, z.unknown(), { outcome, summary })
    },
    reserveSpend: ({ estimateUsd, runId }) =>
      call("POST", "/v1/spend/reservations", reserveReply, { source: "eve", estimateUsd, runId }),
    settleSpend: ({ holdId, amountUsd, model }) =>
      call("POST", `/v1/spend/holds/${enc(holdId)}/settlement`, settleReply, { amountUsd, model }),
    recordSpend: (input) => call("POST", "/v1/spend", recordSpendReply, input),
    getSpendAllowance: () => call("GET", "/v1/spend/allowance", allowanceReply),
    requestSpendGrant: (input) =>
      call("POST", "/v1/spend/grant-requests", grantRequestReply, input),
    listProposals: ({ status, cursor, limit } = {}) =>
      call("GET", `/v1/proposals${query({ status, cursor, limit })}`, proposalsReply),
    listRuns: ({ cursor, limit } = {}) =>
      call("GET", `/v1/runs${query({ cursor, limit })}`, runsReply),
    getSpendSummary: ({ day } = {}) =>
      call("GET", `/v1/spend/summary${query({ day })}`, spendSummaryReply),
    recordSignal: (input) => call("POST", "/v1/signals", recordSignalReply, input),
    startAttempt: ({ itemId, ...body }) =>
      call("POST", `/v1/work-items/${enc(itemId)}/attempts`, attemptViewReply, body),
    claimAttempt: ({ attemptId, ...body }) =>
      call("POST", `/v1/attempts/${enc(attemptId)}/claim`, attemptViewReply, body),
    listWorkItems: (input) =>
      call(
        "GET",
        `/v1/work-items${query({
          state: input.state,
          query: input.query,
          dedupeKey: input.dedupeKey,
          pullRequestNumber: input.pullRequestNumber,
          repo: input.repo,
          limit: input.limit,
        })}`,
        listWorkItemsReply,
      ),
    listAttempts: async (input) =>
      (
        await call(
          "GET",
          `/v1/attempts${query({
            status: input.status,
            itemId: input.itemId,
            externalRef: input.externalRef,
          })}`,
          listAttemptsReply,
        )
      ).attempts,
    heartbeatAttempt: ({ attemptId, ...body }) =>
      call("POST", `/v1/attempts/${enc(attemptId)}/heartbeat`, heartbeatReply, body),
    finishAttempt: ({ attemptId, ...body }) =>
      call("POST", `/v1/attempts/${enc(attemptId)}/finish`, attemptViewReply, body),
    recordPullRequest: (input) => call("POST", "/v1/pull-requests", recordPullRequestReply, input),
    setContract: async ({ itemId, items }) => {
      await call("POST", `/v1/work-items/${enc(itemId)}/contract`, setContractReply, { items })
    },
    askQuestion: ({ itemId, ...body }) =>
      call("POST", `/v1/work-items/${enc(itemId)}/questions`, questionViewReply, body),
    getWorkItem: ({ itemId }) => call("GET", `/v1/work-items/${enc(itemId)}`, workItemDetailReply),
    runVerificationSweep: () => call("POST", "/v1/work/verification-sweep", sweepReply, {}),
  }
}
