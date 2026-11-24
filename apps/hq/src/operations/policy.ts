import { PERSON_ONLY_ACTIONS } from "@proof/auth"
import { z } from "zod"

import { countFounders } from "../data/founders"
import {
  DEFAULT_SLACK_DAILY_GRANT_CAP_USD,
  MAX_GRANT_REQUEST_USD,
  MAX_GRANT_REQUESTS_PER_DAY,
} from "../data/grant-requests"
import { DAILY_CAP, unitsToUsd } from "../data/money"
import { readAllowance, STALE_HOLD_MS } from "../data/spend"
import { defineOperation, type HqDeps } from "./shared"

export function policyOperations(deps: HqDeps) {
  const { db, now } = deps

  const get_policy = defineOperation({
    name: "get_policy",
    method: "GET",
    path: "/v1/policy",
    summary: "What hq enforces today: the spend limits and the person-only actions",
    description:
      "A read-only report of the limits hq enforces now, taken from the constants it enforces: " +
      "the Eve daily cap, the grant request limits, the Slack daily grant cap, how long a hold " +
      "may stand before it counts as spent, what was granted today (UTC), which hq actions only " +
      "a signed-in person can take, and how many founders there are. Nothing here can be set " +
      "through hq: changing a limit is a code change.",
    permissions: { hq_proposal: ["read"], hq_spend: ["read"] },
    input: z.object({}),
    output: z.object({
      spend: z.object({
        dailyCapUsd: z.number().describe("The Eve cap per UTC day, before grants"),
        maxGrantRequestUsd: z.number().describe("The most one grant request may ask for"),
        maxGrantRequestsPerDay: z.number().int(),
        staleHoldMinutes: z
          .number()
          .int()
          .describe("A hold nobody settled counts as spent after this long"),
        slackDailyGrantCapUsd: z.number().describe("What Slack clicks may grant in a UTC day"),
        grantedTodayUsd: z.number(),
      }),
      approvals: z.object({
        personOnly: z.array(z.object({ resource: z.string(), actions: z.array(z.string()) })),
      }),
      founders: z.number().int(),
    }),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: {} }],
    handler: async () => {
      const allowance = await readAllowance(db, now())
      return {
        spend: {
          dailyCapUsd: unitsToUsd(DAILY_CAP),
          maxGrantRequestUsd: MAX_GRANT_REQUEST_USD,
          maxGrantRequestsPerDay: MAX_GRANT_REQUESTS_PER_DAY,
          staleHoldMinutes: STALE_HOLD_MS / 60_000,
          slackDailyGrantCapUsd: deps.slackDailyGrantCapUsd ?? DEFAULT_SLACK_DAILY_GRANT_CAP_USD,
          grantedTodayUsd: unitsToUsd(allowance.granted),
        },
        approvals: {
          personOnly: Object.entries(PERSON_ONLY_ACTIONS)
            .filter(([resource]) => resource.startsWith("hq_"))
            .map(([resource, actions]) => ({ resource, actions: [...actions] })),
        },
        founders: await countFounders(db),
      }
    },
  })

  return [get_policy] as const
}
