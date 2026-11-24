import type { SessionAuthContext } from "eve/context"
import {
  type AttemptKind,
  type AttemptView,
  type ContractInput,
  type HqClient,
  HqError,
  type WorkItemDetail,
} from "../hq/client.js"
import {
  INTAKE_TICKET_ATTRIBUTE,
  intakeIssueNumber,
  isAutonomous,
  isSummaryOnly,
  isTicketRun,
  workItemIssue,
} from "../trust.js"
import { storable } from "./storable.js"

/**
 * The pure half of the attempt recording (`attempts.ts` re-exports every name here): the types, the
 * caps, the functions a workflow body may call and the adopt-or-start decision.
 *
 * @remarks
 * Nothing here may import the recorder, the logger or the environment: a workflow body imports
 * `attempts.ts`, eve bundles the body's imports, and the workflow bundle refuses Node built-ins
 * (pino reaches `node:os`). Keep it that way; `tests/work/steps.test.ts` scans for it, and the
 * agent's `pnpm build` is the proof.
 */

export type Station = "analyst" | "implementer" | "reviewer"

export type AttemptSubject =
  | { kind: "issue"; issueNumber: number }
  | { kind: "ci_fix"; pullNumber: number }
  | { kind: "ticket"; ticketId: string }

export interface StationCall {
  station: Station
  sessionId: string
  callId: string
  subject: AttemptSubject | null
  /** Sent on the first fix attempt of an item (the implementer); hq stores the first one. */
  attemptLimit?: number
}

export interface StationRecord {
  itemId: string
  attemptId: string | null
  kind: AttemptKind
  key: string
}

/** What `ask_founder` sends its step: the session it runs in and the question, as the model wrote it. */
export interface AskCall {
  sessionId: string
  subject: AttemptSubject | null
  prompt: string
  options: { id: string; label: string; detail?: string }[]
  defaultOptionId?: string
}

/** Whether the question is with the founders, and whether it ended the attempt that was asking. */
export type AskResult =
  | { recorded: true; questionId: string; attemptEnded: boolean }
  | { recorded: false }

/** The few serialisable fields a step needs of a station's output, already cut and scrubbed. */
export type StationSummary =
  | { station: "analyst"; acceptanceCriteria: string[] }
  | {
      station: "implementer"
      pushed: boolean
      branch: string | null
      files: string[]
      limitation: string | null
    }
  | {
      station: "reviewer"
      verdict: "approve" | "request_changes" | "reject"
      findings: string
      summary: string
      headSha?: string
    }

/** What an attempt may not exceed in hq (`apps/hq/src/work/constants.ts`); hq refuses the whole write. */
export const ATTEMPT_CAPS = {
  /** A note and a reviewer summary. */
  note: 2000,
  /** Files per heartbeat, and the length of each path. */
  files: 200,
  file: 500,
  branch: 200,
  /** A contract: items including the extras, and the length of an item's text. */
  contractItems: 8,
  contractText: 300,
  /** The station's error message inside a `failed` note. */
  failure: 500,
} as const

/** What hq takes of a question (`apps/hq/src/data/questions.ts`): it refuses the whole write over a cap. */
export const ASK_CAPS = {
  prompt: 2000,
  options: 5,
  optionId: 100,
  optionLabel: 200,
  optionDetail: 500,
} as const

/** The error the orchestrator sees when an item has used its fix attempts. Never retried. */
export const ATTEMPT_LIMIT_MESSAGE = "The attempt limit for this item is reached; stop and say so"

const RECURRENCE_TEXT = "No new signal like this in the verification window"
const CI_TEXT = "All checks on the pull request pass"
const COMMIT_ID = /^[0-9a-f]{7,64}$/i

// ---------------------------------------------------------------------------------------------
// Pure: safe in a workflow body.
// ---------------------------------------------------------------------------------------------

