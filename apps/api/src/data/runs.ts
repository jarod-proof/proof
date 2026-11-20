// Runs of workspace agents: the run, its ordered steps, the approvals it waits on and the messages
// people send it. Every function takes the organization as a Named id plus a proof, and still filters
// by organizationId in SQL. Time is passed in (`now`), so the 30-second approval window is testable.
import type {
  AgentId,
  AgentInOrg,
  ApprovalId,
  ApprovalInOrg,
  CallerActsFor,
  Named,
  OrganizationId,
  RunId,
  RunInOrg,
} from "@proof/auth-proofs"
import { agent, approval, type Database, run, runStep, steerMessage } from "@proof/db"
import { AppError } from "@proof/errors"
import { and, asc, desc, eq, gt, inArray, lt, max, or } from "drizzle-orm"

export type Run = typeof run.$inferSelect
export type RunStep = typeof runStep.$inferSelect
export type Approval = typeof approval.$inferSelect
export type SteerMessage = typeof steerMessage.$inferSelect

export const RUN_STATUSES = ["queued", "running", "needs_you", "done", "failed"] as const
export const STEP_STATUSES = ["queued", "running", "needs_you", "done", "failed"] as const
/** A run that has finished: no more steps, approvals or messages. */
export const FINISHED = ["done", "failed"] as const

/** How long a decision can be undone (and is not yet effective for the agent). */
export const APPROVAL_WINDOW_MS = 30_000

export interface RunPage {
  /** The last row of the previous page: createdAt (ISO) and id. Newest first. */
  after?: { at: string; id: string }
  agentId?: string
  status?: (typeof RUN_STATUSES)[number]
  limit: number
}

export async function listRuns<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: CallerActsFor<O>,
  page: RunPage,
): Promise<Run[]> {
  const after = page.after
  const before = after
    ? or(
        lt(run.createdAt, new Date(after.at)),
        and(eq(run.createdAt, new Date(after.at)), lt(run.id, after.id)),
      )
    : undefined
  return db
    .select()
    .from(run)
    .where(
      and(
        eq(run.organizationId, org.value),
        page.agentId ? eq(run.agentId, page.agentId) : undefined,
        page.status ? eq(run.status, page.status) : undefined,
        before,
      ),
    )
    .orderBy(desc(run.createdAt), desc(run.id))
    .limit(page.limit)
}

/** A run with everything its view shows. Each query is filtered by the organization. */
export interface RunBundle {
  run: Run
  /** The agent's energy budget (null when unset): the run's footprint is read against it. */
  energyBudgetWh: number | null
  steps: RunStep[]
  approvals: Approval[]
  messages: SteerMessage[]
}

export async function getRunBundle<R, O>(
  db: Database,
  id: Named<R, RunId>,
  org: Named<O, OrganizationId>,
  _proof: RunInOrg<R, O>,
): Promise<RunBundle | undefined> {
  const [row] = await db
    .select()
    .from(run)
    .where(and(eq(run.id, id.value), eq(run.organizationId, org.value)))
    .limit(1)
  if (!row) return undefined
  const [budget] = await db
    .select({ energyBudgetWh: agent.energyBudgetWh })
    .from(agent)
    .where(and(eq(agent.id, row.agentId), eq(agent.organizationId, org.value)))
    .limit(1)
  const [steps, approvals, messages] = await Promise.all([
    db
      .select()
      .from(runStep)
      .where(and(eq(runStep.runId, row.id), eq(runStep.organizationId, org.value)))
      .orderBy(asc(runStep.position)),
    db
      .select()
      .from(approval)
      .where(and(eq(approval.runId, row.id), eq(approval.organizationId, org.value)))
      .orderBy(asc(approval.requestedAt), asc(approval.id)),
    db
      .select()
      .from(steerMessage)
      .where(and(eq(steerMessage.runId, row.id), eq(steerMessage.organizationId, org.value)))
      .orderBy(asc(steerMessage.createdAt), asc(steerMessage.id)),
  ])
  return { run: row, energyBudgetWh: budget?.energyBudgetWh ?? null, steps, approvals, messages }
}

const finished = (r: { status: string }) => (FINISHED as readonly string[]).includes(r.status)

/**
 * Refuses a write to a finished run. Every write reads its run `for update` first, so writes to one
 * run take turns: two appended steps can't take the same position, and a run can't finish while an
 * approval is being requested.
 */
function assertOpen(r: Run): void {
  if (finished(r)) {
    throw new AppError("CONFLICT", "This run has finished", {
      hint: "Start a new run with start_run. A finished run takes no more steps, approvals or messages.",
    })
  }
}

export interface StartRunInput {
  title: string
  summary?: string | null
}

