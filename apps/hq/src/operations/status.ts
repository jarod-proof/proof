import { z } from "zod"

import { factoryStatus } from "../data/status"
import { RUN_OUTCOMES, RUNNERS } from "../db/schema"
import { defineOperation, type HqDeps, isoDate } from "./shared"
import { allowanceOutput, toAllowanceReply } from "./spend"

export function statusOperations({ db, now }: HqDeps) {
  const get_factory_status = defineOperation({
    name: "get_factory_status",
    method: "GET",
    path: "/v1/factory/status",
    summary: "The factory at a glance: pending proposals, each runner's last run, today's cap",
    description:
      "Returns hq's clock, how many proposals wait for a founder, each runner's newest run " +
      "(eve, sandbox and box, always all three: when it started and how it ended) and today's " +
      "Eve spend allowance, as get_spend_allowance reports it, and work: how many work items are " +
      "in flight, wait for a founder, have a merge approval pending or an open question (null " +
      "before the work tables exist). hq has no runner heartbeat or " +
      "slots, so nothing here says a runner is online, busy or stuck. A box run never reports " +
      "an end: its lastOutcome is always null.",
    permissions: { hq_run: ["read"], hq_proposal: ["read"], hq_spend: ["read"] },
    input: z.object({}),
    output: z.object({
      now: isoDate.describe("hq's clock"),
      pendingProposals: z.number().int().describe("Every pending proposal, whenever proposed"),
      runners: z
        .array(
          z.object({
            runner: z.enum(RUNNERS),
            lastStartedAt: isoDate.nullable().describe("When the newest run started"),
            lastOutcome: z
              .enum(RUN_OUTCOMES)
              .nullable()
              .describe("How the newest run ended; null while open, and always for box"),
          }),
        )
        .describe("eve, sandbox and box, in that order"),
      allowance: allowanceOutput,
      work: z
        .object({
          inFlight: z.number().int().describe("Work items between signal and verify"),
          needsYou: z.number().int().describe("Work items that wait for a founder"),
          pendingMergeApprovals: z.number().int(),
          openQuestions: z.number().int().describe("Questions from the agent nobody answered"),
        })
        .nullable()
        .describe("The work pipeline's counts; null when hq's work tables do not exist yet"),
    }),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: {} }],
    handler: async () => {
      const at = now()
      const status = await factoryStatus(db, at)
      return {
        now: at.toISOString(),
        pendingProposals: status.pendingProposals,
        runners: status.runners.map((r) => ({
          runner: r.runner,
          lastStartedAt: r.lastStartedAt?.toISOString() ?? null,
          lastOutcome: r.lastOutcome,
        })),
        allowance: toAllowanceReply(status.allowance),
        work: status.work,
      }
    },
  })

  return [get_factory_status] as const
}
