// The zod shapes of the work operations (the plan's I10): what an operation takes and returns.
// The web imports this file for its own parsing, so it holds zod and the pure vocabulary of
// `../work/*` and nothing else: no database, no hono, no JSX (a test scans the imports).
//
// An output schema must name EVERY field the data layer returns: zod strips a key it does not
// know, silently. `work-agent.test.ts` compares the key sets of a fully populated reply with the
// data layer's value, so a field added there and forgotten here fails a test.
//
// Times are ISO 8601 strings (`isoDate`); the data layer's Dates are turned into them by the
// operation (`jsonify`). Every text field below is data written by someone outside hq or by a
// model: stored capped, never an instruction.
import { z } from "zod"

import {
  ATTEMPT_LIMIT_MAX,
  BRANCH_MAX_CHARS,
  EXTERNAL_REF_MAX_CHARS,
  FILE_MAX_CHARS,
  FILES_MAX,
  NOTE_MAX_CHARS,
  PAYLOAD_MAX_BYTES,
  RUN_ID_MAX_CHARS,
  SESSION_ID_MAX_CHARS,
} from "../work/constants"
import {
  ATTEMPT_KINDS,
  ATTEMPT_RESULTS,
  ATTEMPT_STATUSES,
  type Attention,
  type CardState,
  parseWorkRef,
  SIGNAL_SOURCES,
  VERIFIER_KINDS,
  WORK_ACTORS,
  WORK_STAGES,
  WORK_STATES,
} from "../work/machine"
import {
  CONTRACT_ITEM_STATUSES,
  HEAD_SHA_PATTERN,
  MERGE_APPROVAL_STATUSES,
  PULL_REQUEST_STATES,
  QUESTION_STATUSES,
  type RecordSignalInput,
  REVIEWER_VERDICTS,
  WINDOW_STATUSES,
  WORK_EVENT_KINDS,
} from "../work/types"

export const isoDate = z.string().describe("ISO 8601 time")

// ---------------------------------------------------------------------------------------------
// Input pieces the operations share.
// ---------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A work item: its id (a uuid) or its display id, `FAC-<n>`. Anything else is BAD_REQUEST. */
export const itemRef = z
  .string()
  .max(100)
  .refine((ref) => parseWorkRef(ref) !== null, "Expected a work item id (a uuid) or FAC-<number>")
  .describe("A work item: its id (a uuid) or its display id, FAC-<number>")

export const idRef = (what: string) =>
  z.string().max(100).regex(UUID, `Expected the ${what}'s id (a uuid)`).describe(`The ${what}'s id`)

export const attemptKind = z.enum(ATTEMPT_KINDS)
export const attemptStatus = z.enum(ATTEMPT_STATUSES)
export const attemptResult = z.enum(ATTEMPT_RESULTS)
export const workState = z.enum(WORK_STATES)
export const signalSource = z.enum(SIGNAL_SOURCES)
export const verifierKind = z.enum(VERIFIER_KINDS)
export const headSha = z
  .string()
  .regex(HEAD_SHA_PATTERN, "Expected a commit id: 7 to 64 hex digits")
  .describe("A commit id, 7 to 64 hex digits (stored lower-cased)")

export const branchName = z.string().min(1).max(BRANCH_MAX_CHARS)
export const filePaths = z.array(z.string().max(FILE_MAX_CHARS)).max(FILES_MAX)
export const noteText = z.string().max(NOTE_MAX_CHARS)
export const runId = z.string().min(1).max(RUN_ID_MAX_CHARS)
export const externalRef = z.string().min(1).max(EXTERNAL_REF_MAX_CHARS)
export const sessionId = z.string().min(1).max(SESSION_ID_MAX_CHARS)
export const attemptLimit = z.number().int().min(1).max(ATTEMPT_LIMIT_MAX)

/** What `record_signal` takes (RecordSignalInput of the plan). */
export const recordSignalInput = z.object({
  source: signalSource.describe("github_issue or ci_failure; sentry and posthog are not connected"),
  externalId: z.string().min(1).max(200).describe("The source's own id: redelivery is a duplicate"),
  dedupeKey: z.string().min(1).max(200).describe("What makes two signals one problem"),
  repo: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, "Expected owner/name")
    .max(200),
  title: z.string().min(1).max(300),
  summary: z.string().max(300),
  url: z.string().max(500).optional(),
  occurredAt: isoDate.optional(),
  payload: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(`An object of at most ${PAYLOAD_MAX_BYTES} serialized bytes`),
})
// The data layer's input type is what this schema parses to.
recordSignalInput satisfies z.ZodType<RecordSignalInput, unknown>

