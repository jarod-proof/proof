import { allowed } from "@proof/api"
import { ApprovalId, approvalInOrg, name, RunId, runInOrg } from "@proof/auth-proofs"
import { z } from "zod"

import {
  approvalView,
  countPendingApprovals,
  decideApproval,
  requestApproval,
  runNotice,
  undoApproval,
} from "../data/runs"
import { inCallerOrg, orNotFound, requireInOrg } from "../tenant"
import {
  approvalOutputSchema,
  approvalRef,
  defineOperation,
  notifySafely,
  type OperationDeps,
  requirePerson,
  runRef,
} from "./shared"

export function approvalOperations({
  db,
  now,
  notifier,
}: Pick<OperationDeps, "db" | "now" | "notifier">) {
  const request_approval = defineOperation({
    name: "request_approval",
    method: "POST",
    path: "/v1/runs/:id/approvals",
    summary: "Ask a person to approve an action before the run takes it",
    description:
      "Use before any action that needs a person's go-ahead, per the agent's always-ask settings (for example " +
      "posting outside the organization). Give the exact action in words (action) and the content it will " +
      "send (detail). The run moves to needs_you and the approval counts in the inbox. Do not take the action " +
      "until get_run shows it approved; a denied one must not be taken. stepId attaches it to an existing " +
      "step; otherwise the request creates a step for it.",
    permissions: { run: ["update"] },
    hints: { readOnly: false, destructive: false },
    input: runRef.extend({
      action: z
        .string()
        .trim()
        .min(1)
        .max(300)
        .describe('The exact action, e.g. "Post summary to #releases"'),
      detail: z
        .string()
        .max(20_000)
        .nullable()
        .optional()
        .describe("The content the action will send"),
      stepId: z.string().optional().describe("Attach to this step instead of creating one"),
    }),
    output: approvalOutputSchema,
    examples: [
      {
        input: {
          id: "00000000-0000-0000-0000-000000000000",
          action: "Post summary to #releases",
          detail: "v2.8 triage: 4 themes",
        },
        error: "NOT_FOUND",
      },
    ],
    handler: ({ id, ...request }, { caller }) =>
      inCallerOrg(caller, (org, proof) =>
        name(RunId(id), async (runId) => {
          const inOrg = await requireInOrg(runInOrg, db, runId, org, "Run")
          const row = orNotFound(
            await requestApproval(db, runId, org, inOrg, request, now()),
            "Run or step",
          )
          // Everyone who can approve hears it, except a person who asked (they can't approve their own
          // request as a notice). Only a signed-in person is excluded; a key is nobody's member.
          const requesterUserId =
            caller.via === "session" && caller.actor.type === "user"
              ? caller.actor.userId
              : undefined
          await notifySafely(async () => {
            const facts = await runNotice(db, row.runId, org, proof)
            if (!facts) return
            await notifier.inOrg(org, proof, {
              type: "approval.requested",
              agentName: facts.agentName,
              action: row.action,
              runId: row.runId,
              requesterUserId,
            })
          })
          return approvalView(row, now(), "agent")
        }),
      ),
  })

  const decide_approval = defineOperation({
    name: "decide_approval",
    method: "POST",
    path: "/v1/approvals/:id/decision",
    summary: "Approve or deny an action (a person's decision)",
    description:
      "A person allows (approve) or refuses (deny) an action a run asked for. The decision takes effect 30 " +
      "seconds after it is made: until then the agent sees the approval as pending and must not act, and " +
      "undo_approval can reverse it. Only a person signed in to the web app can decide; API keys and AI " +
      "clients can't. Returns CONFLICT if the approval was already decided. Confirm the decision with the " +
      "user before calling.",
    permissions: { run: ["approve"] },
    fresh: true,
    input: approvalRef.extend({ decision: z.enum(["approve", "deny"]) }),
    output: approvalOutputSchema,
    hints: { readOnly: false, destructive: true },
    examples: [
      {
        input: { id: "00000000-0000-0000-0000-000000000000", decision: "approve" },
        error: "NOT_FOUND",
      },
    ],
    handler: ({ id, decision }, { caller }) =>
      inCallerOrg(caller, (org, proof) =>
        name(ApprovalId(id), async (approvalId) => {
          const userId = requirePerson(caller)
          const inOrg = await requireInOrg(approvalInOrg, db, approvalId, org, "Approval")
          const row = await decideApproval(db, approvalId, org, inOrg, decision, userId, now())
          // Sent at decision time. The decision can still be undone for 30 seconds (undo_approval sends
          // nothing); the starter's notice then stands until a decision is made again.
          const decidedAs = row.status === "approved" ? "approved" : "denied"
          await notifySafely(async () => {
            const facts = await runNotice(db, row.runId, org, proof)
            if (!facts) return
            await notifier.inOrg(org, proof, {
              type: "approval.decided",
              decision: decidedAs,
              action: row.action,
              runId: row.runId,
              deciderUserId: userId,
              runStarterUserId: facts.starterUserId,
            })
          })
          return approvalView(row, now(), "person")
        }),
      ),
  })

  const undo_approval = defineOperation({
    name: "undo_approval",
    method: "POST",
    path: "/v1/approvals/:id/undo",
    summary: "Take back a decision within 30 seconds",
    description:
      "Undoes a decision (approve or deny) before it takes effect, returning the approval to pending. After " +
      "30 seconds the decision stands and this returns CONFLICT. Only a person signed in to the web app can undo.",
    permissions: { run: ["approve"] },
    fresh: true,
    hints: { readOnly: false, destructive: false },
    input: approvalRef,
    output: approvalOutputSchema,
    examples: [{ input: { id: "00000000-0000-0000-0000-000000000000" }, error: "NOT_FOUND" }],
    handler: ({ id }, { caller }) =>
      inCallerOrg(caller, (org) =>
        name(ApprovalId(id), async (approvalId) => {
          requirePerson(caller)
          const inOrg = await requireInOrg(approvalInOrg, db, approvalId, org, "Approval")
          const row = await undoApproval(db, approvalId, org, inOrg, now())
          return approvalView(row, now(), "person")
        }),
      ),
  })

  const get_inbox = defineOperation({
    name: "get_inbox",
    method: "GET",
    path: "/v1/inbox",
    summary: "Count the approvals waiting for a person",
    description:
      'Returns how many approvals in this organization wait for a decision: the "needs you" count in the ' +
      "sidebar and top bar. Only a person who can approve gets a count; for everyone else it is 0. Open the " +
      "runs with list_runs (status needs_you).",
    permissions: { run: ["read"] },
    input: z.object({}),
    output: z.object({ needsYou: z.number().int().min(0) }),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: {} }],
    handler: (_input, { caller }) =>
      inCallerOrg(caller, async (org, proof) => {
        if (caller.via !== "session" || !allowed(caller.grants, { run: ["approve"] })) {
          return { needsYou: 0 }
        }
        return { needsYou: await countPendingApprovals(db, org, proof) }
      }),
  })

  return {
    request_approval,
    decide_approval,
    undo_approval,
    get_inbox,
  }
}