/** A new run waits as `queued`; the agent moves it to `running` with update_run. */
export async function startRun<A, O>(
  db: Database,
  agentId: Named<A, AgentId>,
  org: Named<O, OrganizationId>,
  _proof: AgentInOrg<A, O>,
  input: StartRunInput,
  actor: { type: "user" | "apiKey"; id: string },
  now: Date,
): Promise<Run> {
  const [row] = await db
    .insert(run)
    .values({
      id: crypto.randomUUID(),
      organizationId: org.value,
      agentId: agentId.value,
      title: input.title,
      summary: input.summary ?? null,
      status: "queued",
      startedByType: actor.type,
      startedById: actor.id,
      createdAt: now,
    })
    .returning()
  if (!row) throw new AppError("INTERNAL", "insert returned no row")
  return row
}

export interface StepInput {
  kind: string
  title: string
  detail?: string | null
  status?: (typeof STEP_STATUSES)[number]
  progressDone?: number | null
  progressTotal?: number | null
}

/** Appends a step after the last one. Refused once the run has finished. */
export async function appendRunStep<R, O>(
  db: Database,
  id: Named<R, RunId>,
  org: Named<O, OrganizationId>,
  _proof: RunInOrg<R, O>,
  input: StepInput,
  now: Date,
): Promise<RunStep | undefined> {
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select()
      .from(run)
      .where(and(eq(run.id, id.value), eq(run.organizationId, org.value)))
      .limit(1)
      .for("update")
    if (!owner) return undefined
    assertOpen(owner)
    const [last] = await tx
      .select({ position: max(runStep.position) })
      .from(runStep)
      .where(eq(runStep.runId, owner.id))
    const status = input.status ?? "queued"
    const [row] = await tx
      .insert(runStep)
      .values({
        id: crypto.randomUUID(),
        organizationId: org.value,
        runId: owner.id,
        position: (last?.position ?? 0) + 1,
        kind: input.kind,
        title: input.title,
        detail: input.detail ?? null,
        status,
        progressDone: input.progressDone ?? null,
        progressTotal: input.progressTotal ?? null,
        startedAt: status === "running" ? now : null,
        finishedAt: finished({ status }) ? now : null,
        createdAt: now,
      })
      .returning()
    return row
  })
}

export interface StepPatch {
  title?: string
  detail?: string | null
  status?: Exclude<(typeof STEP_STATUSES)[number], "needs_you">
  progressDone?: number | null
  progressTotal?: number | null
}

/**
 * Changes one step. `needs_you` is not settable here: request_approval sets it. A step's start and
 * finish times are stamped the first time it reaches running and done or failed.
 */
export async function updateRunStep<R, O>(
  db: Database,
  runId: Named<R, RunId>,
  stepId: string,
  org: Named<O, OrganizationId>,
  _proof: RunInOrg<R, O>,
  patch: StepPatch,
  now: Date,
): Promise<RunStep | undefined> {
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select()
      .from(run)
      .where(and(eq(run.id, runId.value), eq(run.organizationId, org.value)))
      .limit(1)
      .for("update")
    if (!owner) return undefined
    assertOpen(owner)
    const [step] = await tx
      .select()
      .from(runStep)
      .where(
        and(
          eq(runStep.id, stepId),
          eq(runStep.runId, owner.id),
          eq(runStep.organizationId, org.value),
        ),
      )
      .limit(1)
    if (!step) return undefined
    const status = patch.status ?? step.status
    const [row] = await tx
      .update(runStep)
      .set({
        ...patch,
        status,
        startedAt: step.startedAt ?? (status === "running" ? now : null),
        finishedAt: finished({ status }) ? (step.finishedAt ?? now) : null,
      })
      .where(eq(runStep.id, step.id))
      .returning()
    return row
  })
}

export interface RunPatch {
  status?: "running" | "done" | "failed"
  summary?: string | null
  energyWh?: number
  tokens?: number
  toolCalls?: number
}

/** Agent-visible approvals that still block the run: pending, or decided but not yet effective. */
export function blockingApprovals(approvals: readonly Approval[], now: Date): Approval[] {
  return approvals.filter(
    (a) => a.status === "pending" || (a.effectiveAt !== null && a.effectiveAt > now),
  )
}

/**
 * Sets the run's status, footprint and summary. The run can't move on while an approval blocks it,
 * so a stopped-for-approval run only continues once the decision is effective. Setting running
 * clears a deferral.
 */
