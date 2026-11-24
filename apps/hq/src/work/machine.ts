// The work item state machine. Pure: it imports only @proof/errors, does no I/O and reads no clock;
// callers pass facts and `now`. Every state change goes through `assertTransition`.
import { AppError } from "@proof/errors"

import { VERIFY_WINDOW_HOURS } from "./constants"

export const WORK_STAGES = [
  "signal",
  "triage",
  "plan",
  "attempt",
  "review",
  "deploy",
  "verify",
] as const
export const WORK_END_STATES = ["done", "reopened", "stopped"] as const
export const WORK_STATES = [...WORK_STAGES, ...WORK_END_STATES] as const
export type WorkStage = (typeof WORK_STAGES)[number]
export type WorkState = (typeof WORK_STATES)[number]

export const WORK_ACTORS = ["agent", "founder", "system"] as const
export type WorkActor = (typeof WORK_ACTORS)[number]

export const TRANSITION_REASONS = [
  "ingested",
  "investigation_started",
  "fix_started",
  "pull_request_opened",
  "retry_started",
  "pull_request_merged",
  "pull_request_closed",
  "deploy_grace_elapsed",
  "window_passed",
  "recurrence",
  "contract_failed",
  "reopened",
  "revert_requested",
  "retriaged",
  "stopped",
] as const
export type TransitionReason = (typeof TRANSITION_REASONS)[number]

export const SIGNAL_SOURCES = ["github_issue", "ci_failure", "manual", "sentry", "posthog"] as const
export type SignalSource = (typeof SIGNAL_SOURCES)[number]
// A spike's decision record may add one.
export const CONNECTED_SIGNAL_SOURCES = ["github_issue", "ci_failure", "manual"] as const

export const ATTEMPT_KINDS = ["investigate", "fix"] as const
export type AttemptKind = (typeof ATTEMPT_KINDS)[number]
export const ATTEMPT_STATUSES = ["requested", "running", "finished"] as const
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number]
// needs_answer: the agent asked a founder and ended; it does not count as used (the budget counts
// fix attempts only).
export const ATTEMPT_RESULTS = [
  "investigated",
  "approved",
  "rejected",
  "failed",
  "needs_answer",
  "abandoned",
] as const
export type AttemptResult = (typeof ATTEMPT_RESULTS)[number]
// sentry and posthog are refused until connected.
export const VERIFIER_KINDS = ["reviewer", "ci", "signal_recurrence", "sentry", "posthog"] as const
export type VerifierKind = (typeof VERIFIER_KINDS)[number]

export type GuardName =
  | "contract_and_budget"
  | "pr_open_or_merged"
  | "has_budget"
  | "pr_merged"
  | "pr_closed"
  | "grace_elapsed"
  | "window_passed"

export interface TransitionRow {
  from: WorkState
  to: WorkState
  actor: WorkActor
  reasons: readonly TransitionReason[]
  guard: GuardName | null
}

const row = (
  from: WorkState,
  to: WorkState,
  actor: WorkActor,
  reasons: readonly TransitionReason[],
  guard: GuardName | null = null,
): TransitionRow => ({ from, to, actor, reasons, guard })

// The pinned table: one row per (from, to, actor), and nothing else is an edge.
export const TRANSITIONS: readonly TransitionRow[] = [
  row("signal", "triage", "system", ["ingested"]),
  row("triage", "plan", "agent", ["investigation_started"]),
  row("plan", "attempt", "agent", ["fix_started"], "contract_and_budget"),
  row("attempt", "review", "agent", ["pull_request_opened"], "pr_open_or_merged"),
  row("review", "attempt", "agent", ["retry_started"], "has_budget"),
  row("review", "deploy", "agent", ["pull_request_merged"], "pr_merged"),
  row("review", "stopped", "agent", ["pull_request_closed"], "pr_closed"),
  row("review", "stopped", "founder", ["stopped"]),
  row("triage", "stopped", "founder", ["stopped"]),
  row("plan", "stopped", "founder", ["stopped"]),
  row("attempt", "stopped", "founder", ["stopped"]),
  row("deploy", "stopped", "founder", ["stopped"]),
  row("verify", "stopped", "founder", ["stopped"]),
  row("deploy", "verify", "system", ["deploy_grace_elapsed"], "grace_elapsed"),
  row("verify", "done", "system", ["window_passed"], "window_passed"),
  row("verify", "reopened", "system", ["contract_failed", "recurrence"]),
  row("verify", "reopened", "founder", ["reopened", "revert_requested"]),
  row("deploy", "reopened", "founder", ["revert_requested"]),
  row("done", "reopened", "system", ["recurrence"]),
  row("done", "reopened", "founder", ["reopened", "revert_requested"]),
  row("reopened", "triage", "system", ["retriaged"]),
  row("stopped", "triage", "founder", ["reopened"]),
]

