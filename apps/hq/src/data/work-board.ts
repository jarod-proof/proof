// The board and the item detail reads (I10's WorkBoard and WorkItemDetail, with Date values; the
// operations turn them into JSON). Everything here is read-only, driven by an injected `now`, and
// counted from rows: no number is estimated, and nothing is shown that hq has no source for.
//
// One source for every fact. What an item needs from a founder comes from `loadFacts` (its rule for
// a pending approval: the item is in review, the approval is bound to the CURRENT pull request and
// that pull request is open; its fix-only per-cycle budget; the shared "newest fix") and
// `deriveAttention` / `deriveCardState` (work/machine.ts). This file never re-counts those. Where the
// machine's card text would say more than the facts support, the board layer says less and gives
// the reason (`cardFor`): a requested attempt is not running, an item waiting in verify past its
// window is not "closing", and a done item claims only the verifiers it had.
//
// Text from signals, attempts, questions and founders is returned as strings, never interpreted. The
// only links are the pull request and signal urls, and each is checked (`pullRequestUrl`,
// `checkSignalUrl`).
//
// A read runs in one repeatable-read transaction, so a board is one snapshot. Cost: `readItem` is
// 11 to 13 sequential queries per in-flight item (`loadFacts` plus the pull request, the active
// attempt and the first signal, which `loadFacts` also reads), so a board is O(in-flight items).
// That is accepted for one small repo per org in this phase; the ceiling is the board's size, and
// the follow-up is to hand those reads over from `loadFacts` and batch them per board.
//
// The detail's lists are capped (`ATTEMPTS_SHOWN`, `QUESTIONS_SHOWN`, `EVENTS_SHOWN`,
// `NOTE_EVENTS_SHOWN`): the newest rows are returned, and `truncated` says when older ones exist.
import type { Database } from "@proof/db"
import { AppError } from "@proof/errors"
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm"

import {
  agentQuestions,
  attempts,
  contractItems,
  mergeApprovals,
  pullRequests,
  type QuestionStatus,
  signals,
  spend,
  verificationWindows,
  WINDOW_STATUSES,
  type WorkEventKind,
  workItemEvents,
  workItems,
} from "../db/schema"
import { ATTEMPT_DISPATCH_MODE, BOARD_COLUMN_CAP, DEPLOY_GRACE_MINUTES } from "../work/constants"
import {
  type Attention,
  type AttemptKind,
  ATTEMPT_RESULTS,
  type AttemptResult,
  type AttemptStatus,
  BOARD_COLUMNS,
  type BoardColumnKey,
  type CardState,
  columnFor,
  deriveAttention,
  deriveCardState,
  displayId,
  findTransition,
  isInFlight,
  type SignalSource,
  TRANSITION_REASONS,
  type TransitionReason,
  type VerifierKind,
  WORK_STAGES,
  type WorkActor,
  type WorkStage,
  type WorkState,
} from "../work/machine"
import type { PullRequestCheck, PullRequestState, ReviewerVerdict } from "../work/types"
import { CONNECTED_VERIFIER_KINDS } from "./contract"
import { parseUnits, unitsToUsd } from "./money"
import { BUCKET_MINUTES, MAX_BUCKETS, occurrenceBuckets } from "./verification"
import {
  currentPullRequest,
  loadFacts,
  newestFinishedFix,
  resolveItem,
  toWorkItemRow,
  type Tx,
  type WorkItemRow,
} from "./work-items"

// ---------------------------------------------------------------------------------------------
// Shapes (I10, with Date values).
// ---------------------------------------------------------------------------------------------

export interface PullRequestSummaryData {
  number: number
  url: string
  state: PullRequestState
  isDraft: boolean
}

export interface WorkItemSummaryData {
  id: string
  number: number
  displayId: string
  title: string
  repo: string
  source: SignalSource
  state: WorkState
  cycle: number
  card: CardState
  attention: Attention | null
  waitingSince: Date | null
  /** `used` counts the CURRENT cycle's fix attempts only; `running` is a live (not stale) attempt. */
  attempts: { used: number; limit: number | null; running: boolean }
  pullRequest: PullRequestSummaryData | null
  summary: string
  createdAt: Date
  stateChangedAt: Date
}

export interface NeedsYouData {
  kind: Attention
  itemId: string
  displayId: string
  title: string
  reason: string
  since: Date
  merge?: { pullRequestUrl: string; headSha: string; number: number; isDraft: boolean }
  question?: {
    questionId: string
    prompt: string
    options: { id: string; label: string; detail?: string }[]
    defaultOptionId: string | null
  }
}

export interface WorkBoardData {
  now: Date
  repos: string[]
  dispatch: "label" | "claim"
  columns: { key: BoardColumnKey; label: string; count: number; items: WorkItemSummaryData[] }[]
  stats: {
    inFlight: number
    runningAttempts: number
    needsYou: number
    oldestWaitingMinutes: number | null
    resolvedToday: number
    verifiedToday: number
    watching: number
    reopened: number
    latestReopened: { displayId: string; reason: string } | null
  }
  needsYou: NeedsYouData[]
}

export interface ContractItemViewData {
  id: string
  text: string
  verifier: { kind: VerifierKind; label: string }
  status: "pending" | "passing" | "failing"
  evidence: string | null
  checkedAt: Date | null
}

export interface AttemptViewData {
  id: string
  number: number
  cycle: number
  kind: AttemptKind
  status: AttemptStatus
  result: AttemptResult | null
  requestedBy: string | null
  instructions: string | null
  startedAt: Date | null
  finishedAt: Date | null
  durationMs: number | null
  files: string[]
  note: string | null
  branch: string | null
  reviewer: { verdict: ReviewerVerdict; summary: string; headSha?: string } | null
  runId: string | null
  sessionId: string | null
  externalRef: string | null
  leaseExpiresAt: Date | null
  costUsd: number | null
  costEstimated: boolean
  /** Why an abandoned attempt ended, read from its `attempt_abandoned` event; null when unknown. */
  endReason: "merged" | "stopped" | "lease_expired" | null
}