// ---------------------------------------------------------------------------------------------
// Outputs.
// ---------------------------------------------------------------------------------------------

const ATTENTIONS = ["merge_approval", "agent_question", "attempt_budget", "stuck_attempt"] as const
const CARD_LABELS = [
  "running",
  "queued",
  "asking you",
  "needs you",
  "watching",
  "verified",
  "reopened",
  "stopped",
  "waiting",
] as const
const CARD_TONES = ["blue", "dim", "amber", "teal", "coral"] as const

export const attention = z.enum(ATTENTIONS)
// Compile-time: the lists above name every Attention and every card label and tone.
type Missing<T, U> = Exclude<T, U> extends never ? true : false
const _attentions: Missing<Attention, (typeof ATTENTIONS)[number]> = true
const _labels: Missing<CardState["label"], (typeof CARD_LABELS)[number]> = true
const _tones: Missing<CardState["tone"], (typeof CARD_TONES)[number]> = true
void [_attentions, _labels, _tones]

export const cardState = z.object({
  label: z.enum(CARD_LABELS),
  tone: z.enum(CARD_TONES),
  detail: z.string(),
})

export const pullRequestSummary = z.object({
  number: z.number().int(),
  url: z.string(),
  state: z.enum(PULL_REQUEST_STATES),
  isDraft: z.boolean(),
})

export const workItemSummary = z.object({
  id: z.string(),
  number: z.number().int(),
  displayId: z.string().describe("FAC-<number>"),
  title: z.string(),
  repo: z.string(),
  source: signalSource,
  state: workState,
  cycle: z.number().int(),
  card: cardState,
  attention: attention.nullable().describe("What waits for a founder, or null"),
  waitingSince: isoDate.nullable(),
  attempts: z.object({
    used: z.number().int().describe("Fix attempts of the current cycle that count"),
    limit: z.number().int().nullable(),
    running: z.boolean().describe("A live attempt, not one whose lease ran out"),
  }),
  pullRequest: pullRequestSummary.nullable(),
  summary: z.string(),
  createdAt: isoDate,
  stateChangedAt: isoDate,
})

export const questionOption = z.object({
  id: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  detail: z.string().min(1).max(500).optional(),
})

export const needsYou = z.object({
  kind: attention,
  itemId: z.string(),
  displayId: z.string(),
  title: z.string(),
  reason: z.string(),
  since: isoDate,
  merge: z
    .object({
      pullRequestUrl: z.string(),
      headSha: z.string(),
      number: z.number().int(),
      isDraft: z.boolean(),
    })
    .optional(),
  question: z
    .object({
      questionId: z.string(),
      prompt: z.string(),
      options: z.array(questionOption),
      defaultOptionId: z.string().nullable(),
    })
    .optional(),
})

export const BOARD_COLUMN_KEYS = [
  "triage",
  "fixing",
  "in_review",
  "verifying",
  "done_today",
] as const

export const workBoard = z.object({
  now: isoDate,
  repos: z.array(z.string()),
  dispatch: z.enum(["label", "claim"]),
  columns: z
    .array(
      z.object({
        key: z.enum(BOARD_COLUMN_KEYS),
        label: z.string(),
        count: z.number().int().describe("The true total, above the cards listed"),
        items: z.array(workItemSummary),
      }),
    )
    .describe("triage, fixing, in_review, verifying, done_today, in that order"),
  stats: z.object({
    inFlight: z.number().int(),
    runningAttempts: z.number().int(),
    needsYou: z.number().int(),
    oldestWaitingMinutes: z.number().int().nullable(),
    resolvedToday: z.number().int(),
    verifiedToday: z.number().int(),
    watching: z.number().int(),
    reopened: z.number().int(),
    latestReopened: z.object({ displayId: z.string(), reason: z.string() }).nullable(),
  }),
  needsYou: z.array(needsYou),
})

export const contractItemView = z.object({
  id: z.string(),
  text: z.string(),
  verifier: z.object({ kind: verifierKind, label: z.string() }),
  status: z.enum(CONTRACT_ITEM_STATUSES),
  evidence: z.string().nullable(),
  checkedAt: isoDate.nullable(),
})

