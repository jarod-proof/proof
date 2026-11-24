import { AppError } from "@proof/errors"
import { z } from "zod"

import {
  MAX_GRANT_REQUEST_USD,
  MAX_GRANT_REQUESTS_PER_DAY,
  requestSpendGrant,
} from "../data/grant-requests"
import { DAILY_CAP, toPositiveUnits, toUnits, unitsToUsd } from "../data/money"
import {
  type Allowance,
  grantSpend,
  previousDay,
  readAllowance,
  recordSpend,
  reserveSpend,
  settleSpend,
  spendOnDay,
} from "../data/spend"
import { SPEND_SOURCES } from "../db/schema"
import { authorOf, defineOperation, type HqDeps, requireFounder } from "./shared"

/** One call's amount, in dollars: a realistic ceiling (grant_spend's), well under a column's. */
const usd = z.number().min(0).max(1000)
const model = z.string().trim().min(1).max(200)
const runId = z.string().max(200).optional().describe("The run this belongs to (from record_run)")

/** The allowance as get_spend_allowance and get_factory_status report it, in dollars. */
export const allowanceOutput = z.object({
  day: z.string().describe("The UTC day, YYYY-MM-DD"),
  spentUsd: z.number(),
  reservedUsd: z.number(),
  capUsd: z.number(),
  grantedUsd: z.number(),
  remainingUsd: z.number().describe("Never below 0"),
})

export const toAllowanceReply = (a: Allowance): z.infer<typeof allowanceOutput> => ({
  day: a.day,
  spentUsd: unitsToUsd(a.spent),
  reservedUsd: unitsToUsd(a.reserved),
  capUsd: unitsToUsd(DAILY_CAP),
  grantedUsd: unitsToUsd(a.granted),
  remainingUsd: unitsToUsd(Math.max(0, a.remaining)),
})