/**
 * What a session is working on, from the auth the channel stamped at dispatch (never from model
 * input), or null when the station should record nothing.
 *
 * @remarks
 * The three are told apart by the stamps: an issue intake carries the work-item stamp
 * (`workItemIssue`, which also refuses a summary-only run); a ticket run carries the ticket id;
 * a CI-fix run is autonomous with a thread number and neither stamp (`stampAutonomous` in
 * `onCheckSuite`), and the number is the pull request's, not an issue's. A summary-only run reads
 * strangers' pull request text and a mention is a person talking: both record nothing.
 */
export function subjectOf(auth: SessionAuthContext | null): AttemptSubject | null {
  const issueNumber = workItemIssue(auth)
  if (issueNumber !== null) {
    return { kind: "issue", issueNumber }
  }
  if (isTicketRun(auth)) {
    const ticketId = auth?.attributes[INTAKE_TICKET_ATTRIBUTE]
    return typeof ticketId === "string" ? { kind: "ticket", ticketId } : null
  }
  if (isAutonomous(auth) && !isSummaryOnly(auth)) {
    const pullNumber = intakeIssueNumber(auth)
    if (pullNumber !== null) {
      return { kind: "ci_fix", pullNumber }
    }
  }
  return null
}

/** The attempt's `externalRef`: `<sessionId>:<callId>:<station>`. */
export function stationKey(call: { sessionId: string; callId: string; station: Station }): string {
  return `${call.sessionId}:${call.callId}:${call.station}`
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const texts = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []

/**
 * The few fields of a station's output the steps need, cut to what hq takes and scrubbed of what it
 * refuses. Never throws: a malformed output becomes the most conservative summary.
 *
 * @param options.headSha - The head sha the reviewer read, when the wrapper knows it. Used only when
 * it is a commit id, so a bad sha can never lose a verdict.
 */
export function summarizeStation(
  station: Station,
  output: unknown,
  options: { headSha?: string } = {},
): StationSummary {
  const out = record(output)
  if (station === "analyst") {
    return {
      station,
      acceptanceCriteria: texts(out.acceptance_criteria)
        .map((text) => storable(text.trim(), ATTEMPT_CAPS.contractText))
        .filter((text) => text.trim() !== "")
        .slice(0, ATTEMPT_CAPS.contractItems),
    }
  }
  if (station === "implementer") {
    const branch = typeof out.branch === "string" ? storable(out.branch, ATTEMPT_CAPS.branch) : ""
    const files = (Array.isArray(out.change_summary) ? out.change_summary : [])
      .map((entry) => record(entry).path)
      .filter((path): path is string => typeof path === "string")
      .map((path) => storable(path, ATTEMPT_CAPS.file))
      .filter((path) => path.trim() !== "")
      .slice(0, ATTEMPT_CAPS.files)
    const limitation = texts(out.known_limitations).find((text) => text.trim() !== "")
    return {
      station,
      pushed: out.pushed === true,
      branch: branch.trim() === "" ? null : branch,
      files,
      limitation: limitation === undefined ? null : storable(limitation, ATTEMPT_CAPS.note),
    }
  }
  const verdict =
    out.verdict === "approve" || out.verdict === "reject" || out.verdict === "request_changes"
      ? out.verdict
      : "request_changes"
  const findings = storable(
    texts(out.blocking_findings)
      .filter((text) => text.trim() !== "")
      .join("\n"),
    ATTEMPT_CAPS.note,
  )
  const summary = typeof out.summary === "string" ? storable(out.summary, ATTEMPT_CAPS.note) : ""
  const headSha =
    typeof options.headSha === "string" && COMMIT_ID.test(options.headSha)
      ? options.headSha.toLowerCase()
      : undefined
  return {
    station,
    verdict,
    findings,
    summary: summary.trim() === "" ? findings : summary,
    ...(headSha === undefined ? {} : { headSha }),
  }
}

/**
 * Splits the reviewer's `head_sha` from the rest of its output: the reviewer reports the commit it
 * read (`git rev-parse HEAD` of the branch it fetched) in a schema field the orchestrator never
 * had, so the wrapper takes it out before returning the output and gives it to
 * {@link summarizeStation}, which uses it only when it is a commit id.
 *
 * @returns The output without `head_sha` (the very same object when it had none) and the sha the
 * reviewer gave, when it gave a string.
 */
export function takeHeadSha(output: unknown): { output: unknown; headSha: string | undefined } {
  const out = record(output)
  if (!("head_sha" in out)) {
    return { output, headSha: undefined }
  }
  const { head_sha: given, ...rest } = out
  return { output: rest, headSha: typeof given === "string" ? given : undefined }
}

/**
 * The contract the analyst's acceptance criteria become: each criterion for the reviewer to check,
 * then one item that no new signal like this comes back, and one that the pull request's checks
 * pass when the item has such checks. Capped at what hq takes; the extras are kept when the
 * criteria are many.
 */
export function contractFor(criteria: string[], hasPullRequestCheck: boolean): ContractInput[] {
  const extras: ContractInput[] = [
    { text: RECURRENCE_TEXT, verifier: { kind: "signal_recurrence" } },
    ...(hasPullRequestCheck ? [{ text: CI_TEXT, verifier: { kind: "ci" as const } }] : []),
  ]
  const own = criteria
    .map((text) => storable(text.trim(), ATTEMPT_CAPS.contractText))
    .filter((text) => text.trim() !== "")
    .slice(0, ATTEMPT_CAPS.contractItems - extras.length)
    .map((text): ContractInput => ({ text, verifier: { kind: "reviewer" } }))
  return [...own, ...extras]
}

export const kindOf = (station: Station): AttemptKind =>
  station === "analyst" ? "investigate" : "fix"

export function stationOf(key: string): Station | null {
  const name = key.slice(key.lastIndexOf(":") + 1)
  return name === "analyst" || name === "implementer" || name === "reviewer" ? name : null
}

/** The recorder's own classification: only a 4xx is hq answering; the rest is hq being unavailable. */
export const isUnavailable = (error: unknown): boolean =>
  !(error instanceof HqError) || !(error.status >= 400 && error.status < 500)

type Tried<T> = { ok: true; value: T } | { ok: false; unavailable: boolean }

/** One call and, when hq was unavailable (a timeout, no connection), one more with the same input. */
async function withInlineRetry<T>(run: () => Promise<T>): Promise<Tried<T>> {
  let last: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return { ok: true, value: await run() }
    } catch (error) {
      last = error
      if (!isUnavailable(error)) {
        break
      }
    }
  }
  return { ok: false, unavailable: isUnavailable(last) }
}

