import "../zod-config"

import { z } from "zod"

import {
  attemptView,
  contractItemView,
  digestPipeline,
  eventView,
  needsYou,
  pullRequestSummary,
  pullRequestView,
  questionView,
  workBoard,
  workItemDetail,
  workItemSummary,
} from "../../../src/operations/work-schemas"

// The wire shapes of hq, as the client parses them. The contract test
// (apps/hq/src/web-contract.test.ts) parses real replies and the fake's with these same schemas.

const iso = z.string()

export const sessionUserSchema = z.object({ id: z.string(), email: z.string(), name: z.string() })
export type SessionUser = z.infer<typeof sessionUserSchema>

/** better-auth's get-session: `null` with no cookie, `{ session, user }` with one. */
export const sessionReplySchema = z
  .object({ session: z.unknown(), user: sessionUserSchema })
  .nullable()

export const statusSchema = z.object({ ok: z.literal(true), version: z.string() })

export const ENTRY_KINDS = ["fact", "voice", "decision", "playbook", "customer"] as const
export type EntryKind = (typeof ENTRY_KINDS)[number]
export const PROPOSAL_STATUSES = ["pending", "approved", "rejected"] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

export const proposalSchema = z.object({
  id: z.string(),
  entryId: z.string().nullable(),
  kind: z.enum(ENTRY_KINDS),
  slug: z.string(),
  baseVersion: z.number().int().nullable(),
  title: z.string(),
  body: z.object({ text: z.string() }).catchall(z.unknown()),
  reason: z.string(),
  status: z.enum(PROPOSAL_STATUSES),
  proposedBy: z.object({ type: z.enum(["person", "agent"]), id: z.string() }),
  runId: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: iso.nullable(),
  decisionNote: z.string().nullable(),
  createdAt: iso,
})
export type Proposal = z.infer<typeof proposalSchema>

export const proposalsPageSchema = z.object({
  proposals: z.array(proposalSchema),
  nextCursor: z.string().nullable(),
})

export const decisionSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  entryId: z.string().optional(),
  version: z.number().int().optional(),
})
export type Decision = z.infer<typeof decisionSchema>

const runnerName = z.enum(["eve", "sandbox", "box"])
const runOutcome = z.enum(["succeeded", "failed", "stopped"])

export const factoryStatusSchema = z.object({
  now: iso,
  pendingProposals: z.number().int(),
  runners: z.array(
    z.object({
      runner: runnerName,
      lastStartedAt: iso.nullable(),
      lastOutcome: runOutcome.nullable(),
    }),
  ),
  allowance: z.object({
    day: z.string(),
    spentUsd: z.number(),
    reservedUsd: z.number(),
    capUsd: z.number(),
    grantedUsd: z.number(),
    remainingUsd: z.number(),
  }),
  // The pipeline's counts; null before hq's work tables exist. Optional so an older hq, which
  // sends no `work` key at all, still parses (zod strips a key the schema lacks, so it is named).
  work: z
    .object({
      inFlight: z.number().int(),
      needsYou: z.number().int(),
      pendingMergeApprovals: z.number().int(),
      openQuestions: z.number().int(),
    })
    .nullable()
    .optional(),
})
export type FactoryStatus = z.infer<typeof factoryStatusSchema>

