import { AppError } from "@proof/errors"
import { z } from "zod"

import { readDigest } from "../data/digest"
import { unitsToUsd } from "../data/money"
import { previousDay } from "../data/spend"
import { SPEND_SOURCES } from "../db/schema"
import { defineOperation, entryKind, type HqDeps, isoDate } from "./shared"

const HOUR_MS = 3_600_000
/** The longest window the digest reads. */
const MAX_WINDOW_MS = 7 * 24 * HOUR_MS

const result = z.enum([
  "started",
  "succeeded",
  "failed",
  "stopped",
  "proposed",
  "approved",
  "rejected",
])

export function digestOperations(deps: HqDeps) {
  const { db, now } = deps

  const get_digest = defineOperation({
    name: "get_digest",
    method: "GET",
    path: "/v1/digest",
    summary: "What the factory did since a time: runs, proposals, spend and health",
    description:
      "Returns a window of hq's own records: runs finished and failed, pending proposals to " +
      "decide, a newest-first list of events (a run once, a proposal once per state change), the " +
      "window's spend by source, and how many runs look stuck. Leave since out for the start of " +
      "yesterday (UTC), as the nightly digest counts it. A since older than 7 days is moved up " +
      "to 7 days before now; a since in the future is BAD_REQUEST. The window is [since, until), " +
      "and until is hq's clock. Box runs are never counted as finished, failed or stuck: they do " +
      "not report an end. Product health and deploys are not connected.",
    permissions: { hq_run: ["read"], hq_proposal: ["read"], hq_spend: ["read"] },
    input: z.object({
      since: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe("ISO 8601 start of the window; default the start of yesterday (UTC)"),
    }),
    output: z.object({
      since: isoDate,
      until: isoDate,
      hours: z.number().int().describe("The window's length, rounded to whole hours"),
      summary: z.object({
        tone: z.enum(["quiet", "attention"]).describe("attention when a run failed or is stuck"),
        runsFinished: z.number().int().describe("Eve and sandbox runs that ended in the window"),
        runsFailed: z.number().int(),
        pendingProposals: z.number().int().describe("Every pending proposal, whenever proposed"),
      }),
      decisions: z
        .array(
          z.object({
            proposalId: z.string(),
            entryKind,
            title: z.string(),
            reason: z.string(),
            createdAt: isoDate,
          }),
        )
        .describe("Pending proposals, oldest first, at most 5"),
      events: z
        .array(
          z.object({
            at: isoDate,
            kind: z.enum(["run", "proposal"]),
            ref: z.string().describe("The run id or the proposal id"),
            text: z.string(),
            result,
            costUsd: z.number().nullable().describe("A run's cost; null for a proposal"),
          }),
        )
        .describe("Newest first, at most 30"),
      spend: z.object({
        totalUsd: z.number(),
        estimatedUsd: z.number(),
        bySource: z.array(z.object({ source: z.enum(SPEND_SOURCES), amountUsd: z.number() })),
      }),
      health: z.object({
        stuckRuns: z.number().int().describe("Eve and sandbox runs open for over 60 minutes"),
        lastRunStartedAt: isoDate.nullable(),
      }),
      productHealth: z.object({ connected: z.literal(false) }),
      deploys: z.object({ connected: z.literal(false) }),
    }),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: {} }],
    handler: async (input) => {
      const until = now()
      const requested = input.since
        ? new Date(input.since)
        : new Date(`${previousDay(until)}T00:00:00Z`)
      if (requested.getTime() > until.getTime()) {
        throw new AppError("BAD_REQUEST", "since is in the future")
      }
      const since = new Date(Math.max(requested.getTime(), until.getTime() - MAX_WINDOW_MS))
      const digest = await readDigest(db, { since, until })
      const { summary, health } = digest
      return {
        since: since.toISOString(),
        until: until.toISOString(),
        hours: Math.round((until.getTime() - since.getTime()) / HOUR_MS),
        summary: {
          tone:
            summary.runsFailed === 0 && health.stuckRuns === 0
              ? ("quiet" as const)
              : ("attention" as const),
          ...summary,
        },
        decisions: digest.decisions.map((d) => ({ ...d, createdAt: d.createdAt.toISOString() })),
        events: digest.events.map((e) => ({
          at: e.at.toISOString(),
          kind: e.kind,
          ref: e.ref,
          text: e.text,
          result: e.result,
          costUsd: e.cost === null ? null : unitsToUsd(e.cost),
        })),
        spend: {
          totalUsd: unitsToUsd(digest.spend.total),
          estimatedUsd: unitsToUsd(digest.spend.estimated),
          bySource: digest.spend.bySource.map((r) => ({
            source: r.source,
            amountUsd: unitsToUsd(r.amount),
          })),
        },
        health: {
          stuckRuns: health.stuckRuns,
          lastRunStartedAt: health.lastRunStartedAt?.toISOString() ?? null,
        },
        productHealth: { connected: false as const },
        deploys: { connected: false as const },
      }
    },
  })

  return [get_digest] as const
}
