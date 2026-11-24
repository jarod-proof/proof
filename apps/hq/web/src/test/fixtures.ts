import type {
  AttemptView,
  Digest,
  DigestPipeline,
  FactoryStatus,
  NeedsYou,
  Policy,
  Proposal,
  QuestionView,
  WorkBoard,
  WorkItemDetail,
  WorkItemSummary,
} from "../api/schemas"

/** A pending proposal from an agent, as `list_proposals` returns it. */
export function proposalFixture(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "proposal-1",
    entryId: null,
    kind: "fact",
    slug: "pricing",
    baseVersion: null,
    title: "Pricing",
    body: { text: "Free, then $20 per seat." },
    reason: "Stated in the founders call",
    status: "pending",
    proposedBy: { type: "agent", id: "key-1" },
    runId: null,
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: "2026-11-17T09:00:00.000Z",
    ...overrides,
  }
}

/** The factory at rest: three runners, one run on Eve, 38% of a $10 cap spent. */
export function factoryStatusFixture(overrides: Partial<FactoryStatus> = {}): FactoryStatus {
  return {
    now: "2026-11-17T12:00:00.000Z",
    pendingProposals: 1,
    runners: [
      { runner: "eve", lastStartedAt: "2026-11-17T08:00:00.000Z", lastOutcome: "succeeded" },
      { runner: "sandbox", lastStartedAt: null, lastOutcome: null },
      { runner: "box", lastStartedAt: null, lastOutcome: null },
    ],
    allowance: {
      day: "2026-11-17",
      spentUsd: 3.8,
      reservedUsd: 0,
      capUsd: 10,
      grantedUsd: 0,
      remainingUsd: 6.2,
    },
    work: { inFlight: 0, needsYou: 0, pendingMergeApprovals: 0, openQuestions: 0 },
    ...overrides,
  }
}

/** One quiet day: a run that succeeded, a pending proposal, a little spend. */
export function digestFixture(overrides: Partial<Digest> = {}): Digest {
  return {
    since: "2026-11-16T00:00:00.000Z",
    until: "2026-11-17T12:00:00.000Z",
    hours: 36,
    summary: { tone: "quiet", runsFinished: 1, runsFailed: 0, pendingProposals: 1 },
    decisions: [
      {
        proposalId: "proposal-1",
        entryKind: "fact",
        title: "Pricing",
        reason: "Stated in the founders call",
        createdAt: "2026-11-17T09:00:00.000Z",
      },
    ],
    events: [
      {
        at: "2026-11-17T08:30:00.000Z",
        kind: "run",
        ref: "run-1",
        text: "Triage the inbox",
        result: "succeeded",
        costUsd: 0.4,
      },
    ],
    spend: { totalUsd: 3.8, estimatedUsd: 0, bySource: [{ source: "eve", amountUsd: 3.8 }] },
    health: { stuckRuns: 0, lastRunStartedAt: "2026-11-17T08:00:00.000Z" },
    productHealth: { connected: false },
    deploys: { connected: false },
    // A fresh hq with its work tables and no work: zeros and empty lists, not null.
    pipeline: emptyDigestPipeline(),
    ...overrides,
  }
}

/** What a fresh hq (work tables, no work) answers for `get_digest`'s `pipeline`, value for value. */
export function emptyDigestPipeline(): DigestPipeline {
  return {
    opened: 0,
    resolved: 0,
    reopened: 0,
    stuckAttempts: 0,
    needsYou: [],
    needsYouTotal: 0,
    merged: [],
    events: [],
  }
}

/**
 * What a fresh hq replies to `get_policy`, value for value (the contract test compares them):
 * the constants hq enforces, a $50 Slack default, one founder and the three person-only `hq_`
 * actions of `PERSON_ONLY_ACTIONS`.
 */