export const digestSchema = z.object({
  since: iso,
  until: iso,
  hours: z.number().int(),
  summary: z.object({
    tone: z.enum(["quiet", "attention"]),
    runsFinished: z.number().int(),
    runsFailed: z.number().int(),
    pendingProposals: z.number().int(),
  }),
  decisions: z.array(
    z.object({
      proposalId: z.string(),
      entryKind: z.enum(ENTRY_KINDS),
      title: z.string(),
      reason: z.string(),
      createdAt: iso,
    }),
  ),
  events: z.array(
    z.object({
      at: iso,
      kind: z.enum(["run", "proposal"]),
      ref: z.string(),
      text: z.string(),
      result: z.enum([
        "started",
        "succeeded",
        "failed",
        "stopped",
        "proposed",
        "approved",
        "rejected",
      ]),
      costUsd: z.number().nullable(),
    }),
  ),
  spend: z.object({
    totalUsd: z.number(),
    estimatedUsd: z.number(),
    bySource: z.array(z.object({ source: z.enum(["eve", "build", "box"]), amountUsd: z.number() })),
  }),
  health: z.object({ stuckRuns: z.number().int(), lastRunStartedAt: iso.nullable() }),
  productHealth: z.object({ connected: z.literal(false) }),
  deploys: z.object({ connected: z.literal(false) }),
  // The pipeline's part (hq's own schema); null before hq's work tables exist. Optional so an
  // older hq, which sends no `pipeline` key at all, still parses.
  pipeline: digestPipeline.nullable().optional(),
})
export type Digest = z.infer<typeof digestSchema>
export type DigestPipeline = z.infer<typeof digestPipeline>

export const policySchema = z.object({
  spend: z.object({
    dailyCapUsd: z.number(),
    maxGrantRequestUsd: z.number(),
    maxGrantRequestsPerDay: z.number().int(),
    staleHoldMinutes: z.number().int(),
    slackDailyGrantCapUsd: z.number(),
    grantedTodayUsd: z.number(),
  }),
  approvals: z.object({
    personOnly: z.array(z.object({ resource: z.string(), actions: z.array(z.string()) })),
  }),
  founders: z.number().int(),
})
export type Policy = z.infer<typeof policySchema>

// The work pipeline. These ARE hq's own output schemas (operations/work-schemas.ts, which holds
// only zod and the pure vocabulary of work/*, so it ships to the browser): the app parses exactly
// what hq promises, enums included, so a state or kind hq adds without the app fails loudly as a
// `server` error instead of rendering as something else.
export const workBoardSchema = workBoard
export type WorkBoard = z.infer<typeof workBoardSchema>
export const workItemSummarySchema = workItemSummary
export type WorkItemSummary = z.infer<typeof workItemSummarySchema>
export const workItemDetailSchema = workItemDetail
export type WorkItemDetail = z.infer<typeof workItemDetailSchema>
export const needsYouSchema = needsYou
export type NeedsYou = z.infer<typeof needsYouSchema>
export const attemptViewSchema = attemptView
export type AttemptView = z.infer<typeof attemptViewSchema>
export const questionViewSchema = questionView
export type QuestionView = z.infer<typeof questionViewSchema>
export const contractItemViewSchema = contractItemView
export type ContractItemView = z.infer<typeof contractItemViewSchema>
export const pullRequestViewSchema = pullRequestView
export type PullRequestView = z.infer<typeof pullRequestViewSchema>
export const pullRequestSummarySchema = pullRequestSummary
export const eventViewSchema = eventView
export type EventView = z.infer<typeof eventViewSchema>

export const workItemsPageSchema = z.object({
  items: z.array(workItemSummarySchema),
  nextCursor: z.string().nullable(),
})
export type WorkItemsPage = z.infer<typeof workItemsPageSchema>

/** What each founder operation answers (work-founder.ts). */
export const createdWorkItemSchema = z.object({ itemId: z.string(), displayId: z.string() })
export const mergeApprovalReplySchema = z.object({
  status: z.literal("approved"),
  headSha: z.string(),
  pullRequestUrl: z.string(),
})
export const stateReplySchema = z.object({ state: workItemSummarySchema.shape.state })
export const stoppedReplySchema = z.object({ state: z.literal("stopped") })
export const retryReplySchema = z.object({ attemptLimit: z.number().int() })
export const revertReplySchema = z.object({ state: z.literal("reopened") })

export type WorkState = WorkItemSummary["state"]
export type AttemptKind = AttemptView["kind"]

/** hq's `{ error: { code, message, hint? } }` (an AppError). */
export const errorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), hint: z.string().optional() }),
})
/** better-auth's own error body, as `/api/auth/*` answers it. */
export const authErrorSchema = z.object({ message: z.string(), code: z.string().optional() })
/** What a refused boot answers: a string `error`, no code. */
export const refusedBodySchema = z.object({ error: z.literal("service unavailable") })
