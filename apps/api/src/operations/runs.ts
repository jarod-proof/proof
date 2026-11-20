import { paginated, paginationInput } from "@proof/api"
import type { OrgEventInput } from "@proof/auth"
import { AgentId, agentInOrg, name, RunId, runInOrg } from "@proof/auth-proofs"
import { AppError } from "@proof/errors"
import { z } from "zod"
import {
  appendRunStep,
  approvalView,
  deferRun,
  getRunBundle,
  listRuns,
  RUN_STATUSES,
  type Run,
  type RunStep,
  runNotice,
  STEP_STATUSES,
  startRun,
  steerRun,
  updateRun,
  updateRunStep,
} from "../data/runs"
import { inCallerOrg, orNotFound, requireInOrg } from "../tenant"
import {
  actorOf,
  actorType,
  agentRef,
  approvalOutputSchema,
  cut,
  defineOperation,
  notifySafely,
  type OperationDeps,
  readCursor,
  runRef,
  viewerOf,
} from "./shared"

const footprintOutput = z.object({
  energyWh: z.number().describe("Energy the run has used so far, estimated, in watt-hours"),
  tokens: z.number().int(),
  toolCalls: z.number().int(),
})

const runSummaryOutput = z.object({
  id: z.string(),
  agentId: z.string(),
  title: z.string(),
  status: z.enum(RUN_STATUSES),
  summary: z.string().nullable().describe("Markdown"),
  startedBy: z.object({ type: z.enum(["user", "apiKey"]), id: z.string() }).nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  deferredUntil: z.string().nullable().describe("Set while the run is deferred (status queued)"),
  durationMs: z.number().int().nullable().describe("Start to finish, or to now while it runs"),
  footprint: footprintOutput,
})

const runDetailFootprint = footprintOutput.extend({
  energyBudgetWh: z.number().nullable().describe("The agent's energy budget; null when unset"),
})

const stepInput = z.object({
  kind: z.string().trim().min(1).max(40).describe("Free-form category, e.g. collect, draft, test"),
  title: z.string().trim().min(1).max(200),
  detail: z.string().max(2000).nullable().optional(),
  status: z.enum(["queued", "running", "done", "failed"]).optional().describe("Defaults to queued"),
  progressDone: z
    .number()
    .int()
    .min(0)
    .nullable()
    .optional()
    .describe("With progressTotal: 38 of 61"),
  progressTotal: z.number().int().min(0).nullable().optional(),
})

const stepOutputSchema = z.object({
  id: z.string(),
  position: z.number().int(),
  kind: z.string(),
  title: z.string(),
  detail: z.string().nullable(),
  status: z.enum(STEP_STATUSES),
  progressDone: z.number().int().nullable(),
  progressTotal: z.number().int().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
})

const messageOutput = z.object({
  id: z.string(),
  body: z.string(),
  authorId: z.string(),
  createdAt: z.string(),
})

/** The notice for a run that finished: the starter hears it, or owners and admins when a key started it. */
const finishedEvent = (
  status: "done" | "failed",
  runId: string,
  facts: { agentName: string; starterUserId: string | null },
): OrgEventInput =>
  status === "done"
    ? { type: "run.done", agentName: facts.agentName, runId, runStarterUserId: facts.starterUserId }
    : {
        type: "run.failed",
        agentName: facts.agentName,
        runId,
        runStarterUserId: facts.starterUserId,
      }

const durationMs = (start: Date | null, end: Date | null, at: Date): number | null =>
  start ? (end ?? at).getTime() - start.getTime() : null

const runSummary = (r: Run, at: Date) => ({
  id: r.id,
  agentId: r.agentId,
  title: r.title,
  status: r.status as (typeof RUN_STATUSES)[number],
  summary: r.summary,
  startedBy:
    r.startedByType && r.startedById
      ? { type: actorType(r.startedByType), id: r.startedById }
      : null,
  createdAt: r.createdAt.toISOString(),
  startedAt: r.startedAt?.toISOString() ?? null,
  finishedAt: r.finishedAt?.toISOString() ?? null,
  deferredUntil: r.deferredUntil?.toISOString() ?? null,
  durationMs: durationMs(r.startedAt, r.finishedAt, at),
  footprint: { energyWh: r.energyWh, tokens: r.tokens, toolCalls: r.toolCalls },
})