export function policyFixture(overrides: Partial<Policy> = {}): Policy {
  return {
    spend: {
      dailyCapUsd: 10,
      maxGrantRequestUsd: 25,
      maxGrantRequestsPerDay: 10,
      staleHoldMinutes: 15,
      slackDailyGrantCapUsd: 50,
      grantedTodayUsd: 0,
    },
    approvals: {
      personOnly: [
        { resource: "hq_entry", actions: ["update"] },
        { resource: "hq_proposal", actions: ["decide"] },
        { resource: "hq_spend", actions: ["grant"] },
      ],
    },
    founders: 1,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------------------------
// The work pipeline. Built from the shapes real hq answers for the board scripts/seed-work.mjs
// makes (the contract test compares their keys, and the values of what a decision changes, with a
// real hq), so a screen's test never sees a looser reply than the app gets. Ids are real uuids and
// shas real hex because hq's own input checks run on them in the fake.
// ---------------------------------------------------------------------------------------------

/** The instant every work fixture is "now": the clock of the contract test's hq. */
export const WORK_NOW = "2026-11-17T12:00:00.000Z"
const WORK_REPO = "acme/web"
const REVIEW_PR = 106

/** Ids of the fixture items, questions and pull requests. */
export const WORK_IDS = {
  triage: "24e8049a-5a15-4fe6-8388-a433d252e7c3",
  asking: "d640afee-8c9a-4488-8131-688cc9efd185",
  exhausted: "c08bdcf7-b2cf-4ba0-8b70-396a4d3c75b9",
  review: "47334031-ce5e-421f-b072-040cdd201835",
  verifying: "e3026e46-3286-4963-9c1e-76223e1b4477",
  done: "c22068c9-5336-4095-b102-27ec55c76475",
  building: "7c2f5e1a-3d4b-4a6e-9c1d-2b8e0f4a6d13",
  question: "3e20b5f9-737c-4983-ac3f-58b7736e1308",
} as const
/** The head of the review item's open pull request (FAC-6, pull request 106). */
export const WORK_HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6a"

const STAGES = ["signal", "triage", "plan", "attempt", "review", "deploy", "verify"] as const
/** The seven stages with the current one marked: every earlier one done, every later one todo. */
function stagesAt(stage: (typeof STAGES)[number] | null): WorkItemDetail["stages"] {
  const now = stage === null ? STAGES.length : STAGES.indexOf(stage)
  return STAGES.map((name, i) => ({
    stage: name,
    status:
      stage === null || i < now
        ? ("done" as const)
        : i === now
          ? ("now" as const)
          : ("todo" as const),
  }))
}

const summaryBase = (n: number, id: string, title: string): WorkItemSummary => ({
  id,
  number: n,
  displayId: `FAC-${n}`,
  title,
  repo: WORK_REPO,
  source: "github_issue",
  state: "triage",
  cycle: 1,
  card: { label: "queued", tone: "dim", detail: "waits for a founder to start" },
  attention: null,
  waitingSince: null,
  attempts: { used: 0, limit: null, running: false },
  pullRequest: null,
  summary: `${title}.`,
  createdAt: WORK_NOW,
  stateChangedAt: WORK_NOW,
})

/** FAC-6: a fix approved by the reviewer, its pull request open, a merge approval waiting. */
export function workSummaryFixture(overrides: Partial<WorkItemSummary> = {}): WorkItemSummary {
  return {
    ...summaryBase(6, WORK_IDS.review, "Empty cart crashes the checkout"),
    state: "review",
    card: { label: "needs you", tone: "amber", detail: "merge approval" },
    attention: "merge_approval",
    waitingSince: "2026-11-17T12:00:00.001Z",
    attempts: { used: 1, limit: 3, running: false },
    pullRequest: {
      number: 106,
      url: "https://github.com/acme/web/pull/106",
      state: "open",
      isDraft: false,
    },
    stateChangedAt: "2026-11-17T12:00:00.001Z",
    ...overrides,
  }
}

const signalOf = (
  n: number,
  summary: string,
  occurrences = 1,
): NonNullable<WorkItemDetail["signal"]> => ({
  id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`,
  source: "github_issue",
  externalId: `github-issue:${WORK_REPO}#10${n}:opened`,
  url: `https://github.com/${WORK_REPO}/issues/10${n}`,
  urlChecked: true,
  summary,
  occurrences,
  firstSeenAt: WORK_NOW,
  lastSeenAt: WORK_NOW,
  evidence: `${summary} Reported by a customer.`,
})

const attemptBase = (n: number, kind: AttemptView["kind"]): AttemptView => ({
  id: `00000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`,
  number: n,
  cycle: 1,
  kind,
  status: "finished",
  result: kind === "fix" ? "approved" : "investigated",
  requestedBy: null,
  instructions: null,
  startedAt: WORK_NOW,
  finishedAt: WORK_NOW,
  durationMs: 0,
  files: [],
  note: null,
  branch: null,
  reviewer: null,
  runId: null,
  sessionId: null,
  externalRef: null,
  leaseExpiresAt: "2026-11-17T12:45:00.000Z",
  costUsd: null,
  costEstimated: false,
  endReason: null,
})

const contractOf = (status: "pending" | "passing"): WorkItemDetail["contract"] => [
  {
    id: `00000000-0000-4000-8000-00000000030${status === "pending" ? 1 : 3}`,
    text: "The reported flow works again",
    verifier: { kind: "reviewer", label: "reviewer" },
    status,
    evidence: status === "passing" ? "The reviewer approved fix attempt 2." : null,
    checkedAt: status === "passing" ? WORK_NOW : null,
  },
  {
    id: `00000000-0000-4000-8000-00000000030${status === "pending" ? 2 : 4}`,
    text: "The checks of the pull request pass",
    verifier: { kind: "ci", label: "ci" },
    status,
    evidence: status === "passing" ? "All 2 checks passed." : null,
    checkedAt: status === "passing" ? WORK_NOW : null,
  },
]

const detailBase = (summary: WorkItemSummary): WorkItemDetail => ({
  ...summary,
  pullRequest: null,
  signal: signalOf(summary.number, summary.summary),
  stages: stagesAt("triage"),
  contract: [],
  attemptList: [],
  questions: [],
  mergeApproval: null,
  window: null,
  founderNotes: [],
  events: [
    {
      id: `00000000-0000-4000-8000-0000000004${String(summary.number).padStart(2, "0")}`,
      at: WORK_NOW,
      kind: "transition",
      fromState: "signal",
      toState: "triage",
      actorType: "system",
      actorId: "hq",
      reason: "ingested",
      note: null,
      detail: null,
      cycle: 1,
      summary: "Moved from signal to triage (ingested).",
    },
  ],
  truncated: { attempts: false, questions: false, events: false },
  actions: {
    canStop: true,
    canReopen: false,
    canRevert: false,
    canRetry: false,
    canRequestAttempt: false,
  },
})

const reviewPullRequest = (n: number, sha: string): NonNullable<WorkItemDetail["pullRequest"]> => ({
  number: n,
  url: `https://github.com/${WORK_REPO}/pull/${n}`,
  branch: `factory/fix-${n}`,
  base: "main",
  headSha: sha,
  isDraft: false,
  state: "open",
  additions: 24,
  deletions: 6,
  files: 2,
  checks: [
    { name: "build", state: "passed" },
    { name: "test", state: "passed" },
  ],
  mergedAt: null,
  mergedBy: null,
})

/** FAC-6 in full: the item a founder approves a merge for. */
export function workItemFixture(overrides: Partial<WorkItemDetail> = {}): WorkItemDetail {
  const summary = workSummaryFixture()
  return {
    ...detailBase(summary),
    pullRequest: reviewPullRequest(106, WORK_HEAD_SHA),
    stages: stagesAt("review"),
    contract: contractOf("pending"),
    attemptList: [
      {
        ...attemptBase(1, "investigate"),
        files: ["src/checkout/cart.ts"],
        note: "Reproduced it and found the cause.",
        externalRef: "seed-106-investigate",
      },
      {
        ...attemptBase(2, "fix"),
        files: ["src/checkout/cart.ts", "src/checkout/cart.test.ts"],
        note: "The fix is in the pull request.",
        branch: "factory/fix-106",
        reviewer: {
          verdict: "approve",
          summary: "The guard is right and tested.",
          headSha: WORK_HEAD_SHA,
        },
        externalRef: "seed-106-fix-1",
      },
    ],
    mergeApproval: {
      id: "00000000-0000-4000-8000-000000000501",
      status: "pending",
      headSha: WORK_HEAD_SHA,
      requestedAt: "2026-11-17T12:00:00.001Z",
      decidedBy: null,
      decidedAt: null,
      note: null,
    },
    events: [
      {
        id: "00000000-0000-4000-8000-000000000411",
        at: "2026-11-17T12:00:00.001Z",
        kind: "merge_approval_requested",
        fromState: null,
        toState: null,
        actorType: "system",
        actorId: "hq",
        reason: null,
        note: null,
        detail: { headSha: WORK_HEAD_SHA, pullRequestNumber: 106 },
        cycle: 1,
        summary: "Merge approval requested.",
      },
      {
        id: "00000000-0000-4000-8000-000000000412",
        at: "2026-11-17T12:00:00.000Z",
        kind: "transition",
        fromState: "triage",
        toState: "plan",
        actorType: "agent",
        actorId: "agent-key-1",
        reason: "investigation_started",
        note: null,
        detail: { via: "key" },
        cycle: 1,
        summary: "Moved from triage to plan (investigation started).",
      },
    ],
    actions: {
      canStop: true,
      canReopen: false,
      canRevert: false,
      canRetry: false,
      canRequestAttempt: false,
    },
    ...overrides,
  }
}

/** FAC-8: merged 241 minutes ago, 134 minutes left of its window, one recurrence bar. */
export function verifyingItemFixture(overrides: Partial<WorkItemDetail> = {}): WorkItemDetail {
  const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6c"
  const summary: WorkItemSummary = {
    ...summaryBase(8, WORK_IDS.verifying, "Webhook retries flood the queue"),
    state: "verify",
    card: { label: "watching", tone: "teal", detail: "verifier \u00b7 2h14m left" },
    attempts: { used: 1, limit: 3, running: false },
    pullRequest: {
      number: 108,
      url: "https://github.com/acme/web/pull/108",
      state: "merged",
      isDraft: false,
    },
    stateChangedAt: "2026-11-17T12:00:00.003Z",
  }
  return {
    ...detailBase(summary),
    pullRequest: {
      ...reviewPullRequest(108, sha),
      state: "merged",
      mergedAt: "2026-11-17T07:59:00.000Z",
      mergedBy: "founder-login",
    },
    signal: signalOf(8, summary.summary, 5),
    stages: stagesAt("verify"),
    contract: contractOf("passing"),
    attemptList: [
      { ...attemptBase(1, "investigate"), files: ["src/webhooks/queue.ts"] },
      { ...attemptBase(2, "fix"), branch: "factory/fix-108", files: ["src/webhooks/queue.ts"] },
    ],
    mergeApproval: {
      id: "00000000-0000-4000-8000-000000000502",
      status: "void",
      headSha: sha,
      requestedAt: "2026-11-17T12:00:00.001Z",
      decidedBy: null,
      decidedAt: null,
      note: null,
    },
    window: {
      status: "running",
      startsAt: "2026-11-17T08:14:00.000Z",
      endsAt: "2026-11-17T14:14:00.000Z",
      remainingMinutes: 134,
      mergedAt: "2026-11-17T07:59:00.000Z",
      pastEnd: false,
      waitingOn: [],
      buckets: [
        { at: "2026-11-17T06:29:00.000Z", count: 1 },
        { at: "2026-11-17T06:59:00.000Z", count: 2 },
        { at: "2026-11-17T07:29:00.000Z", count: 1 },
        { at: "2026-11-17T07:59:00.000Z", count: 0 },
      ],
    },
    actions: {
      canStop: true,
      canReopen: true,
      canRevert: true,
      canRetry: false,
      canRequestAttempt: false,
    },
    ...overrides,
  }
}

/** FAC-2: still in triage, the agent asked a question and waits. */
export function askingItemFixture(overrides: Partial<WorkItemDetail> = {}): WorkItemDetail {
  const summary: WorkItemSummary = {
    ...summaryBase(2, WORK_IDS.asking, "Invoices are rounded the wrong way"),
    card: { label: "asking you", tone: "amber", detail: "waits for your answer" },
    attention: "agent_question",
    waitingSince: WORK_NOW,
    stateChangedAt: "2026-11-17T12:00:00.001Z",
  }
  return {
    ...detailBase(summary),
    questions: [questionFixture()],
    ...overrides,
  }
}

/** FAC-5: three fix attempts failed of three; waits for a founder to grant one more. */
export function exhaustedItemFixture(overrides: Partial<WorkItemDetail> = {}): WorkItemDetail {
  const summary: WorkItemSummary = {
    ...summaryBase(5, WORK_IDS.exhausted, "Export times out on large workspaces"),
    state: "attempt",
    card: { label: "needs you", tone: "amber", detail: "attempt 3 of 3" },
    attention: "attempt_budget",
    waitingSince: WORK_NOW,
    attempts: { used: 3, limit: 3, running: false },
  }
  const failed = (n: number): AttemptView => ({
    ...attemptBase(n, "fix"),
    result: "failed",
    note: `Attempt ${n - 1}: the export still timed out after the change.`,
  })
  return {
    ...detailBase(summary),
    stages: stagesAt("attempt"),
    contract: contractOf("pending"),
    attemptList: [
      { ...attemptBase(1, "investigate"), files: ["src/export/run.ts"] },
      failed(2),
      failed(3),
      failed(4),
    ],
    actions: {
      canStop: true,
      canReopen: false,
      canRevert: false,
      canRetry: true,
      canRequestAttempt: false,
    },
    ...overrides,
  }
}

/** FAC-1: a signal waiting in triage with nothing started. */
export function triageItemFixture(overrides: Partial<WorkItemDetail> = {}): WorkItemDetail {
  return {
    ...detailBase({ ...summaryBase(1, WORK_IDS.triage, "Checkout shows a blank page") }),
    ...overrides,
  }
}

/** FAC-10: merged, verified and done. */
export function doneItemFixture(overrides: Partial<WorkItemDetail> = {}): WorkItemDetail {
  const summary: WorkItemSummary = {
    ...summaryBase(10, WORK_IDS.done, "Avatar upload rejects large PNGs"),
    state: "done",
    card: { label: "verified", tone: "teal", detail: "window passed \u00b7 reviewer, ci" },
    attempts: { used: 1, limit: 3, running: false },
    pullRequest: {
      number: 110,
      url: "https://github.com/acme/web/pull/110",
      state: "merged",
      isDraft: false,
    },
    stateChangedAt: "2026-11-17T12:00:00.005Z",
  }
  return {
    ...detailBase(summary),
    pullRequest: {
      ...reviewPullRequest(110, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6e"),
      state: "merged",
      mergedAt: "2026-11-17T05:00:00.000Z",
      mergedBy: "founder-login",
    },
    stages: stagesAt(null),
    contract: contractOf("passing"),
    attemptList: [
      { ...attemptBase(1, "investigate"), files: ["src/profile/avatar.ts"] },
      { ...attemptBase(2, "fix"), branch: "factory/fix-110", files: ["src/profile/avatar.ts"] },
    ],
    mergeApproval: {
      id: "00000000-0000-4000-8000-000000000503",
      status: "void",
      headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6e",
      requestedAt: "2026-11-17T12:00:00.001Z",
      decidedBy: null,
      decidedAt: null,
      note: null,
    },
    window: {
      status: "passed",
      startsAt: "2026-11-17T05:15:00.000Z",
      endsAt: "2026-11-17T11:15:00.000Z",
      remainingMinutes: null,
      mergedAt: "2026-11-17T05:00:00.000Z",
      pastEnd: false,
      waitingOn: [],
      buckets: [
        { at: "2026-11-17T05:00:00.000Z", count: 0 },
        { at: "2026-11-17T05:30:00.000Z", count: 0 },
      ],
    },
    actions: {
      canStop: false,
      canReopen: true,
      canRevert: true,
      canRetry: false,
      canRequestAttempt: false,
    },
    ...overrides,
  }
}

/** FAC-2's question, open, with the agent's recommendation. */
export function questionFixture(overrides: Partial<QuestionView> = {}): QuestionView {
  return {
    id: WORK_IDS.question,
    attemptId: null,
    prompt: "Round half up, or half to even as the ledger does?",
    options: [
      { id: "up", label: "Half up", detail: "What customers expect on a receipt." },
      { id: "even", label: "Half to even", detail: "What the ledger already does." },
    ],
    defaultOptionId: "up",
    status: "open",
    answeredOptionId: null,
    answeredBy: null,
    answeredAt: null,
    createdAt: WORK_NOW,
    ...overrides,
  }
}

/** One card of the board's Needs you list, per kind, as hq builds it. */
export function needsYouFixture(
  kind: NeedsYou["kind"],
  overrides: Partial<NeedsYou> = {},
): NeedsYou {
  const base = { kind, since: WORK_NOW }
  switch (kind) {
    case "merge_approval":
      return {
        ...base,
        itemId: WORK_IDS.review,
        displayId: "FAC-6",
        title: "Empty cart crashes the checkout",
        // Not written as one literal: web-sources.test.ts reads a hash plus digits as a colour.
        reason: `Merge approval waits for a founder: pull request #${REVIEW_PR} at aaaaaaa.`,
        since: "2026-11-17T12:00:00.001Z",
        merge: {
          pullRequestUrl: "https://github.com/acme/web/pull/106",
          headSha: WORK_HEAD_SHA,
          number: 106,
          isDraft: false,
        },
        ...overrides,
      }
    case "agent_question":
      return {
        ...base,
        itemId: WORK_IDS.asking,
        displayId: "FAC-2",
        title: "Invoices are rounded the wrong way",
        reason: "The agent asked a question and waits for your answer.",
        question: {
          questionId: WORK_IDS.question,
          prompt: questionFixture().prompt,
          options: questionFixture().options,
          defaultOptionId: "up",
        },
        ...overrides,
      }
    case "attempt_budget":
      return {
        ...base,
        itemId: WORK_IDS.exhausted,
        displayId: "FAC-5",
        title: "Export times out on large workspaces",
        reason: "Used 3 of 3 fix attempts this cycle; the newest failed.",
        ...overrides,
      }
    case "stuck_attempt":
      return {
        ...base,
        itemId: WORK_IDS.building,
        displayId: "FAC-4",
        title: "Search ignores accents",
        // hq's words (work-board.ts), and the instant the attempt's lease ran out
        reason: "Attempt 2 has not reported since its lease ran out.",
        ...overrides,
      }
  }
}

const summaryOf = (detail: WorkItemDetail): WorkItemSummary => {
  const {
    signal: _signal,
    stages: _stages,
    contract: _contract,
    attemptList: _attemptList,
    questions: _questions,
    mergeApproval: _mergeApproval,
    window: _window,
    founderNotes: _founderNotes,
    events: _events,
    truncated: _truncated,
    actions: _actions,
    pullRequest,
    ...summary
  } = detail
  return {
    ...summary,
    pullRequest: pullRequest
      ? {
          number: pullRequest.number,
          url: pullRequest.url,
          state: pullRequest.state,
          isDraft: pullRequest.isDraft,
        }
      : null,
  }
}

/** The six items of the default board, by id: what `FakeHqState.workItems` starts as. */
export function workItemsFixture(): Record<string, WorkItemDetail> {
  return Object.fromEntries(
    [
      triageItemFixture(),
      askingItemFixture(),
      exhaustedItemFixture(),
      workItemFixture(),
      verifyingItemFixture(),
      doneItemFixture(),
    ].map((item) => [item.id, item]),
  )
}

/**
 * The board of those six items: one or two cards per column, three things waiting for a founder
 * (a question, an exhausted item, a merge approval), as hq sorts them (oldest first).
 */
export function workBoardFixture(overrides: Partial<WorkBoard> = {}): WorkBoard {
  const items = workItemsFixture()
  const card = (id: string) => summaryOf(items[id] as WorkItemDetail)
  return {
    now: WORK_NOW,
    repos: [WORK_REPO],
    dispatch: "label",
    columns: [
      {
        key: "triage",
        label: "Triage",
        count: 2,
        items: [card(WORK_IDS.asking), card(WORK_IDS.triage)],
      },
      { key: "fixing", label: "Fixing", count: 1, items: [card(WORK_IDS.exhausted)] },
      { key: "in_review", label: "In review", count: 1, items: [card(WORK_IDS.review)] },
      { key: "verifying", label: "Verifying", count: 1, items: [card(WORK_IDS.verifying)] },
      { key: "done_today", label: "Done today", count: 1, items: [card(WORK_IDS.done)] },
    ],
    stats: {
      inFlight: 5,
      runningAttempts: 0,
      needsYou: 3,
      oldestWaitingMinutes: 0,
      resolvedToday: 2,
      verifiedToday: 1,
      watching: 1,
      reopened: 0,
      latestReopened: null,
    },
    needsYou: [
      needsYouFixture("agent_question"),
      needsYouFixture("attempt_budget"),
      needsYouFixture("merge_approval"),
    ],
    ...overrides,
  }
}

/**
 * `get_digest`'s `pipeline` for the board scripts/seed-work.mjs makes, read on the seed's own day:
 * ten items opened, one verified, one reopened, three waiting on a founder (the board's three
 * cards), four pull requests merged, one for each word the digest has for one. The contract test
 * compares it with a real hq on everything a seed fixes (times and uuids aside).
 */
export function digestPipelineFixture(overrides: Partial<DigestPipeline> = {}): DigestPipeline {
  const needs = (kind: NeedsYou["kind"]) => {
    const { itemId, displayId, title, reason, since } = needsYouFixture(kind)
    return { kind, itemId, displayId, title, reason, since }
  }
  const event = (
    minute: number,
    displayId: string,
    text: string,
    result: DigestPipeline["events"][number]["result"],
  ) => ({ at: `2026-11-17T11:${String(minute).padStart(2, "0")}:00.000Z`, displayId, text, result })
  const merged = (
    at: string,
    displayId: string,
    title: string,
    pr: number,
    state: DigestPipeline["merged"][number]["state"],
  ) => ({
    at,
    displayId,
    title,
    pullRequestUrl: `https://github.com/${WORK_REPO}/pull/${pr}`,
    repo: WORK_REPO,
    number: pr,
    state,
  })
  const titles: [string, string][] = [
    ["FAC-1", "Checkout shows a blank page"],
    ["FAC-2", "Invoices are rounded the wrong way"],
    ["FAC-3", "Password reset mail arrives twice"],
    ["FAC-4", "Search ignores accents"],
    ["FAC-5", "Export times out on large workspaces"],
    ["FAC-6", "Empty cart crashes the checkout"],
    ["FAC-7", "Sign-in link opens the wrong page"],
    ["FAC-8", "Webhook retries flood the queue"],
    ["FAC-9", "Dashboard totals drift after a refund"],
    ["FAC-10", "Avatar upload rejects large PNGs"],
  ]
  const title = (id: string) => titles.find(([d]) => d === id)?.[1] ?? id
  return {
    opened: 10,
    resolved: 1,
    reopened: 1,
    stuckAttempts: 0,
    needsYou: [needs("agent_question"), needs("attempt_budget"), needs("merge_approval")],
    needsYouTotal: 3,
    merged: [
      merged("2026-11-17T11:55:00.000Z", "FAC-7", title("FAC-7"), 107, "merged"),
      merged("2026-11-17T08:40:00.000Z", "FAC-9", title("FAC-9"), 109, "reopened"),
      merged("2026-11-17T07:59:00.000Z", "FAC-8", title("FAC-8"), 108, "verifying"),
      merged("2026-11-17T05:00:00.000Z", "FAC-10", title("FAC-10"), 110, "verified"),
    ],
    events: [
      event(59, "FAC-10", title("FAC-10"), "verified"),
      ...(["FAC-9", "FAC-8", "FAC-10", "FAC-7"] as const).map((id, i) =>
        event(58 - i, id, title(id), "merged"),
      ),
      event(50, "FAC-9", title("FAC-9"), "reopened"),
      ...titles.map(([id, text], i) => event(40 - i, id, text, "opened")),
    ],
    ...overrides,
  }
}
