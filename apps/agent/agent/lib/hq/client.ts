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
  }
}