const stepOutput = (s: RunStep, at: Date) => ({
  id: s.id,
  position: s.position,
  kind: s.kind,
  title: s.title,
  detail: s.detail,
  status: s.status as (typeof STEP_STATUSES)[number],
  progressDone: s.progressDone,
  progressTotal: s.progressTotal,
  startedAt: s.startedAt?.toISOString() ?? null,
  finishedAt: s.finishedAt?.toISOString() ?? null,
  durationMs: durationMs(s.startedAt, s.finishedAt, at),
})

const runDetailOutput = runSummaryOutput.extend({
  footprint: runDetailFootprint,
  steps: z.array(stepOutputSchema),
  approvals: z.array(approvalOutputSchema),
  messages: z.array(messageOutput),
})

export function runOperations({
  db,
  now,
  notifier,
}: Pick<OperationDeps, "db" | "now" | "notifier">) {
  const start_run = defineOperation({
    name: "start_run",
    method: "POST",
    path: "/v1/workspace-agents/:id/runs",
    summary: "Start a run of a workspace agent",
    description:
      "Queues a new run of a workspace agent with a title and an optional summary (Markdown). The run " +
      "starts as queued; the agent moves it to running with update_run, then adds steps with " +
      "append_run_step. Returns NOT_FOUND for agents outside this organization.",
    permissions: { run: ["create"] },
    hints: { readOnly: false, destructive: false },
    input: agentRef.extend({
      title: z.string().trim().min(1).max(200).describe("What the run is for"),
      summary: z.string().trim().max(2000).optional().describe("Markdown, optional"),
    }),
    output: runSummaryOutput,
    examples: [
      {
        input: { id: "00000000-0000-0000-0000-000000000000", title: "v2.8 triage" },
        error: "NOT_FOUND",
      },
    ],
    handler: ({ id, title, summary }, { caller }) =>
      inCallerOrg(caller, (org) =>
        name(AgentId(id), async (agentId) => {
          const inOrg = await requireInOrg(agentInOrg, db, agentId, org, "Agent")
          const row = await startRun(
            db,
            agentId,
            org,
            inOrg,
            { title, summary },
            actorOf(caller),
            now(),
          )
          return runSummary(row, now())
        }),
      ),
  })

  const list_runs = defineOperation({
    name: "list_runs",
    method: "GET",
    path: "/v1/runs",
    summary: "List runs, newest first",
    description:
      "Lists the organization's runs, newest first, one page at a time. Filter by agentId and by status " +
      "(queued, running, needs_you, done, failed). Pass nextCursor back as cursor for older runs; it is " +
      "null on the last page. Use an id with get_run for the steps, approvals and messages.",
    permissions: { run: ["read"] },
    input: paginationInput.extend({
      agentId: z.string().optional().describe("Only runs of this workspace agent"),
      status: z.enum(RUN_STATUSES).optional().describe("Only runs in this status"),
    }),
    output: paginated("runs", runSummaryOutput),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: {} }, { input: { status: "needs_you" } }],
    handler: (input, { caller }) =>
      inCallerOrg(caller, async (org, proof) => {
        const rows = await listRuns(db, org, proof, {
          after: readCursor(input.cursor),
          agentId: input.agentId,
          status: input.status,
          limit: input.limit + 1,
        })
        const { page, nextCursor } = cut(rows, input.limit, (r) => r.createdAt)
        const at = now()
        return { runs: page.map((r) => runSummary(r, at)), nextCursor }
      }),
  })

  const get_run = defineOperation({
    name: "get_run",
    method: "GET",
    path: "/v1/runs/:id",
    summary: "Get a run with its steps, approvals, messages and footprint",
    description:
      "Returns one run: status, summary, timing, footprint (energy against the agent's budget, tokens, tool " +
      "calls), its ordered steps, the approvals it asked for and the messages people sent it. An approval " +
      "shows as pending until its decision takes effect, 30 seconds after it was made; then it shows " +
      "approved or denied. Agents must wait for that before acting. Returns NOT_FOUND for runs outside " +
      "this organization.",
    permissions: { run: ["read"] },
    input: runRef,
    output: runDetailOutput,
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: { id: "00000000-0000-0000-0000-000000000000" }, error: "NOT_FOUND" }],
    handler: ({ id }, { caller }) =>
      inCallerOrg(caller, (org) =>
        name(RunId(id), async (runId) => {
          const inOrg = await requireInOrg(runInOrg, db, runId, org, "Run")
          const bundle = orNotFound(await getRunBundle(db, runId, org, inOrg), "Run")
          const at = now()
          const summary = runSummary(bundle.run, at)
          const viewer = viewerOf(caller)
          return {
            ...summary,
            footprint: { ...summary.footprint, energyBudgetWh: bundle.energyBudgetWh },
            steps: bundle.steps.map((s) => stepOutput(s, at)),
            approvals: bundle.approvals.map((a) => approvalView(a, at, viewer)),
            messages: bundle.messages.map((m) => ({
              id: m.id,
              body: m.body,
              authorId: m.authorId,
              createdAt: m.createdAt.toISOString(),
            })),
          }
        }),
      ),
  })

  const update_run = defineOperation({
    name: "update_run",
    method: "PATCH",
    path: "/v1/runs/:id",
    summary: "Report a run's status, summary and footprint (agent side)",
    description:
      "How an agent reports its run: set status to running, done or failed; set the summary (Markdown); " +
      "and report footprint totals so far (energyWh, tokens, toolCalls). Omitted fields stay. Refused with " +
      "CONFLICT while an approval still blocks the run: wait until get_run shows it approved or denied. " +
      "Finished runs take no more updates.",
    permissions: { run: ["update"] },
    hints: { readOnly: false, destructive: false },
    input: runRef.extend({
      status: z.enum(["running", "done", "failed"]).optional(),
      summary: z.string().max(20_000).nullable().optional(),
      energyWh: z.number().min(0).max(1_000_000).optional(),
      tokens: z.number().int().min(0).max(1_000_000_000).optional(),
      toolCalls: z.number().int().min(0).max(1_000_000).optional(),
    }),
    output: runSummaryOutput,
    examples: [
      {
        input: { id: "00000000-0000-0000-0000-000000000000", status: "running" },
        error: "NOT_FOUND",
      },
    ],
    handler: ({ id, ...patch }, { caller }) =>
      inCallerOrg(caller, (org, proof) =>
        name(RunId(id), async (runId) => {
          const inOrg = await requireInOrg(runInOrg, db, runId, org, "Run")
          const row = orNotFound(await updateRun(db, runId, org, inOrg, patch, now()), "Run")
          // updateRun refuses writes to a finished run, so a run reaches done or failed exactly once.
          if (row.status === "done" || row.status === "failed") {
            const finishedAs = row.status
            await notifySafely(async () => {
              const facts = await runNotice(db, row.id, org, proof)
              if (!facts) return
              await notifier.inOrg(org, proof, finishedEvent(finishedAs, row.id, facts))
            })
          }
          return runSummary(row, now())
        }),
      ),
  })

  const append_run_step = defineOperation({
    name: "append_run_step",
    method: "POST",
    path: "/v1/runs/:id/steps",
    summary: "Add a step to a run (agent side)",
    description:
      "Appends a step to a run, in order, so people see what the agent is doing: a kind (such as collect, " +
      "draft or test), a title, optional detail, and progress (progressDone of progressTotal). Status " +
      "defaults to queued. Change it later with update_run_step. Refused once the run has finished.",
    permissions: { run: ["update"] },
    hints: { readOnly: false, destructive: false },
    input: runRef.extend(stepInput.shape),
    output: stepOutputSchema,
    examples: [
      {
        input: {
          id: "00000000-0000-0000-0000-000000000000",
          kind: "collect",
          title: "Collect blockers",
        },
        error: "NOT_FOUND",
      },
    ],
    handler: ({ id, ...step }, { caller }) =>
      inCallerOrg(caller, (org) =>
        name(RunId(id), async (runId) => {
          const inOrg = await requireInOrg(runInOrg, db, runId, org, "Run")
          const row = orNotFound(await appendRunStep(db, runId, org, inOrg, step, now()), "Run")
          return stepOutput(row, now())
        }),
      ),
  })

  const update_run_step = defineOperation({
    name: "update_run_step",
    method: "PATCH",
    path: "/v1/runs/:id/steps/:stepId",
    summary: "Change one step of a run (agent side)",
    description:
      "Updates a step's status, title, detail or progress: move it to running, then to done or failed. " +
      "A step waiting for a person is set by request_approval, not here. Returns NOT_FOUND for steps " +
      "that aren't part of this run.",
    permissions: { run: ["update"] },
    hints: { readOnly: false, destructive: false },
    input: runRef.extend({
      stepId: z.string().describe("Step id from get_run"),
      title: z.string().trim().min(1).max(200).optional(),
      detail: z.string().max(2000).nullable().optional(),
      status: z.enum(["queued", "running", "done", "failed"]).optional(),
      progressDone: z.number().int().min(0).nullable().optional(),
      progressTotal: z.number().int().min(0).nullable().optional(),
    }),
    output: stepOutputSchema,
    examples: [
      {
        input: {
          id: "00000000-0000-0000-0000-000000000000",
          stepId: "00000000-0000-0000-0000-000000000001",
          status: "done",
        },
        error: "NOT_FOUND",
      },
    ],
    handler: ({ id, stepId, ...patch }, { caller }) =>
      inCallerOrg(caller, (org) =>
        name(RunId(id), async (runId) => {
          const inOrg = await requireInOrg(runInOrg, db, runId, org, "Run")
          const row = orNotFound(
            await updateRunStep(db, runId, stepId, org, inOrg, patch, now()),
            "Step",
          )
          return stepOutput(row, now())
        }),
      ),
  })

  const steer_run = defineOperation({
    name: "steer_run",
    method: "POST",
    path: "/v1/runs/:id/messages",
    summary: "Send a message to a run",
    description:
      "Sends a message from a person to a run while it works: an instruction or a correction. The agent reads " +
      "it with get_run. Refused once the run has finished.",
    permissions: { run: ["steer"] },
    hints: { readOnly: false, destructive: false },
    input: runRef.extend({
      body: z.string().trim().min(1).max(5000).describe("What to tell the agent"),
    }),
    output: messageOutput,
    examples: [
      {
        input: { id: "00000000-0000-0000-0000-000000000000", body: "Skip the billing item" },
        error: "NOT_FOUND",
      },
    ],
    handler: ({ id, body }, { caller }) =>
      inCallerOrg(caller, (org) =>
        name(RunId(id), async (runId) => {
          const inOrg = await requireInOrg(runInOrg, db, runId, org, "Run")
          const author = actorOf(caller).id
          const row = orNotFound(await steerRun(db, runId, org, inOrg, body, author, now()), "Run")
          return {
            id: row.id,
            body: row.body,
            authorId: row.authorId,
            createdAt: row.createdAt.toISOString(),
          }
        }),
      ),
  })

  const defer_run = defineOperation({
    name: "defer_run",
    method: "POST",
    path: "/v1/runs/:id/defer",
    summary: "Wait with a run until a later time",
    description:
      "Defers a run until a time (ISO 8601, after now): it shows as queued with that time, and the agent picks " +
      "it up after. Use it to run work in a low-carbon window or after hours. Refused once the run has finished.",
    permissions: { run: ["steer"] },
    hints: { readOnly: false, destructive: false },
    input: runRef.extend({
      until: z.iso.datetime().describe("When the run may start again, e.g. 2026-10-17T02:00:00Z"),
    }),
    output: runSummaryOutput,
    examples: [
      {
        input: { id: "00000000-0000-0000-0000-000000000000", until: "2030-01-01T00:00:00Z" },
        error: "NOT_FOUND",
      },
    ],
    handler: ({ id, until }, { caller }) =>
      inCallerOrg(caller, (org) =>
        name(RunId(id), async (runId) => {
          const at = now()
          const when = new Date(until)
          if (when.getTime() <= at.getTime()) {
            throw new AppError("BAD_REQUEST", "defer_run needs a time in the future", {
              hint: "Pass an ISO 8601 time later than the current time.",
            })
          }
          const inOrg = await requireInOrg(runInOrg, db, runId, org, "Run")
          const row = orNotFound(await deferRun(db, runId, org, inOrg, when), "Run")
          return runSummary(row, at)
        }),
      ),
  })

  return {
    start_run,
    list_runs,
    get_run,
    update_run,
    append_run_step,
    update_run_step,
    steer_run,
    defer_run,
  }
}