export function spendOperations(deps: HqDeps) {
  const { db, now } = deps

  const reserve_spend = defineOperation({
    name: "reserve_spend",
    method: "POST",
    path: "/v1/spend/reservations",
    summary: "Reserve a turn's estimated cost against today's $10 cap",
    description:
      "Call before every Eve chat turn or schedule, before any model call. The day is UTC and " +
      "the cap is $10.00 plus any grants. hq takes the estimate in one transaction: you get a " +
      "holdId, or { refused: true, remainingUsd } and must not call the model. Settle the hold " +
      "with settle_spend when the turn ends. A hold nobody settles still counts at its estimate. " +
      "Builds and box runs are outside the cap: record them with record_spend instead.",
    permissions: { hq_spend: ["record"] },
    input: z.object({
      source: z.literal("eve"),
      estimateUsd: usd.describe("What the turn is expected to cost, in dollars; more than 0"),
      runId,
    }),
    output: z.union([
      z.object({ holdId: z.string() }),
      z.object({ refused: z.literal(true), remainingUsd: z.number() }),
    ]),
    hints: { readOnly: false, destructive: false },
    examples: [{ input: { source: "eve", estimateUsd: 0.05 } }],
    handler: async (input) => {
      const result = await reserveSpend(db, {
        estimate: toPositiveUnits(input.estimateUsd, "estimateUsd"),
        runId: input.runId,
        now: now(),
      })
      return "holdId" in result
        ? { holdId: result.holdId }
        : { refused: true as const, remainingUsd: unitsToUsd(result.remaining) }
    },
  })

  const settle_spend = defineOperation({
    name: "settle_spend",
    method: "POST",
    path: "/v1/spend/holds/:holdId/settlement",
    summary: "Settle a reservation with the turn's real cost",
    description:
      "Closes a hold and records what the turn cost. When the provider reported no cost, leave " +
      "amountUsd out: the hold's estimate stands, marked estimated. A hold settles once: a second " +
      "settle is a CONFLICT and records nothing.",
    permissions: { hq_spend: ["record"] },
    input: z.object({ holdId: z.string(), amountUsd: usd.optional(), model }),
    output: z.object({ amountUsd: z.number(), estimated: z.boolean() }),
    hints: { readOnly: false, destructive: false },
    examples: [
      {
        input: { holdId: "00000000-0000-0000-0000-000000000000", model: "haiku" },
        error: "NOT_FOUND",
      },
    ],
    handler: async (input) => {
      const row = await settleSpend(db, {
        holdId: input.holdId,
        amount: input.amountUsd === undefined ? undefined : toUnits(input.amountUsd, "amountUsd"),
        model: input.model,
        now: now(),
      })
      return { amountUsd: unitsToUsd(row.amount), estimated: row.estimated }
    },
  })

  const record_spend = defineOperation({
    name: "record_spend",
    method: "POST",
    path: "/v1/spend",
    summary: "Record spend: a build, a box run, or Eve spend without a hold",
    description:
      "Records one model charge. Builds and box runs (source build, box) are outside the daily " +
      "cap but must always record their cost. Send amountUsd when the provider reported it; when " +
      "it did not, send estimatedUsd and the row is stored estimated. Eve chat and schedules " +
      "should reserve_spend and settle_spend instead.",
    permissions: { hq_spend: ["record"] },
    input: z.object({
      runId,
      source: z.enum(SPEND_SOURCES),
      amountUsd: usd.optional().describe("The cost the provider reported"),
      estimatedUsd: usd.optional().describe("Stored, marked estimated, when amountUsd is absent"),
      model,
    }),
    output: z.object({ id: z.string(), amountUsd: z.number(), estimated: z.boolean() }),
    hints: { readOnly: false, destructive: false },
    examples: [{ input: { source: "box", amountUsd: 0.42, model: "opus" } }],
    handler: async (input) => {
      const row = await recordSpend(db, {
        runId: input.runId,
        source: input.source,
        amount: input.amountUsd === undefined ? undefined : toUnits(input.amountUsd, "amountUsd"),
        estimate:
          input.estimatedUsd === undefined
            ? undefined
            : toUnits(input.estimatedUsd, "estimatedUsd"),
        model: input.model,
        now: now(),
      })
      return { id: row.id, amountUsd: unitsToUsd(row.amount), estimated: row.estimated }
    },
  })

  const get_spend_allowance = defineOperation({
    name: "get_spend_allowance",
    method: "GET",
    path: "/v1/spend/allowance",
    summary: "What is left of today's Eve spend cap",
    description:
      "Returns today's (UTC) cap position for Eve chat and schedules: spent (settled spend plus " +
      "holds nobody settled in 15 minutes), reserved (turns in flight), grants and remaining. " +
      "Reserving is what enforces the cap; this only reports it.",
    permissions: { hq_spend: ["read"] },
    input: z.object({ source: z.literal("eve").default("eve") }),
    output: allowanceOutput,
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: {} }],
    handler: async () => toAllowanceReply(await readAllowance(db, now())),
  })

  const get_spend_summary = defineOperation({
    name: "get_spend_summary",
    method: "GET",
    path: "/v1/spend/summary",
    summary: "What one UTC day spent, by source",
    description:
      "Returns the ledger's spend for one UTC day, total and by source (eve, build, box), and how " +
      "much of it is an estimate. Leave day out for yesterday as hq counts it: hq's clock decides " +
      "which day that is, never the caller's. A day with no spend reports 0 and no sources.",
    permissions: { hq_spend: ["read"] },
    input: z.object({
      day: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
        .optional()
        .describe("A UTC day, YYYY-MM-DD; default yesterday"),
    }),
    output: z.object({
      day: z.string().describe("The UTC day, YYYY-MM-DD"),
      totalUsd: z.number(),
      estimatedUsd: z.number(),
      bySource: z.array(z.object({ source: z.enum(SPEND_SOURCES), amountUsd: z.number() })),
    }),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: {} }],
    handler: async (input) => {
      const day = input.day ?? previousDay(now())
      if (Number.isNaN(new Date(`${day}T00:00:00Z`).getTime())) {
        throw new AppError("BAD_REQUEST", "day must be a real date, YYYY-MM-DD")
      }
      const summary = await spendOnDay(db, day)
      return {
        day: summary.day,
        totalUsd: unitsToUsd(summary.total),
        estimatedUsd: unitsToUsd(summary.estimated),
        bySource: summary.bySource.map((r) => ({
          source: r.source,
          amountUsd: unitsToUsd(r.amount),
        })),
      }
    },
  })

  const grant_spend = defineOperation({
    name: "grant_spend",
    method: "POST",
    path: "/v1/spend/grants",
    summary: "Raise today's Eve spend allowance (a founder's decision)",
    description:
      "A founder adds to today's allowance, with a reason. Only a signed-in founder can: API keys " +
      "and OAuth tokens get FORBIDDEN, so never call it on your own judgement. Ask a founder.",
    permissions: { hq_spend: ["grant"] },
    input: z.object({
      amountUsd: z.number().gt(0).max(1000),
      reason: z.string().trim().min(1).max(2000),
    }),
    output: z.object({ id: z.string(), day: z.string(), grantedUsd: z.number() }),
    hints: { readOnly: false, destructive: false },
    examples: [{ input: { amountUsd: 5, reason: "Launch day" }, error: "FORBIDDEN" }],
    handler: async (input, { caller }) => {
      const grantedBy = await requireFounder(deps, caller)
      const amount = toPositiveUnits(input.amountUsd, "amountUsd")
      const row = await grantSpend(db, { amount, reason: input.reason, grantedBy, now: now() })
      return { ...row, grantedUsd: unitsToUsd(amount) }
    },
  })

  const request_spend_grant = defineOperation({
    name: "request_spend_grant",
    method: "POST",
    path: "/v1/spend/grant-requests",
    summary: "Ask a founder to raise today's Eve spend allowance",
    description:
      `Records a pending request for up to $${MAX_GRANT_REQUEST_USD} and returns its requestId. ` +
      "It grants nothing: put the requestId on a Slack grant card, and only a founder's click on " +
      "that card redeems it, once, within 24 hours, for exactly this amount. hq takes at most " +
      `${MAX_GRANT_REQUESTS_PER_DAY} requests a UTC day.`,
    permissions: { hq_spend: ["request"] },
    input: z.object({
      amountUsd: z.number().gt(0).max(MAX_GRANT_REQUEST_USD),
      reason: z.string().trim().min(1).max(2000).describe("Why the allowance is needed"),
      runId,
    }),
    output: z.object({
      requestId: z.string(),
      amountUsd: z.number(),
      expiresAt: z.string().describe("ISO 8601 time the request stops being redeemable"),
    }),
    hints: { readOnly: false, destructive: false },
    examples: [{ input: { amountUsd: 5, reason: "A hard pricing question" } }],
    handler: async (input, { caller }) => {
      const amount = toPositiveUnits(input.amountUsd, "amountUsd")
      const request = await requestSpendGrant(db, {
        amount,
        reason: input.reason,
        runId: input.runId,
        requestedBy: authorOf(caller).id,
        now: now(),
      })
      return {
        requestId: request.id,
        amountUsd: unitsToUsd(request.amount),
        expiresAt: request.expiresAt.toISOString(),
      }
    },
  })

  return [
    reserve_spend,
    settle_spend,
    record_spend,
    get_spend_allowance,
    get_spend_summary,
    request_spend_grant,
    grant_spend,
  ] as const
}