export interface QuestionViewData {
  id: string
  attemptId: string | null
  prompt: string
  options: { id: string; label: string; detail?: string }[]
  defaultOptionId: string | null
  status: QuestionStatus
  answeredOptionId: string | null
  answeredBy: string | null
  answeredAt: Date | null
  createdAt: Date
}

export interface PullRequestViewData {
  number: number
  url: string
  branch: string
  base: string
  headSha: string
  isDraft: boolean
  state: PullRequestState
  additions: number | null
  deletions: number | null
  files: number | null
  checks: PullRequestCheck[]
  mergedAt: Date | null
  mergedBy: string | null
}

export interface EventViewData {
  id: string
  at: Date
  kind: WorkEventKind
  fromState: WorkState | null
  toState: WorkState | null
  actorType: WorkActor
  actorId: string
  reason: string | null
  note: string | null
  detail: Record<string, unknown> | null
  cycle: number
  /** One line built from hq's own fields (never from a note). */
  summary: string
}

export interface WorkItemDetailData extends WorkItemSummaryData {
  signal: {
    id: string
    source: SignalSource
    externalId: string
    /** Text as stored; a link only when `urlChecked`. */
    url: string | null
    urlChecked: boolean
    summary: string
    occurrences: number
    firstSeenAt: Date
    lastSeenAt: Date
    evidence: string | null
  } | null
  stages: { stage: WorkStage; status: "done" | "now" | "todo" }[]
  contract: ContractItemViewData[]
  /** The list `WorkItemDetail.attempts` is in the plan; `attempts` here is the summary's count. */
  attemptList: AttemptViewData[]
  questions: QuestionViewData[]
  pullRequest: PullRequestViewData | null
  mergeApproval: {
    id: string
    status: "pending" | "approved" | "void"
    headSha: string
    requestedAt: Date
    decidedBy: string | null
    decidedAt: Date | null
    note: string | null
  } | null
  window: {
    status: "running" | "passed" | "failed" | "stopped"
    startsAt: Date
    endsAt: Date
    remainingMinutes: number | null
    mergedAt: Date
    pastEnd: boolean
    waitingOn: {
      contractItemId: string
      kind: VerifierKind
      state: "pending" | "not_connected" | "failing"
    }[]
    buckets: { at: Date; count: number }[]
  } | null
  founderNotes: { at: Date; kind: "retry" | "answer" | "revert" | "request"; text: string }[]
  events: EventViewData[]
  /** True where older rows exist than the capped list returned (the newest are kept). */
  truncated: { attempts: boolean; questions: boolean; events: boolean }
  actions: {
    canStop: boolean
    canReopen: boolean
    canRevert: boolean
    canRetry: boolean
    canRequestAttempt: boolean
  }
}

export interface ReadOptions {
  /** Defaults to hq's `ATTEMPT_DISPATCH_MODE`; a test passes `claim`. */
  dispatch?: "label" | "claim"
}

// ---------------------------------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------------------------------

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const EVIDENCE_MAX_CHARS = 4000
const EVENTS_SHOWN = 50
const ATTEMPTS_SHOWN = 50
const QUESTIONS_SHOWN = 50
const NOTE_EVENTS_SHOWN = 100
const ABANDONED_EVENTS_MAX = 100

const startOfUtcDay = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))

/** At most `max` UTF-16 units, cut between code points so an emoji is never split. */
function capText(text: string, max: number): string {
  if (text.length <= max) return text
  let out = ""
  for (const point of text) {
    if (out.length + point.length > max) break
    out += point
  }
  return out
}

const words = (code: string) => code.replace(/_/g, " ")
const shortSha = (sha: string) => sha.slice(0, 7)

/**
 * The pull request's url, rebuilt from the item's repo and the number unless the stored one is that
 * very url (case aside): a row can hold anything, and only a GitHub pull request page of the item's
 * own repository is ever returned.
 */