export type AdoptResult =
  | { ok: true; attemptId: string; adopted: boolean }
  | { ok: false; reason: "hq_unreachable" | "conflict_other_session" | "conflict_limit" | "error" }

type Decision = AdoptResult | "start"

/**
 * What the item's own rows say about this call, with no call to hq: the attempt to adopt, the
 * reason it cannot proceed, or `"start"`. Never reads an error message.
 */
function decide(detail: WorkItemDetail, call: StationCall): Decision {
  const key = stationKey(call)
  const want = kindOf(call.station)
  const list = detail.attemptList
  // This call's own attempt, in any status: a replay, a retry or a second run of one call.
  const keyed = list.find((a) => a.externalRef === key)
  if (keyed) {
    return { ok: true, attemptId: keyed.id, adopted: true }
  }
  const mine = (a: AttemptView): boolean => belongsToCall(a, call)
  const active = list.filter((a) => a.status !== "finished")
  const running = active.find((a) => a.status === "running" && a.kind === want && mine(a))
  if (running) {
    return { ok: true, attemptId: running.id, adopted: true }
  }
  const foreign = active.find((a) => !mine(a))
  if (foreign) {
    return { ok: false, reason: "conflict_other_session" }
  }
  if (active.length > 0 || call.station === "reviewer") {
    // An attempt of the other kind runs, or there is no fix to review (the reviewer starts none).
    return { ok: false, reason: "error" }
  }
  const limit = detail.attempts.limit ?? call.attemptLimit ?? null
  if (want === "fix" && limit !== null && detail.attempts.used >= limit) {
    return { ok: false, reason: "conflict_limit" }
  }
  return "start"
}

