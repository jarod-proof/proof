// The plain input types of the work operations (I10), so the data layer never imports an operation.
// The zod schemas of operations/work-schemas.ts must `satisfy` them.
import type { AttemptResult, SignalSource, VerifierKind } from "./machine"

// Vocabularies shared with the database schema (db/schema.ts imports them, never the reverse).
export const PULL_REQUEST_STATES = ["open", "merged", "closed"] as const
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number]

export const REVIEWER_VERDICTS = ["approve", "request_changes", "reject"] as const
export type ReviewerVerdict = (typeof REVIEWER_VERDICTS)[number]

/** A commit id as git prints it: 7 to 64 hex digits (SHA-1 is 40, SHA-256 is 64). */
export const HEAD_SHA_PATTERN = /^[0-9a-f]{7,64}$/i

// Vocabularies of the work tables (db/schema.ts imports them and re-exports them).
export const CONTRACT_ITEM_STATUSES = ["pending", "passing", "failing"] as const
export const QUESTION_STATUSES = ["open", "answered", "withdrawn"] as const
export const MERGE_APPROVAL_STATUSES = ["pending", "approved", "void"] as const
export const WINDOW_STATUSES = ["running", "passed", "failed", "stopped"] as const
export const WORK_EVENT_KINDS = [
  "transition",
  "signal_attached",
  "attempt_requested",
  "attempt_request_refused",
  "attempt_started",
  "attempt_finished",
  "attempt_abandoned",
  "pull_request",
  "merge_approval_requested",
  "merge_approved",
  "merge_approval_void",
  "question_asked",
  "question_answered",
  "retry_granted",
  "revert_requested",
  "contract_set",
  "window_started",
  "window_closed",
] as const

export interface RecordSignalInput {
  source: SignalSource
  externalId: string // <= 200
  dedupeKey: string // <= 200
  repo: string // /^[\w.-]+\/[\w.-]+$/, lower-cased by hq
  title: string // <= 300
  summary: string // <= 300
  url?: string
  occurredAt?: string // ISO 8601
  payload?: Record<string, unknown> // <= 20 000 bytes serialized
}

export interface PullRequestCheck {
  name: string
  state: "passed" | "failed" | "pending"
}

export interface RecordPullRequestInput {
  itemId?: string
  branch: string
  number: number
  url: string
  // base, headSha, isDraft and state are required when the row does not exist yet
  base?: string
  headSha?: string
  isDraft?: boolean
  state?: PullRequestState
  additions?: number
  deletions?: number
  files?: number
  checks?: PullRequestCheck[]
  mergedBy?: string
  mergedAt?: string // ISO 8601, only with state "merged"
}

export interface ContractInput {
  text: string
  verifier: { kind: VerifierKind; config?: Record<string, unknown> }
}

export interface QuestionOptionInput {
  id: string
  label: string
  detail?: string
}

export interface AskQuestionInput {
  itemId: string
  prompt: string
  options: QuestionOptionInput[] // 2 to MAX_QUESTION_OPTIONS
  defaultOptionId?: string // a recommendation only
  attemptId?: string
}

export interface FinishAttemptInput {
  attemptId: string
  result: Exclude<AttemptResult, "abandoned"> // abandoned is set by the sweep only
  note?: string
  files?: string[]
  branch?: string
  sessionId?: string
  /** `headSha`: the head the reviewer read (7 to 64 hex digits); it wins over the branch lookup. */
  reviewer?: { verdict: ReviewerVerdict; summary: string; headSha?: string }
}