export const attemptView = z.object({
  id: z.string(),
  number: z.number().int(),
  cycle: z.number().int(),
  kind: attemptKind,
  status: attemptStatus,
  result: attemptResult.nullable(),
  requestedBy: z.string().nullable(),
  instructions: z.string().nullable(),
  startedAt: isoDate.nullable(),
  finishedAt: isoDate.nullable(),
  durationMs: z.number().int().nullable(),
  files: z.array(z.string()),
  note: z.string().nullable(),
  branch: z.string().nullable(),
  reviewer: z
    .object({
      verdict: z.enum(REVIEWER_VERDICTS),
      summary: z.string(),
      headSha: z.string().optional().describe("The head the reviewer read"),
    })
    .nullable(),
  runId: z.string().nullable(),
  sessionId: z.string().nullable(),
  externalRef: z.string().nullable(),
  leaseExpiresAt: isoDate.nullable(),
  costUsd: z.number().nullable().describe("The sum of the run's spend; null with no run id"),
  costEstimated: z.boolean(),
  endReason: z
    .enum(["merged", "stopped", "lease_expired"])
    .nullable()
    .describe("Why an abandoned attempt ended"),
})

export const questionView = z.object({
  id: z.string(),
  attemptId: z.string().nullable(),
  prompt: z.string(),
  options: z.array(questionOption),
  defaultOptionId: z
    .string()
    .nullable()
    .describe("A recommendation only; never applied on a timer"),
  status: z.enum(QUESTION_STATUSES),
  answeredOptionId: z.string().nullable(),
  answeredBy: z.string().nullable(),
  answeredAt: isoDate.nullable(),
  createdAt: isoDate,
})

export const pullRequestView = z.object({
  number: z.number().int(),
  url: z.string(),
  branch: z.string(),
  base: z.string(),
  headSha: z.string(),
  isDraft: z.boolean(),
  state: z.enum(PULL_REQUEST_STATES),
  additions: z.number().int().nullable(),
  deletions: z.number().int().nullable(),
  files: z.number().int().nullable(),
  checks: z.array(z.object({ name: z.string(), state: z.enum(["passed", "failed", "pending"]) })),
  mergedAt: isoDate.nullable(),
  mergedBy: z.string().nullable(),
})

export const eventView = z.object({
  id: z.string(),
  at: isoDate,
  kind: z.enum(WORK_EVENT_KINDS),
  fromState: workState.nullable(),
  toState: workState.nullable(),
  actorType: z.enum(WORK_ACTORS),
  actorId: z.string(),
  reason: z.string().nullable(),
  note: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).nullable().describe("Facts hq recorded; never a link"),
  cycle: z.number().int(),
  summary: z.string().describe("One line hq built from its own fields"),
})

export const workItemDetail = workItemSummary.extend({
  signal: z
    .object({
      id: z.string(),
      source: signalSource,
      externalId: z.string(),
      url: z.string().nullable(),
      urlChecked: z.boolean().describe("True when the url is a GitHub page of the item's repo"),
      summary: z.string(),
      occurrences: z.number().int(),
      firstSeenAt: isoDate,
      lastSeenAt: isoDate,
      evidence: z.string().nullable().describe("Plain text from the signal's payload, capped"),
    })
    .nullable(),
  stages: z.array(
    z.object({ stage: z.enum(WORK_STAGES), status: z.enum(["done", "now", "todo"]) }),
  ),
  contract: z.array(contractItemView),
  attemptList: z.array(attemptView).describe("Newest 50, oldest first; attempts is the count"),
  questions: z.array(questionView),
  pullRequest: pullRequestView.nullable(),
  mergeApproval: z
    .object({
      id: z.string(),
      status: z.enum(MERGE_APPROVAL_STATUSES),
      headSha: z.string(),
      requestedAt: isoDate,
      decidedBy: z.string().nullable(),
      decidedAt: isoDate.nullable(),
      note: z.string().nullable(),
    })
    .nullable(),
  window: z
    .object({
      status: z.enum(WINDOW_STATUSES),
      startsAt: isoDate,
      endsAt: isoDate,
      remainingMinutes: z.number().int().nullable(),
      // Not null: hq reads it from its own window row (it opened 15 minutes after the merge).
      mergedAt: isoDate.describe("The merge the window counts from"),
      pastEnd: z.boolean(),
      waitingOn: z.array(
        z.object({
          contractItemId: z.string(),
          kind: verifierKind,
          state: z.enum(["pending", "not_connected", "failing"]),
        }),
      ),
      buckets: z.array(z.object({ at: isoDate, count: z.number().int() })),
    })
    .nullable(),
  founderNotes: z.array(
    z.object({
      at: isoDate,
      kind: z.enum(["retry", "answer", "revert", "request"]),
      text: z.string(),
    }),
  ),
  events: z.array(eventView).describe("Newest 50"),
  truncated: z.object({
    attempts: z.boolean(),
    questions: z.boolean(),
    events: z.boolean(),
  }),
  actions: z.object({
    canStop: z.boolean(),
    canReopen: z.boolean(),
    canRevert: z.boolean(),
    canRetry: z.boolean(),
    canRequestAttempt: z.boolean(),
  }),
})