export interface GuardFacts {
  contractItems: number
  pullRequest: "none" | "open" | "merged" | "closed"
  attemptsRemaining: boolean
  graceElapsed: boolean
  windowPassed: boolean
}

const GUARDS: Record<GuardName, (f: GuardFacts) => boolean> = {
  contract_and_budget: (f) => f.contractItems >= 1 && f.attemptsRemaining,
  pr_open_or_merged: (f) => f.pullRequest === "open" || f.pullRequest === "merged",
  has_budget: (f) => f.attemptsRemaining,
  pr_merged: (f) => f.pullRequest === "merged",
  pr_closed: (f) => f.pullRequest === "closed",
  grace_elapsed: (f) => f.graceElapsed,
  window_passed: (f) => f.windowPassed,
}

export function findTransition(
  from: WorkState,
  to: WorkState,
  actor: WorkActor,
): TransitionRow | null {
  return TRANSITIONS.find((r) => r.from === from && r.to === to && r.actor === actor) ?? null
}

/** The row for this edge and actor, or an AppError: FORBIDDEN when only another actor has the edge,
 * CONFLICT when no actor has it, the reason is not listed or the guard fails. */
export function assertTransition(input: {
  from: WorkState
  to: WorkState
  actor: WorkActor
  reason: TransitionReason
  facts: GuardFacts
}): TransitionRow {
  const { from, to, actor, reason, facts } = input
  const found = findTransition(from, to, actor)
  if (!found) {
    const edge = `${from} to ${to}`
    if (TRANSITIONS.some((r) => r.from === from && r.to === to)) {
      throw new AppError("FORBIDDEN", `A ${actor} cannot move a work item from ${from} to ${to}.`, {
        context: { from, to, actor },
      })
    }
    throw new AppError("CONFLICT", `A work item cannot move from ${from} to ${to}.`, {
      context: { from, to, actor, edge },
    })
  }
  if (!found.reasons.includes(reason)) {
    throw new AppError("CONFLICT", `The reason ${reason} does not fit ${from} to ${to}.`, {
      context: { from, to, actor, reason },
    })
  }
  if (found.guard && !GUARDS[found.guard](facts)) {
    throw new AppError(
      "CONFLICT",
      `A work item cannot move from ${from} to ${to} yet (${found.guard}).`,
      {
        context: { from, to, actor, guard: found.guard },
      },
    )
  }
  return found
}

export const isInFlight = (s: WorkState): boolean =>
  !(WORK_END_STATES as readonly string[]).includes(s)

export type Attention = "merge_approval" | "agent_question" | "attempt_budget" | "stuck_attempt"

export interface AttentionFacts {
  state: WorkState
  pendingMergeApproval: boolean
  openQuestion: boolean
  // attemptsUsed and newestFixResult are the CURRENT cycle's: fix attempts only, null when the cycle
  // has no finished fix.
  attemptsUsed: number
  attemptLimit: number | null
  activeAttempt: "none" | "fresh" | "stale"
  newestFixResult: AttemptResult | null
}

const BUDGET_STATES: readonly WorkState[] = ["triage", "plan", "attempt", "review"]
const BUDGET_RESULTS: readonly (AttemptResult | null)[] = [null, "failed", "rejected", "abandoned"]

// Priority: merge_approval, agent_question, attempt_budget, stuck_attempt. An approved third fix is not
// an exhausted item: it waits on its merge approval.
export function deriveAttention(f: AttentionFacts): Attention | null {
  if (!isInFlight(f.state)) return null
  if (f.pendingMergeApproval) return "merge_approval"
  if (f.openQuestion) return "agent_question"
  if (
    BUDGET_STATES.includes(f.state) &&
    f.attemptLimit !== null &&
    f.attemptsUsed >= f.attemptLimit &&
    f.activeAttempt === "none" &&
    BUDGET_RESULTS.includes(f.newestFixResult)
  ) {
    return "attempt_budget"
  }
  if (f.activeAttempt === "stale") return "stuck_attempt"
  return null
}

export interface CardFacts extends AttentionFacts {
  attention: Attention | null
  activeKind: AttemptKind | null
  windowEndsAt: Date | null
  now: Date
}