/**
 * Adopts the attempt this call already has, or starts the one its station needs: the adopt-or-start
 * half of {@link beginStation}, a plain function that steps call (never a step of its own).
 *
 * @remarks
 * The item is read first, so a replay, a retry or a second run of the same call adopts the attempt
 * hq holds under the call's key ({@link stationKey}, any status) and starts nothing. Else a running
 * attempt of the station's kind that belongs to this session (its `externalRef` starts with
 * `<sessionId>:`, the colon included) or to this ticket is adopted; another session's is not
 * (`conflict_other_session`). The analyst starts an `investigate` and the implementer a `fix` with
 * the call's `attemptLimit`; the reviewer starts nothing. A start whose first call ends
 * unavailable is repeated once with the same key, and hq answers the same attempt for the same
 * key. Any other failure is classified by reading the item again, never by hq's message.
 */
export async function adoptOrStartAttempt(
  hq: HqClient,
  call: StationCall,
  itemRef: string,
): Promise<AdoptResult> {
  const read = await withInlineRetry(() => hq.getWorkItem({ itemId: itemRef }))
  if (!read.ok) {
    return { ok: false, reason: read.unavailable ? "hq_unreachable" : "error" }
  }
  const decided = decide(read.value, call)
  if (decided !== "start") {
    return decided
  }
  const started = await withInlineRetry(() =>
    hq.startAttempt({
      itemId: itemRef,
      kind: kindOf(call.station),
      externalRef: stationKey(call),
      ...(call.station === "implementer" && call.attemptLimit !== undefined
        ? { attemptLimit: call.attemptLimit }
        : {}),
    }),
  )
  if (started.ok) {
    return { ok: true, attemptId: started.value.id, adopted: false }
  }
  if (started.unavailable) {
    return { ok: false, reason: "hq_unreachable" }
  }
  // hq refused: say why from the item's rows (a racing start may even have won with this key).
  const reread = await withInlineRetry(() => hq.getWorkItem({ itemId: itemRef }))
  if (!reread.ok) {
    return { ok: false, reason: reread.unavailable ? "hq_unreachable" : "error" }
  }
  const why = decide(reread.value, call)
  return why === "start" ? { ok: false, reason: "error" } : why
}

/** Whether an attempt belongs to this call's session (the colon included) or to its ticket. */
export function belongsToCall(
  a: AttemptView,
  call: Pick<StationCall, "sessionId" | "subject">,
): boolean {
  const ticketRef = call.subject?.kind === "ticket" ? call.subject.ticketId : null
  return (
    a.externalRef !== null &&
    (a.externalRef.startsWith(`${call.sessionId}:`) || a.externalRef === ticketRef)
  )
}

/**
 * The attempt of this session (or this ticket) that is running now: the one a question ends. The
 * newest, when two run. Another session's running attempt is never returned.
 */
export function runningAttemptOf(
  detail: WorkItemDetail,
  call: Pick<StationCall, "sessionId" | "subject">,
): AttemptView | null {
  return (
    detail.attemptList.filter((a) => a.status === "running" && belongsToCall(a, call)).at(-1) ??
    null
  )
}

/**
 * Whether the implementer's step must stop the run: the plan's rule, decided WITHOUT `decide`
 * (whose later branches answer other questions). False for any other station, when no limit is
 * stored, when an attempt carries this call's key (any status: a replay) and when a running fix of
 * this session or ticket can be adopted. Otherwise true when `used` has reached the stored limit,
 * whatever else is active: another session's running fix, or this session's own attempt of the
 * other kind, does not give the implementer a budget it has not got.
 */
export function limitReached(detail: WorkItemDetail, call: StationCall): boolean {
  const { limit, used } = detail.attempts
  if (call.station !== "implementer" || limit === null) {
    return false
  }
  const key = stationKey(call)
  const adoptable = detail.attemptList.some(
    (a) =>
      a.externalRef === key ||
      (a.status === "running" && a.kind === "fix" && belongsToCall(a, call)),
  )
  return !adoptable && used >= limit
}