export const sweepResult = z.object({
  advanced: z.array(z.string()).describe("Item ids that moved deploy to verify"),
  passed: z.array(z.string()).describe("Item ids that moved verify to done"),
  reopened: z.array(z.string()).describe("Item ids whose contract failed"),
  retriaged: z.array(z.string()).describe("Item ids that moved reopened to triage"),
  abandoned: z.array(z.string()).describe("Attempt ids whose lease ran out"),
  errors: z
    .array(
      z.object({
        itemId: z.string().nullable(),
        rule: z.enum(["expire", "retriage", "advance", "settle"]),
        message: z.string(),
      }),
    )
    .describe("What failed and was skipped: one item's error never stops the pass"),
})

// ---------------------------------------------------------------------------------------------
// get_digest's `pipeline` (Task 19). One shape, built twice: the web's fake validates its fixtures
// with the strict build, so a key hq never sends is refused there.
// ---------------------------------------------------------------------------------------------

export const DIGEST_MERGED_STATES = ["merged", "verifying", "verified", "reopened"] as const
export const DIGEST_EVENT_RESULTS = ["opened", "merged", "reopened", "verified", "stopped"] as const

const digestNeedsYouShape = {
  kind: attention,
  itemId: z.string(),
  displayId: z.string(),
  title: z.string(),
  reason: z.string(),
  since: isoDate,
}
const digestMergedShape = {
  at: isoDate,
  displayId: z.string(),
  title: z.string(),
  pullRequestUrl: z.string(),
  repo: z.string().describe("The item's repo (owner/name, lower case)"),
  number: z.number().int().min(1).describe("The pull request's number"),
  state: z.enum(DIGEST_MERGED_STATES),
}
const digestEventShape = {
  at: isoDate,
  displayId: z.string(),
  text: z.string().describe("The item's title: untrusted text, shown as text only"),
  result: z.enum(DIGEST_EVENT_RESULTS),
}
const count = (description: string) => z.number().int().min(0).describe(description)
const digestCounts = {
  opened: count("Items that entered triage in the window"),
  resolved: count("Items whose verification window passed (they moved to done) in the window"),
  reopened: count("Items reopened in the window, one count per item"),
  stuckAttempts: count(
    "Running attempts of items in flight whose lease has passed, as of the window's end (as the board counts)",
  ),
  needsYouTotal: count("Every item that waits for a founder now"),
}
const digestLists = {
  needsYou: "What waits for a founder now, oldest first, at most 5",
  merged:
    "Pull requests merged in the window, newest first, at most 10; state is reopened only when a reopen event follows the merge, else the item's end state (verifying, verified) or merged",
  events: "Newest first, at most 30",
}

export const digestPipeline = z.object({
  ...digestCounts,
  needsYou: z.array(z.object(digestNeedsYouShape)).describe(digestLists.needsYou),
  merged: z.array(z.object(digestMergedShape)).describe(digestLists.merged),
  events: z.array(z.object(digestEventShape)).describe(digestLists.events),
})
/** The same shape, strict at every level: what the web's fake holds its fixtures to. */
export const digestPipelineStrict = z.strictObject({
  ...digestCounts,
  needsYou: z.array(z.strictObject(digestNeedsYouShape)),
  merged: z.array(z.strictObject(digestMergedShape)),
  events: z.array(z.strictObject(digestEventShape)),
})
