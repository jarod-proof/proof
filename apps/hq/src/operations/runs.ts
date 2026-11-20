import { decodeCursor, encodeCursor } from "@proof/api"
import { AppError } from "@proof/errors"
import { z } from "zod"

import { unitsToUsd } from "../data/money"
import { finishRun, listRuns, type RunRow, recordRun } from "../data/runs"
import { RUN_OUTCOMES, RUNNERS } from "../db/schema"
import { defineOperation, type HqDeps, isoDate } from "./shared"

const run = z.object({
  id: z.string(),
  task: z.string(),
  trigger: z.string(),
  runner: z.enum(RUNNERS),
  startedAt: isoDate,
  endedAt: isoDate.nullable(),
  outcome: z.enum(RUN_OUTCOMES).nullable(),
  link: z.string().nullable(),
  summary: z
    .object({ worked: z.array(z.string()), failed: z.array(z.string()), stop: z.array(z.string()) })
    .nullable(),
  costUsd: z.number().describe("The sum of the run's spend rows, in dollars"),
  costEstimated: z.boolean().describe("True when any of that cost is an estimate"),
})

const toRun = (r: RunRow) => ({
  id: r.id,
  task: r.task,
  trigger: r.trigger,
  runner: r.runner,
  startedAt: r.startedAt.toISOString(),
  endedAt: r.endedAt?.toISOString() ?? null,
  outcome: r.outcome,
  link: r.link,
  summary: r.summary,
  costUsd: unitsToUsd(r.cost),
  costEstimated: r.costEstimated,
})

const pageCursor = z.object({ at: z.string(), id: z.string() })

function readPageCursor(cursor: string | undefined) {
  if (cursor === undefined || cursor === "") return undefined
  const parsed = pageCursor.safeParse(decodeCursor(cursor))
  const at = parsed.success ? new Date(parsed.data.at) : null
  if (!parsed.success || !at || Number.isNaN(at.getTime())) {
    throw new AppError("BAD_REQUEST", "Invalid cursor", {
      hint: "Pass nextCursor from the previous page unchanged, or omit cursor to start from the first page.",
    })
  }
  return { at, id: parsed.data.id }
}

const stringList = z.array(z.string().trim().min(1).max(500)).max(50)

export function runOperations({ db, now }: HqDeps) {
  const record_run = defineOperation({
    name: "record_run",
    method: "POST",
    path: "/v1/runs",
    summary: "Record that a run started",
    description:
      "Call when a chat turn, schedule, build or review begins. Returns the run's id: pass it as " +
      "runId to record_spend, reserve_spend and propose_entry so the run's cost and output are " +
      "linked, then call finish_run when it ends.",
    permissions: { hq_run: ["create"] },
    input: z.object({
      task: z.string().trim().min(1).max(500).describe("What the run is for"),
      trigger: z.string().trim().min(1).max(500).describe("What started it: a person, a schedule"),
      runner: z.enum(RUNNERS).describe("eve (chat, schedules), sandbox (builds) or box (reviews)"),
      link: z.string().trim().max(2000).optional().describe("A URL for the run"),
    }),
    output: z.object({ id: z.string() }),
    hints: { readOnly: false, destructive: false },
    examples: [{ input: { task: "nightly digest", trigger: "schedule", runner: "eve" } }],
    handler: (input) => recordRun(db, { ...input, now: now() }),
  })

  const finish_run = defineOperation({
    name: "finish_run",
    method: "POST",
    path: "/v1/runs/:id/finish",
    summary: "Record how a run ended",
    description:
      "Closes a run with its outcome and a summary of what worked, what failed and what made it " +
      "stop. A run ends once: finishing it again is a CONFLICT. Returns the run with its total " +
      "cost, the sum of its spend.",
    permissions: { hq_run: ["update"] },
    input: z.object({
      id: z.string(),
      outcome: z.enum(RUN_OUTCOMES),
      summary: z.object({ worked: stringList, failed: stringList, stop: stringList }),
    }),
    output: run,
    hints: { readOnly: false, destructive: false },
    examples: [
      {
        input: {
          id: "00000000-0000-0000-0000-000000000000",
          outcome: "succeeded",
          summary: { worked: [], failed: [], stop: [] },
        },
        error: "NOT_FOUND",
      },
    ],
    handler: async (input) => toRun(await finishRun(db, { ...input, now: now() })),
  })

  const list_runs = defineOperation({
    name: "list_runs",
    method: "GET",
    path: "/v1/runs",
    summary: "List runs, newest first, with their cost",
    description:
      "Returns runs with their outcome, summary and total cost (the sum of their spend), newest " +
      "first, one page at a time. Pass nextCursor back as cursor for the next page.",
    permissions: { hq_run: ["read"] },
    input: z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
    output: z.object({ runs: z.array(run), nextCursor: z.string().nullable() }),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: {} }],
    handler: async (input) => {
      const rows = await listRuns(db, {
        after: readPageCursor(input.cursor),
        limit: input.limit + 1,
      })
      const page = rows.slice(0, input.limit)
      const last = page.at(-1)
      const nextCursor =
        rows.length > input.limit && last
          ? encodeCursor({ at: last.startedAt.toISOString(), id: last.id })
          : null
      return { runs: page.map(toRun), nextCursor }
    },
  })

  return [record_run, finish_run, list_runs] as const
}