export interface CardState {
  label:
    | "running"
    | "queued"
    | "asking you"
    | "needs you"
    | "watching"
    | "verified"
    | "reopened"
    | "stopped"
    | "waiting"
  tone: "blue" | "dim" | "amber" | "teal" | "coral"
  detail: string
}

function timeLeft(endsAt: Date | null, now: Date): string {
  if (!endsAt) return "window not set"
  const minutes = Math.ceil((endsAt.getTime() - now.getTime()) / 60_000)
  if (minutes <= 0) return "closing"
  if (minutes < 60) return `${minutes}m left`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m left`
}

export function deriveCardState(f: CardFacts): CardState {
  switch (f.attention) {
    case "agent_question":
      return { label: "asking you", tone: "amber", detail: "waits for your answer" }
    case "merge_approval":
      return { label: "needs you", tone: "amber", detail: "merge approval" }
    case "attempt_budget":
      return {
        label: "needs you",
        tone: "amber",
        detail: `attempt ${f.attemptsUsed} of ${f.attemptLimit}`,
      }
    case "stuck_attempt":
      return { label: "needs you", tone: "amber", detail: "attempt stopped reporting" }
    case null:
      break
  }
  switch (f.state) {
    case "done":
      return {
        label: "verified",
        tone: "teal",
        detail: `no recurrence in ${VERIFY_WINDOW_HOURS} h`,
      }
    case "reopened":
      return { label: "reopened", tone: "coral", detail: "back in triage" }
    case "stopped":
      return { label: "stopped", tone: "dim", detail: "stopped by a founder" }
    case "verify":
      return {
        label: "watching",
        tone: "teal",
        detail: `verifier · ${timeLeft(f.windowEndsAt, f.now)}`,
      }
    case "deploy":
      return { label: "waiting", tone: "dim", detail: "merged · deploy not observed" }
    default:
      break
  }
  if (f.activeAttempt !== "none") {
    if (f.activeKind === "fix") {
      const of = f.attemptLimit === null ? "" : ` of ${f.attemptLimit}`
      return { label: "running", tone: "blue", detail: `fixer · attempt ${f.attemptsUsed}${of}` }
    }
    return {
      label: "running",
      tone: "blue",
      detail: f.activeKind === "investigate" ? "investigator" : "working",
    }
  }
  switch (f.state) {
    case "signal":
      return { label: "queued", tone: "dim", detail: "waits for triage" }
    case "triage":
      return { label: "queued", tone: "dim", detail: "waits for a founder to start" }
    case "plan":
      return { label: "queued", tone: "dim", detail: "planned · waits for a fix" }
    case "attempt":
      return { label: "queued", tone: "dim", detail: "waits for the next attempt" }
    default:
      return {
        label: "waiting",
        tone: "dim",
        detail:
          f.newestFixResult === "approved"
            ? "in review · waits for the merge"
            : "in review · waits for the next attempt",
      }
  }
}

export const BOARD_COLUMNS = [
  { key: "triage", label: "Triage", states: ["signal", "triage"] },
  { key: "fixing", label: "Fixing", states: ["plan", "attempt"] },
  { key: "in_review", label: "In review", states: ["review"] },
  { key: "verifying", label: "Verifying", states: ["deploy", "verify"] },
  { key: "done_today", label: "Done today", states: ["done", "reopened", "stopped"] },
] as const
export type BoardColumnKey = (typeof BOARD_COLUMNS)[number]["key"]

const utcDay = (d: Date) => d.toISOString().slice(0, 10)

// done_today only for the same UTC day as now: an older end state is off the board.
export function columnFor(
  state: WorkState,
  stateChangedAt: Date,
  now: Date,
): BoardColumnKey | null {
  const column = BOARD_COLUMNS.find((c) => (c.states as readonly WorkState[]).includes(state))
  if (!column) return null
  if (column.key === "done_today" && utcDay(stateChangedAt) !== utcDay(now)) return null
  return column.key
}

export const WORK_ID_PREFIX = "FAC"
export const displayId = (n: number): string => `${WORK_ID_PREFIX}-${n}`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DISPLAY = new RegExp(`^${WORK_ID_PREFIX}-(\\d+)$`, "i")

export function parseWorkRef(
  ref: string,
): { kind: "id"; id: string } | { kind: "number"; number: number } | null {
  if (UUID.test(ref)) return { kind: "id", id: ref.toLowerCase() }
  const m = DISPLAY.exec(ref)
  if (!m) return null
  const number = Number(m[1])
  return Number.isSafeInteger(number) && number >= 1 ? { kind: "number", number } : null
}