export function pullRequestUrl(repo: string, number: number, stored: string): string {
  const canonical = `https://github.com/${repo}/pull/${number}`
  return stored.toLowerCase() === canonical.toLowerCase() ? stored : canonical
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * A signal's url is checked, not trusted: it is a link only when it is `https://github.com/<repo>/`
 * followed by an issue, a pull request or a commit of the signal's own repository, with no query,
 * fragment or credentials. Anything else is still returned as text, flagged `urlChecked: false`.
 */
function checkSignalUrl(
  repo: string,
  url: string | null,
): { url: string | null; urlChecked: boolean } {
  if (url === null) return { url: null, urlChecked: false }
  const pattern = new RegExp(
    `^https://github\\.com/${escapeRegExp(repo)}/(?:issues/[1-9]\\d*|pull/[1-9]\\d*|commit/[0-9a-f]{7,40})$`,
    "i",
  )
  return { url, urlChecked: pattern.test(url) }
}

/** The signal payload's `text` (else `body`) field when it is text, capped, as plain text. */
function evidenceOf(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null
  for (const field of ["text", "body"]) {
    const value = payload[field]
    if (typeof value === "string" && value.length > 0) return capText(value, EVIDENCE_MAX_CHARS)
  }
  return null
}

const verifierLabel = (kind: VerifierKind): string => words(kind)

type VerifierState = "pending" | "not_connected" | "failing"
function waitingState(
  kind: VerifierKind,
  status: "pending" | "passing" | "failing",
): VerifierState | null {
  if (status === "passing") return null
  if (status === "failing") return "failing"
  return CONNECTED_VERIFIER_KINDS.includes(kind) ? "pending" : "not_connected"
}

/** The sentence a reopening reason gets, from hq's own code and never from a note. */
function reopenedReason(reason: string | null): string {
  switch (reason) {
    case "recurrence":
      return "The signal recurred after the fix."
    case "contract_failed":
      return "A contract check failed during the verification window."
    case "revert_requested":
      return "A founder asked for a revert."
    case "reopened":
      return "A founder reopened it."
    default:
      return "It was reopened."
  }
}

const used = (n: number, limit: number | null) =>
  `Used ${n} of ${limit ?? "?"} fix attempts this cycle`
function newestFixPhrase(result: AttemptResult | null): string {
  switch (result) {
    case "failed":
      return "failed"
    case "rejected":
      return "was rejected"
    case "abandoned":
      return "was abandoned"
    default:
      return "has no recorded result"
  }
}

/** A stored string reaches a sentence only as one of the values of its enum: else a fixed word. */
const known = <T extends string>(allowed: readonly T[], value: unknown): T | null =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null
const VOID_REASONS = ["head_sha_changed", "pull_request_closed", "merged", "stopped"] as const
const END_REASONS = ["merged", "stopped"] as const
const OTHER = "other"
const parenthetical = (allowed: readonly string[], value: unknown): string =>
  value === undefined || value === null ? "" : ` (${words(known(allowed, value) ?? OTHER)})`

function eventSummary(e: {
  kind: string
  fromState: WorkState | null
  toState: WorkState | null
  reason: string | null
  detail: Record<string, unknown> | null
}): string {
  const d = e.detail ?? {}
  const n =
    typeof d.number === "number" && Number.isInteger(d.number)
      ? `Attempt ${d.number}`
      : "An attempt"
  switch (e.kind) {
    case "transition":
      return `Moved from ${e.fromState ?? "no state"} to ${e.toState ?? "no state"}${parenthetical(TRANSITION_REASONS, e.reason)}.`
    case "signal_attached":
      return "A signal was attached."
    case "attempt_requested":
      return `${n} requested.`
    case "attempt_request_refused":
      // Fixed words only: the refusal's reason is the event's own note, shown as text beside it.
      return "No attempt was requested after the answer."
    case "attempt_started":
      return `${n} started.`
    case "attempt_finished":
      return `${n} finished${parenthetical(ATTEMPT_RESULTS, d.result)}.`
    case "attempt_abandoned":
      return `${n} abandoned (${d.reason === undefined ? "lease expired" : words(known(END_REASONS, d.reason) ?? OTHER)}).`
    case "pull_request":
      return "Pull request recorded."
    case "merge_approval_requested":
      return "Merge approval requested."
    case "merge_approved":
      return "Merge approved by a founder."
    case "merge_approval_void":
      return `Merge approval voided${parenthetical(VOID_REASONS, e.reason)}.`
    case "question_asked":
      return "The agent asked a question."
    case "question_answered":
      return "A founder answered a question."
    case "retry_granted":
      return "A founder granted one more attempt."
    case "revert_requested":
      return "A founder requested a revert."
    case "contract_set":
      return "The contract was recorded."
    case "window_started":
      return "The verification window opened."
    case "window_closed":
      return `The verification window closed${parenthetical(WINDOW_STATUSES, d.status)}.`
    default:
      return "Something was recorded."
  }
}

// ---------------------------------------------------------------------------------------------
// One item's card: facts, attention, card state, what it is waiting on.
// ---------------------------------------------------------------------------------------------

type ContractRow = typeof contractItems.$inferSelect
type AttemptRow = typeof attempts.$inferSelect
type QuestionRow = typeof agentQuestions.$inferSelect

/** One contract item as the operations and the detail show it. */
export const toContractItemView = (c: ContractRow): ContractItemViewData => ({
  id: c.id,
  text: c.text,
  verifier: { kind: c.verifierKind, label: verifierLabel(c.verifierKind) },
  status: c.status,
  evidence: c.evidence,
  checkedAt: c.checkedAt,
})

/** One question as the operations and the detail show it. */
export const toQuestionView = (q: QuestionRow): QuestionViewData => ({
  id: q.id,
  attemptId: q.attemptId,
  prompt: q.prompt,
  options: q.options,
  defaultOptionId: q.defaultOptionId,
  status: q.status,
  answeredOptionId: q.answeredOptionId,
  answeredBy: q.answeredBy,
  answeredAt: q.answeredAt,
  createdAt: q.createdAt,
})
type WindowRow = typeof verificationWindows.$inferSelect

async function contractRows(
  tx: Tx,
  item: Pick<WorkItemRow, "id" | "cycle">,
): Promise<ContractRow[]> {
  return tx
    .select()
    .from(contractItems)
    .where(and(eq(contractItems.itemId, item.id), eq(contractItems.cycle, item.cycle)))
    .orderBy(asc(contractItems.position))
}

async function currentWindow(
  tx: Tx,
  item: Pick<WorkItemRow, "id" | "cycle">,
): Promise<WindowRow | undefined> {
  const [row] = await tx
    .select()
    .from(verificationWindows)
    .where(and(eq(verificationWindows.itemId, item.id), eq(verificationWindows.cycle, item.cycle)))
  return row
}

interface ItemRead {
  item: WorkItemRow
  facts: Awaited<ReturnType<typeof loadFacts>>
  attention: Attention | null
  pr: Awaited<ReturnType<typeof currentPullRequest>>
  summary: WorkItemSummaryData
  needs: NeedsYouData | null
}

/** Everything the board and the detail share about one item, from one set of facts. */
async function readItem(tx: Tx, item: WorkItemRow, now: Date): Promise<ItemRead> {
  const facts = await loadFacts(tx, item, now)
  const attention = deriveAttention(facts)
  const pr = await currentPullRequest(tx, item)
  const [active] = await tx
    .select({
      number: attempts.number,
      kind: attempts.kind,
      status: attempts.status,
      leaseExpiresAt: attempts.leaseExpiresAt,
    })
    .from(attempts)
    .where(and(eq(attempts.itemId, item.id), inArray(attempts.status, ["requested", "running"])))
    .limit(1)
  const [first] = await tx
    .select({ summary: signals.summary })
    .from(signals)
    .where(eq(signals.itemId, item.id))
    .orderBy(asc(signals.occurredAt), asc(signals.receivedAt), asc(signals.id))
    .limit(1)
  const window = item.state === "verify" ? await currentWindow(tx, item) : undefined

  let card = deriveCardState({
    ...facts,
    attention,
    activeKind: active?.kind ?? null,
    windowEndsAt: window?.endsAt ?? null,
    now,
  })
  // A requested attempt has not been claimed: the machine's "running" would be a claim nobody made.
  if (card.label === "running" && active?.status === "requested") {
    card = { label: "queued", tone: "dim", detail: "attempt requested · waits to be claimed" }
  }
  if (attention === null) {
    card = await refineCard(tx, item, facts, pr, window, card, now)
  }

  let needs: NeedsYouData | null = null
  let since: Date | null = null
  if (attention !== null) {
    const base = { kind: attention, itemId: item.id, displayId: item.displayId, title: item.title }
    if (attention === "merge_approval" && pr) {
      const [pending] = await tx
        .select()
        .from(mergeApprovals)
        .where(and(eq(mergeApprovals.pullRequestId, pr.id), eq(mergeApprovals.status, "pending")))
        .orderBy(asc(mergeApprovals.requestedAt), asc(mergeApprovals.id))
        .limit(1)
      since = pending?.requestedAt ?? item.stateChangedAt
      needs = {
        ...base,
        reason: `Merge approval waits for a founder: pull request #${pr.number}${pr.isDraft ? " (draft)" : ""} at ${shortSha(pr.headSha)}.`,
        since,
        merge: {
          pullRequestUrl: pullRequestUrl(item.repo, pr.number, pr.url),
          headSha: pending?.headSha ?? pr.headSha,
          number: pr.number,
          isDraft: pr.isDraft,
        },
      }
    } else if (attention === "agent_question") {
      const open = await tx
        .select()
        .from(agentQuestions)
        .where(and(eq(agentQuestions.itemId, item.id), eq(agentQuestions.status, "open")))
        .orderBy(asc(agentQuestions.createdAt), asc(agentQuestions.id))
      const oldest = open[0]
      since = oldest?.createdAt ?? item.stateChangedAt
      needs = {
        ...base,
        reason: `The agent asked a question and waits for your answer${open.length > 1 ? ` (${open.length} open, the oldest is shown)` : ""}.`,
        since,
        ...(oldest
          ? {
              question: {
                questionId: oldest.id,
                prompt: oldest.prompt,
                options: oldest.options,
                defaultOptionId: oldest.defaultOptionId,
              },
            }
          : {}),
      }
    } else if (attention === "attempt_budget") {
      const rows = await tx
        .select({
          number: attempts.number,
          kind: attempts.kind,
          status: attempts.status,
          result: attempts.result,
          finishedAt: attempts.finishedAt,
        })
        .from(attempts)
        .where(and(eq(attempts.itemId, item.id), eq(attempts.cycle, item.cycle)))
      const newest = newestFinishedFix(rows)
      since = newest?.finishedAt ?? item.stateChangedAt
      needs = {
        ...base,
        reason: `${used(facts.attemptsUsed, item.attemptLimit)}; the newest ${newestFixPhrase(facts.newestFixResult)}.`,
        since,
      }
    } else if (attention === "stuck_attempt") {
      since = active?.leaseExpiresAt ?? item.stateChangedAt
      needs = {
        ...base,
        reason: `Attempt ${active?.number ?? "?"} has not reported since its lease ran out.`,
        since,
      }
    }
  }

  const summary: WorkItemSummaryData = {
    id: item.id,
    number: item.number,
    displayId: item.displayId,
    title: item.title,
    repo: item.repo,
    source: item.source,
    state: item.state,
    cycle: item.cycle,
    card,
    attention,
    waitingSince: needs ? needs.since : null,
    attempts: {
      used: facts.attemptsUsed,
      limit: item.attemptLimit,
      running: active?.status === "running" && facts.activeAttempt === "fresh",
    },
    pullRequest: pr
      ? {
          number: pr.number,
          url: pullRequestUrl(item.repo, pr.number, pr.url),
          state: pr.state,
          isDraft: pr.isDraft,
        }
      : null,
    summary: first?.summary ?? "",
    createdAt: item.createdAt,
    stateChangedAt: item.stateChangedAt,
  }
  return { item, facts, attention, pr, summary, needs }
}

/** Cases where the machine's card text claims more than hq knows; each says less and says why. */
async function refineCard(
  tx: Tx,
  item: WorkItemRow,
  facts: ItemRead["facts"],
  pr: ItemRead["pr"],
  window: WindowRow | undefined,
  card: CardState,
  now: Date,
): Promise<CardState> {
  if (item.state === "verify" && window && window.status === "running" && now >= window.endsAt) {
    const rows = await contractRows(tx, item)
    const waiting = rows.flatMap((r) => {
      const state = waitingState(r.verifierKind, r.status)
      return state ? [`${verifierLabel(r.verifierKind)} ${words(state)}`] : []
    })
    if (rows.length === 0) {
      return { label: "waiting", tone: "amber", detail: "window ended · no contract to verify" }
    }
    if (waiting.length > 0) {
      return { label: "waiting", tone: "amber", detail: `window ended · ${waiting.join(", ")}` }
    }
    return card
  }
  if (item.state === "done") {
    const rows = await contractRows(tx, item)
    if (rows.some((r) => r.verifierKind === "signal_recurrence" && r.status === "passing"))
      return card
    const kinds = rows
      .filter((r) => r.status === "passing")
      .map((r) => verifierLabel(r.verifierKind))
    return {
      ...card,
      detail:
        rows.length === 0
          ? "window passed · no contract recorded"
          : `window passed · ${kinds.join(", ") || "no passing contract item"}`,
    }
  }
  if (
    item.state === "review" &&
    facts.newestFixResult === "approved" &&
    facts.activeAttempt === "none"
  ) {
    if (!pr) {
      return { ...card, detail: "reviewer approved · waits for a pull request" }
    }
    if (pr.state === "open") {
      const [held] = await tx
        .select({ id: mergeApprovals.id })
        .from(mergeApprovals)
        .where(
          and(
            eq(mergeApprovals.pullRequestId, pr.id),
            eq(mergeApprovals.headSha, pr.headSha),
            inArray(mergeApprovals.status, ["pending", "approved"]),
          ),
        )
        .limit(1)
      if (!held) {
        return { ...card, detail: "reviewer approved · no merge approval is waiting for this head" }
      }
    }
  }
  return card
}

// ---------------------------------------------------------------------------------------------
// The board.
// ---------------------------------------------------------------------------------------------

const READ_ONLY = { isolationLevel: "repeatable read", accessMode: "read only" } as const

const byWaitingThenNewest = (a: WorkItemSummaryData, b: WorkItemSummaryData): number => {
  const aw = a.waitingSince?.getTime() ?? null
  const bw = b.waitingSince?.getTime() ?? null
  if (aw !== null && bw !== null && aw !== bw) return aw - bw
  if ((aw === null) !== (bw === null)) return aw === null ? 1 : -1
  return b.stateChangedAt.getTime() - a.stateChangedAt.getTime() || b.number - a.number
}

export async function workBoard(
  db: Database,
  now: Date,
  options: ReadOptions = {},
): Promise<WorkBoardData> {
  const dispatch = options.dispatch ?? ATTEMPT_DISPATCH_MODE
  return db.transaction(async (tx) => {
    const dayStart = startOfUtcDay(now)
    const dayEnd = new Date(dayStart.getTime() + 24 * HOUR_MS)
    // In-flight items, plus end states changed today (columnFor decides which count as today).
    const rows = await tx
      .select()
      .from(workItems)
      .where(
        sql`${workItems.state} in (${sql.join(
          WORK_STAGES.map((s) => sql`${s}`),
          sql`, `,
        )})
          or ${workItems.stateChangedAt} >= ${dayStart.toISOString()}::timestamptz`,
      )
      .orderBy(asc(workItems.number))
    const reads: ItemRead[] = []
    for (const row of rows) {
      const item = toWorkItemRow(row)
      if (isInFlight(item.state) || columnFor(item.state, item.stateChangedAt, now) !== null) {
        reads.push(await readItem(tx, item, now))
      }
    }

    const columns = BOARD_COLUMNS.map((c) => {
      const items = reads
        .filter((r) => columnFor(r.item.state, r.item.stateChangedAt, now) === c.key)
        .map((r) => r.summary)
        .sort(byWaitingThenNewest)
      return {
        key: c.key,
        label: c.label,
        count: items.length,
        items: items.slice(0, BOARD_COLUMN_CAP),
      }
    })

    const needsYou = reads
      .flatMap((r) => (r.needs ? [{ needs: r.needs, number: r.item.number }] : []))
      .sort((a, b) => a.needs.since.getTime() - b.needs.since.getTime() || a.number - b.number)
      .map((r) => r.needs)

    // Running attempts of items in flight, with a live lease: what the cards show. A stopped item's
    // attempt that is still running (a stop leaves it to its lease) is on no card and not counted.
    const [running] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(attempts)
      .innerJoin(workItems, eq(workItems.id, attempts.itemId))
      .where(
        and(
          eq(attempts.status, "running"),
          inArray(workItems.state, [...WORK_STAGES]),
          sql`(${attempts.leaseExpiresAt} is null or ${attempts.leaseExpiresAt} > ${now.toISOString()}::timestamptz)`,
        ),
      )

    // Resolved today: a merge recorded today for the item's CURRENT cycle, either observed (the
    // `pull_request_merged` transition, stamped today) or reported by GitHub (`merged_at` today on
    // the current pull request). One count per item.
    const resolved = new Set<string>()
    const mergeMoves = await tx
      .select({ itemId: workItemEvents.itemId })
      .from(workItemEvents)
      .innerJoin(
        workItems,
        and(eq(workItems.id, workItemEvents.itemId), eq(workItems.cycle, workItemEvents.cycle)),
      )
      .where(
        and(
          eq(workItemEvents.kind, "transition"),
          eq(workItemEvents.toState, "deploy"),
          eq(workItemEvents.reason, "pull_request_merged"),
          gte(workItemEvents.at, dayStart),
          lt(workItemEvents.at, dayEnd),
        ),
      )
    for (const m of mergeMoves) resolved.add(m.itemId)
    const mergedToday = await tx
      .select({ pr: pullRequests, item: workItems })
      .from(pullRequests)
      .innerJoin(workItems, eq(workItems.id, pullRequests.itemId))
      .where(and(gte(pullRequests.mergedAt, dayStart), lt(pullRequests.mergedAt, dayEnd)))
    for (const m of mergedToday) {
      if ((await currentPullRequest(tx, toWorkItemRow(m.item)))?.id === m.pr.id) {
        resolved.add(m.item.id)
      }
    }
    // Verified today: reached `done` today, and the window of that cycle passed. Counted from the
    // move and the window rows, never from "resolved".
    const verifiedMoves = await tx
      .selectDistinct({ itemId: workItemEvents.itemId })
      .from(workItemEvents)
      .innerJoin(
        verificationWindows,
        and(
          eq(verificationWindows.itemId, workItemEvents.itemId),
          eq(verificationWindows.cycle, workItemEvents.cycle),
          eq(verificationWindows.status, "passed"),
        ),
      )
      .where(
        and(
          eq(workItemEvents.kind, "transition"),
          eq(workItemEvents.toState, "done"),
          gte(workItemEvents.at, dayStart),
          lt(workItemEvents.at, dayEnd),
        ),
      )

    // Reopened today: the transitions into `reopened` stamped today, one count per item. The state
    // itself is no source: the sweep retriages an item within the half hour.
    const reopenedEvents = await tx
      .select({
        itemId: workItemEvents.itemId,
        reason: workItemEvents.reason,
        number: workItems.number,
      })
      .from(workItemEvents)
      .innerJoin(workItems, eq(workItems.id, workItemEvents.itemId))
      .where(
        and(
          eq(workItemEvents.kind, "transition"),
          eq(workItemEvents.toState, "reopened"),
          gte(workItemEvents.at, dayStart),
          lt(workItemEvents.at, dayEnd),
        ),
      )
      .orderBy(desc(workItemEvents.at), desc(workItemEvents.id))
    const latest = reopenedEvents[0]

    const waits = needsYou.map((n) => n.since.getTime())
    const [repoRows] = [
      await tx
        .selectDistinct({ repo: workItems.repo })
        .from(workItems)
        .orderBy(asc(workItems.repo)),
    ]

    return {
      now,
      repos: repoRows.map((r) => r.repo),
      dispatch,
      columns,
      stats: {
        inFlight: reads.filter((r) => isInFlight(r.item.state)).length,
        runningAttempts: running?.n ?? 0,
        needsYou: needsYou.length,
        oldestWaitingMinutes:
          waits.length === 0
            ? null
            : Math.max(0, Math.floor((now.getTime() - Math.min(...waits)) / MINUTE_MS)),
        resolvedToday: resolved.size,
        verifiedToday: verifiedMoves.length,
        watching: reads.filter((r) => r.item.state === "verify").length,
        reopened: new Set(reopenedEvents.map((e) => e.itemId)).size,
        latestReopened: latest
          ? { displayId: displayId(latest.number), reason: reopenedReason(latest.reason) }
          : null,
      },
      needsYou,
    }
  }, READ_ONLY)
}

// ---------------------------------------------------------------------------------------------
// The item detail.
// ---------------------------------------------------------------------------------------------

function stagesFor(state: WorkState, stoppedAt: WorkState | null): WorkItemDetailData["stages"] {
  const at = (s: WorkStage) => WORK_STAGES.indexOf(s)
  let nowIndex: number
  switch (state) {
    case "done":
      nowIndex = WORK_STAGES.length
      break
    case "reopened":
      nowIndex = at("triage")
      break
    case "stopped":
      nowIndex =
        stoppedAt && (WORK_STAGES as readonly string[]).includes(stoppedAt)
          ? at(stoppedAt as WorkStage)
          : -1
      break
    default:
      nowIndex = at(state)
  }
  return WORK_STAGES.map((stage, i) => ({
    stage,
    status: nowIndex === -1 ? "todo" : i < nowIndex ? "done" : i === nowIndex ? "now" : "todo",
  }))
}

/**
 * The views of attempt rows of one item: cost from the run's spend, why an abandoned one ended
 * (read from its event). One source for the item detail and for the operations that return an
 * attempt.
 */
async function attemptViews(
  tx: Tx,
  itemId: string,
  rows: AttemptRow[],
): Promise<AttemptViewData[]> {
  const runIds = [...new Set(rows.flatMap((a) => (a.runId ? [a.runId] : [])))]
  const costs = runIds.length
    ? await tx
        .select({
          runId: spend.runId,
          total: sql<string>`sum(${spend.amountUsd})::text`,
          estimated: sql<boolean>`bool_or(${spend.estimated})`,
        })
        .from(spend)
        .where(and(isNotNull(spend.runId), inArray(spend.runId, runIds)))
        .groupBy(spend.runId)
    : []
  const costOf = new Map(costs.map((c) => [c.runId, c]))
  const abandoned = rows.length
    ? await tx
        .select({ detail: workItemEvents.detail })
        .from(workItemEvents)
        .where(
          and(
            eq(workItemEvents.itemId, itemId),
            eq(workItemEvents.kind, "attempt_abandoned"),
            inArray(
              sql<string>`${workItemEvents.detail}->>'attemptId'`,
              rows.map((a) => a.id),
            ),
          ),
        )
        .orderBy(asc(workItemEvents.at), asc(workItemEvents.id))
        .limit(ABANDONED_EVENTS_MAX)
    : []
  const endReasons = new Map<string, AttemptViewData["endReason"]>()
  for (const e of abandoned) {
    const attemptId = e.detail?.attemptId
    if (typeof attemptId !== "string") continue
    const reason = e.detail?.reason
    endReasons.set(
      attemptId,
      reason === "merged" || reason === "stopped" ? reason : "lease_expired",
    )
  }
  return rows.map((a) => {
    const cost = a.runId ? costOf.get(a.runId) : undefined
    const endReason = a.result === "abandoned" ? (endReasons.get(a.id) ?? null) : null
    return {
      id: a.id,
      number: a.number,
      cycle: a.cycle,
      kind: a.kind,
      status: a.status,
      result: a.result,
      requestedBy: a.requestedBy,
      instructions: a.instructions,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
      durationMs: a.durationMs,
      files: a.files,
      // hq's own "merged" or "stopped" note on a request it ended is not the agent's: the event says why.
      note: endReason === "merged" || endReason === "stopped" ? null : a.note,
      branch: a.branch,
      reviewer: a.reviewerVerdict
        ? {
            verdict: a.reviewerVerdict,
            summary: a.reviewerSummary ?? "",
            ...(a.reviewedHeadSha ? { headSha: a.reviewedHeadSha } : {}),
          }
        : null,
      runId: a.runId,
      sessionId: a.sessionId,
      externalRef: a.externalRef,
      leaseExpiresAt: a.leaseExpiresAt,
      costUsd: cost ? unitsToUsd(parseUnits(cost.total)) : null,
      costEstimated: cost?.estimated ?? false,
      endReason,
    }
  })
}

const founderEdge = (from: WorkState, to: WorkState, reason: TransitionReason): boolean =>
  findTransition(from, to, "founder")?.reasons.includes(reason) ?? false

export async function itemDetail(
  db: Database,
  ref: string,
  now: Date,
  options: ReadOptions = {},
): Promise<WorkItemDetailData> {
  const dispatch = options.dispatch ?? ATTEMPT_DISPATCH_MODE
  const found = await resolveItem(db, ref)
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(workItems).where(eq(workItems.id, found.id))
    if (!row) throw new AppError("NOT_FOUND", "Work item not found")
    const item = toWorkItemRow(row)
    const read = await readItem(tx, item, now)
    const { facts, pr } = read

    // The signal: the first one is the item's cause; every attached signal is counted.
    const [first] = await tx
      .select()
      .from(signals)
      .where(eq(signals.itemId, item.id))
      .orderBy(asc(signals.occurredAt), asc(signals.receivedAt), asc(signals.id))
      .limit(1)
    const [span] = await tx
      .select({
        n: sql<number>`count(*)::int`,
        first: sql<Date>`min(${signals.occurredAt})`,
        last: sql<Date>`max(${signals.occurredAt})`,
      })
      .from(signals)
      .where(eq(signals.itemId, item.id))
    const signal: WorkItemDetailData["signal"] = first
      ? {
          id: first.id,
          source: first.source,
          externalId: first.externalId,
          ...checkSignalUrl(first.repo, first.url),
          summary: first.summary,
          occurrences: span?.n ?? 1,
          firstSeenAt: new Date(span?.first ?? first.occurredAt),
          lastSeenAt: new Date(span?.last ?? first.occurredAt),
          evidence: evidenceOf(first.payload),
        }
      : null

    // Where a stopped item stopped: the newest move into `stopped` of this cycle.
    let stoppedAt: WorkState | null = null
    if (item.state === "stopped") {
      const [stop] = await tx
        .select({ fromState: workItemEvents.fromState })
        .from(workItemEvents)
        .where(
          and(
            eq(workItemEvents.itemId, item.id),
            eq(workItemEvents.kind, "transition"),
            eq(workItemEvents.toState, "stopped"),
            eq(workItemEvents.cycle, item.cycle),
          ),
        )
        .orderBy(desc(workItemEvents.at), desc(workItemEvents.id))
        .limit(1)
      stoppedAt = stop?.fromState ?? null
    }

    const contractList = await contractRows(tx, item)
    const contract = contractList.map(toContractItemView)

    const newestAttempts = await tx
      .select()
      .from(attempts)
      .where(eq(attempts.itemId, item.id))
      .orderBy(desc(attempts.number))
      .limit(ATTEMPTS_SHOWN + 1)
    const attemptRows = newestAttempts.slice(0, ATTEMPTS_SHOWN).reverse()
    const attemptList = await attemptViews(tx, item.id, attemptRows)

    const newestQuestions = await tx
      .select()
      .from(agentQuestions)
      .where(eq(agentQuestions.itemId, item.id))
      .orderBy(desc(agentQuestions.createdAt), desc(agentQuestions.id))
      .limit(QUESTIONS_SHOWN + 1)
    const questionRows = newestQuestions.slice(0, QUESTIONS_SHOWN).reverse()
    const questions = questionRows.map(toQuestionView)

    const pullRequest: PullRequestViewData | null = pr
      ? {
          number: pr.number,
          url: pullRequestUrl(item.repo, pr.number, pr.url),
          branch: pr.branch,
          base: pr.base,
          headSha: pr.headSha,
          isDraft: pr.isDraft,
          state: pr.state,
          additions: pr.additions,
          deletions: pr.deletions,
          files: pr.files,
          checks: pr.checks,
          mergedAt: pr.mergedAt,
          mergedBy: pr.mergedBy,
        }
      : null

    const [approval] = pr
      ? await tx
          .select()
          .from(mergeApprovals)
          .where(eq(mergeApprovals.pullRequestId, pr.id))
          .orderBy(desc(mergeApprovals.requestedAt), desc(mergeApprovals.id))
          .limit(1)
      : []
    const mergeApproval: WorkItemDetailData["mergeApproval"] = approval
      ? {
          id: approval.id,
          status: approval.status,
          headSha: approval.headSha,
          requestedAt: approval.requestedAt,
          decidedBy: approval.decidedBy,
          decidedAt: approval.decidedAt,
          note: approval.note,
        }
      : null

    const windowRow = await currentWindow(tx, item)
    let window: WorkItemDetailData["window"] = null
    if (windowRow) {
      const running = windowRow.status === "running"
      // The merge instant is read from hq's own window row (it opened `DEPLOY_GRACE_MINUTES` after
      // the merge), never from a pull request row: a second pull request with an agent-asserted
      // `mergedAt` must not move it. The range runs from 12 hours before the merge to now, never
      // past the window's end, and never over what one read may hold.
      const mergedAt = new Date(windowRow.startsAt.getTime() - DEPLOY_GRACE_MINUTES * MINUTE_MS)
      const to = new Date(Math.min(now.getTime(), windowRow.endsAt.getTime()))
      const from = new Date(
        Math.max(
          mergedAt.getTime() - 12 * HOUR_MS,
          to.getTime() - (MAX_BUCKETS - 1) * BUCKET_MINUTES * MINUTE_MS,
        ),
      )
      window = {
        status: windowRow.status,
        startsAt: windowRow.startsAt,
        endsAt: windowRow.endsAt,
        remainingMinutes: running
          ? Math.max(0, Math.ceil((windowRow.endsAt.getTime() - now.getTime()) / MINUTE_MS))
          : null,
        mergedAt,
        pastEnd: running && now >= windowRow.endsAt,
        waitingOn: running
          ? contractList.flatMap((c) => {
              const state = waitingState(c.verifierKind, c.status)
              return state ? [{ contractItemId: c.id, kind: c.verifierKind, state }] : []
            })
          : [],
        buckets: item.dedupeKey
          ? await occurrenceBuckets(tx, {
              dedupeKey: item.dedupeKey,
              from,
              to,
            })
          : [],
      }
    }

    // Founder notes: a revert is read from its `revert_requested` event only (the transition that
    // goes with it carries the same note), and a request from the attempt row.
    const noteEvents = await tx
      .select()
      .from(workItemEvents)
      .where(
        and(
          eq(workItemEvents.itemId, item.id),
          inArray(workItemEvents.kind, ["retry_granted", "question_answered", "revert_requested"]),
          eq(workItemEvents.actorType, "founder"),
          isNotNull(workItemEvents.note),
        ),
      )
      .orderBy(desc(workItemEvents.at), desc(workItemEvents.id))
      .limit(NOTE_EVENTS_SHOWN)
    const noteKinds = {
      retry_granted: "retry",
      question_answered: "answer",
      revert_requested: "revert",
    } as const
    const founderNotes: WorkItemDetailData["founderNotes"] = [
      ...noteEvents.flatMap((e) => {
        const text = e.note?.trim()
        const kind = noteKinds[e.kind as keyof typeof noteKinds]
        return text && kind ? [{ at: e.at, kind, text }] : []
      }),
      ...attemptRows.flatMap((a) => {
        const text = a.instructions?.trim()
        return a.requestedBy !== null && text
          ? [{ at: a.createdAt, kind: "request" as const, text }]
          : []
      }),
    ].sort((a, b) => a.at.getTime() - b.at.getTime())

    const eventRows = await tx
      .select()
      .from(workItemEvents)
      .where(eq(workItemEvents.itemId, item.id))
      .orderBy(desc(workItemEvents.at), desc(workItemEvents.id))
      .limit(EVENTS_SHOWN + 1)
    const events: EventViewData[] = eventRows.slice(0, EVENTS_SHOWN).map((e) => ({
      id: e.id,
      at: e.at,
      kind: e.kind,
      fromState: e.fromState,
      toState: e.toState,
      actorType: e.actorType,
      actorId: e.actorId,
      reason: e.reason,
      // The founder's revert note is shown once, on the `revert_requested` event.
      note: e.kind === "transition" && e.reason === "revert_requested" ? null : e.note,
      detail: e.detail,
      cycle: e.cycle,
      summary: eventSummary(e),
    }))

    // The actions mirror what the founder functions would accept, edge by edge from the machine.
    const retryRule = deriveAttention({
      ...facts,
      pendingMergeApproval: false,
      openQuestion: false,
    })
    const requestable = ["triage", "plan", "attempt", "review"].includes(item.state)
    const actions: WorkItemDetailData["actions"] = {
      canStop: founderEdge(item.state, "stopped", "stopped"),
      canReopen: founderEdge(
        item.state,
        item.state === "stopped" ? "triage" : "reopened",
        "reopened",
      ),
      canRevert: pr?.state === "merged" && founderEdge(item.state, "reopened", "revert_requested"),
      canRetry: retryRule === "attempt_budget" && item.attemptLimit !== null,
      canRequestAttempt:
        dispatch === "claim" &&
        requestable &&
        facts.activeAttempt === "none" &&
        (item.state === "triage" || item.state === "plan" || facts.attemptsRemaining),
    }

    return {
      ...read.summary,
      signal,
      stages: stagesFor(item.state, stoppedAt),
      contract,
      attemptList,
      questions,
      pullRequest,
      mergeApproval,
      window,
      founderNotes,
      events,
      truncated: {
        attempts: newestAttempts.length > ATTEMPTS_SHOWN,
        questions: newestQuestions.length > QUESTIONS_SHOWN,
        events: eventRows.length > EVENTS_SHOWN,
      },
      actions,
    }
  }, READ_ONLY)
}

/** One attempt row as an `AttemptView`: cost from the run's spend, `endReason` from its event. */
export async function attemptViewOf(db: Database, row: AttemptRow): Promise<AttemptViewData> {
  const [view] = await db.transaction((tx) => attemptViews(tx, row.itemId, [row]), READ_ONLY)
  if (!view) throw new AppError("INTERNAL", "The attempt has no view")
  return view
}

/**
 * The summaries (card, attention, attempt counts, pull request) of these items, in their order,
 * from one snapshot: the same `readItem` the board uses, so a list and the board never disagree.
 */
export async function workItemSummaries(
  db: Database,
  items: readonly WorkItemRow[],
  now: Date,
): Promise<WorkItemSummaryData[]> {
  return db.transaction(async (tx) => {
    const out: WorkItemSummaryData[] = []
    for (const item of items) out.push((await readItem(tx, item, now)).summary)
    return out
  }, READ_ONLY)
}

export type { BoardColumnKey }