export async function updateRun<R, O>(
  db: Database,
  id: Named<R, RunId>,
  org: Named<O, OrganizationId>,
  _proof: RunInOrg<R, O>,
  patch: RunPatch,
  now: Date,
): Promise<Run | undefined> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(run)
      .where(and(eq(run.id, id.value), eq(run.organizationId, org.value)))
      .limit(1)
      .for("update")
    if (!current) return undefined
    assertOpen(current)
    if (patch.status !== undefined) {
      const approvals = await tx
        .select()
        .from(approval)
        .where(and(eq(approval.runId, current.id), eq(approval.organizationId, org.value)))
      if (blockingApprovals(approvals, now).length > 0) {
        throw new AppError("CONFLICT", "The run is waiting for an approval", {
          hint: "Call get_run and wait until the approval shows approved or denied (a decision takes effect 30 seconds after it is made). Don't take the action before then.",
        })
      }
    }
    const status = patch.status ?? current.status
    const [row] = await tx
      .update(run)
      .set({
        status,
        summary: patch.summary === undefined ? current.summary : patch.summary,
        energyWh: patch.energyWh ?? current.energyWh,
        tokens: patch.tokens ?? current.tokens,
        toolCalls: patch.toolCalls ?? current.toolCalls,
        startedAt: current.startedAt ?? (status === "running" ? now : null),
        finishedAt: finished({ status }) ? (current.finishedAt ?? now) : null,
        deferredUntil: status === "running" ? null : current.deferredUntil,
      })
      .where(eq(run.id, current.id))
      .returning()
    return row
  })
}

export interface ApprovalRequest {
  action: string
  detail?: string | null
  stepId?: string
}

/**
 * Asks a person to allow an action. The run waits as `needs_you`: on the given step, or on a new
 * step of kind "approval" that the request creates. Returns undefined when the run or the step is
 * not in this organization.
 */
export async function requestApproval<R, O>(
  db: Database,
  id: Named<R, RunId>,
  org: Named<O, OrganizationId>,
  _proof: RunInOrg<R, O>,
  input: ApprovalRequest,
  now: Date,
): Promise<Approval | undefined> {
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select()
      .from(run)
      .where(and(eq(run.id, id.value), eq(run.organizationId, org.value)))
      .limit(1)
      .for("update")
    if (!owner) return undefined
    assertOpen(owner)
    let stepId: string
    if (input.stepId !== undefined) {
      const [step] = await tx
        .select({ id: runStep.id })
        .from(runStep)
        .where(
          and(
            eq(runStep.id, input.stepId),
            eq(runStep.runId, owner.id),
            eq(runStep.organizationId, org.value),
          ),
        )
        .limit(1)
      if (!step) return undefined
      stepId = step.id
      await tx.update(runStep).set({ status: "needs_you" }).where(eq(runStep.id, stepId))
    } else {
      const [last] = await tx
        .select({ position: max(runStep.position) })
        .from(runStep)
        .where(eq(runStep.runId, owner.id))
      stepId = crypto.randomUUID()
      await tx.insert(runStep).values({
        id: stepId,
        organizationId: org.value,
        runId: owner.id,
        position: (last?.position ?? 0) + 1,
        kind: "approval",
        title: input.action,
        status: "needs_you",
        createdAt: now,
      })
    }
    await tx.update(run).set({ status: "needs_you" }).where(eq(run.id, owner.id))
    const [row] = await tx
      .insert(approval)
      .values({
        id: crypto.randomUUID(),
        organizationId: org.value,
        runId: owner.id,
        stepId,
        action: input.action,
        detail: input.detail ?? null,
        status: "pending",
        requestedAt: now,
      })
      .returning()
    return row
  })
}

/** Decisions: a person allows (approve) or refuses (deny) a pending approval. Once only. */
export type Decision = "approve" | "deny"

export async function decideApproval<X, O>(
  db: Database,
  id: Named<X, ApprovalId>,
  org: Named<O, OrganizationId>,
  _proof: ApprovalInOrg<X, O>,
  decision: Decision,
  decidedBy: string,
  now: Date,
): Promise<Approval> {
  // One conditional write: only a pending approval can be decided, so two people (or a retry) can't
  // both decide it.
  const [row] = await db
    .update(approval)
    .set({
      status: decision === "approve" ? "approved" : "denied",
      decidedBy,
      decidedAt: now,
      effectiveAt: new Date(now.getTime() + APPROVAL_WINDOW_MS),
    })
    .where(
      and(
        eq(approval.id, id.value),
        eq(approval.organizationId, org.value),
        eq(approval.status, "pending"),
      ),
    )
    .returning()
  if (!row) {
    throw new AppError("CONFLICT", "This approval is no longer pending", {
      hint: "It was already decided. Undo that decision with undo_approval (within 30 seconds) to decide again.",
    })
  }
  return row
}

/**
 * Takes a decision back, only before it takes effect. One conditional write, so a decision that has
 * become effective can't be undone. The approval returns to pending.
 */
