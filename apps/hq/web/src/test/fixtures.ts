import type { Digest, FactoryStatus, Policy, Proposal } from "../api/schemas"

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
    ...overrides,
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