export async function undoApproval<X, O>(
  db: Database,
  id: Named<X, ApprovalId>,
  org: Named<O, OrganizationId>,
  _proof: ApprovalInOrg<X, O>,
  now: Date,
): Promise<Approval> {
  const [row] = await db
    .update(approval)
    .set({
      status: "pending",
      decidedBy: null,
      decidedAt: null,
      effectiveAt: null,
      undoneAt: now,
    })
    .where(
      and(
        eq(approval.id, id.value),
        eq(approval.organizationId, org.value),
        inArray(approval.status, ["approved", "denied"]),
        gt(approval.effectiveAt, now),
      ),
    )
    .returning()
  if (row) return row
  const [current] = await db
    .select()
    .from(approval)
    .where(and(eq(approval.id, id.value), eq(approval.organizationId, org.value)))
    .limit(1)
  if (current?.status === "pending") {
    throw new AppError("CONFLICT", "This approval has no decision to undo", {
      hint: "Decide it first with decide_approval.",
    })
  }
  throw new AppError("CONFLICT", "The undo window has closed", {
    hint: "A decision can be undone only for 30 seconds after it is made. It now takes effect.",
  })
}

/** The approvals this organization is waiting on, which only a person who can approve clears. */
export async function countPendingApprovals<O>(
  db: Database,
  org: Named<O, OrganizationId>,
  _proof: CallerActsFor<O>,
): Promise<number> {
  const rows = await db
    .select({ id: approval.id })
    .from(approval)
    .where(and(eq(approval.organizationId, org.value), eq(approval.status, "pending")))
  return rows.length
}

export async function steerRun<R, O>(
  db: Database,
  id: Named<R, RunId>,
  org: Named<O, OrganizationId>,
  _proof: RunInOrg<R, O>,
  body: string,
  authorId: string,
  now: Date,
): Promise<SteerMessage | undefined> {
  return db.transaction(async (tx) => {
    const [owner] = await tx
      .select()
      .from(run)
      .where(and(eq(run.id, id.value), eq(run.organizationId, org.value)))
      .limit(1)
      .for("update")
    if (!owner) return undefined
    assertOpen(owner)
    const [row] = await tx
      .insert(steerMessage)
      .values({
        id: crypto.randomUUID(),
        organizationId: org.value,
        runId: owner.id,
        body,
        authorId,
        createdAt: now,
      })
      .returning()
    return row
  })
}

/** Waits the run until a time, shown as Queued with that time. Refused once the run has finished. */
export async function deferRun<R, O>(
  db: Database,
  id: Named<R, RunId>,
  org: Named<O, OrganizationId>,
  _proof: RunInOrg<R, O>,
  until: Date,
): Promise<Run | undefined> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(run)
      .where(and(eq(run.id, id.value), eq(run.organizationId, org.value)))
      .limit(1)
      .for("update")
    if (!current) return undefined
    assertOpen(current)
    const [row] = await tx
      .update(run)
      .set({ status: "queued", deferredUntil: until })
      .where(eq(run.id, current.id))
      .returning()
    return row
  })
}

/**
 * What an approval looks like to the caller. An agent sees `pending` until the decision is effective,
 * with no decision details: a decision it hasn't been released for must not look like one. A person
 * sees the decision, and the time until which it can still be undone.
 */
export function approvalView(a: Approval, now: Date, viewer: "person" | "agent") {
  const decided = a.status !== "pending"
  const effective = decided && a.effectiveAt !== null && a.effectiveAt <= now
  const base = {
    id: a.id,
    stepId: a.stepId,
    action: a.action,
    detail: a.detail,
    requestedAt: a.requestedAt.toISOString(),
  }
  if (viewer === "agent") {
    return {
      ...base,
      status: effective ? (a.status as "approved" | "denied") : ("pending" as const),
      decision: null,
    }
  }
  return {
    ...base,
    status: a.status as "pending" | "approved" | "denied",
    decision: decided
      ? {
          decidedBy: a.decidedBy,
          decidedAt: a.decidedAt?.toISOString() ?? null,
          effectiveAt: a.effectiveAt?.toISOString() ?? null,
          undoableUntil: !effective && a.effectiveAt ? a.effectiveAt.toISOString() : null,
        }
      : null,
  }
}

/**
 * What a notice says about a run: the agent's name, and the person who started the run (null when a
 * key started it, which is not a person to notify). Undefined when the run is not in this organization.
 */
export async function runNotice<O>(
  db: Database,
  runId: string,
  org: Named<O, OrganizationId>,
  _proof: CallerActsFor<O>,
): Promise<{ agentName: string; starterUserId: string | null } | undefined> {
  const [row] = await db
    .select({
      agentName: agent.name,
      startedByType: run.startedByType,
      startedById: run.startedById,
    })
    .from(run)
    .innerJoin(agent, and(eq(agent.id, run.agentId), eq(agent.organizationId, org.value)))
    .where(and(eq(run.id, runId), eq(run.organizationId, org.value)))
    .limit(1)
  if (!row) return undefined
  return {
    agentName: row.agentName,
    starterUserId: row.startedByType === "user" ? row.startedById : null,
  }
}
