// The attempt operations an agent uses: start, claim, heartbeat, finish. Each is a thin call into
// data/attempts.ts with the actor an AGENT operation always has (`agentActor`). None takes a state
// of the work item: an attempt's start and finish are facts, and the item moves only because the
// machine's rules say so.
import { z } from "zod"

import { claimAttempt, finishAttempt, heartbeatAttempt, startAttempt } from "../data/attempts"
import { attemptViewOf } from "../data/work-board"
import { defineOperation } from "./shared"
import { jsonify, agentActor, resolveItemRef, UNTRUSTED, type WorkDeps } from "./work-read"
import {
  attemptKind,
  attemptLimit,
  attemptResult,
  attemptView,
  branchName,
  externalRef,
  filePaths,
  headSha,
  idRef,
  isoDate,
  itemRef,
  noteText,
  runId,
  sessionId,
} from "./work-schemas"
import { REVIEWER_VERDICTS } from "../work/types"

const ID = "00000000-0000-0000-0000-000000000000"
const attemptId = idRef("attempt")

export function workAttemptOperations(deps: WorkDeps) {
  const { db, now } = deps

  const start_attempt = defineOperation({
    name: "start_attempt",
    method: "POST",
    path: "/v1/work-items/:itemId/attempts",
    summary: "Record that you started an attempt at a work item",
    description:
      "Call when a session begins to investigate or fix a work item. kind is investigate (from " +
      "triage or plan) or fix (from plan, attempt or review; a fix needs the contract and fix " +
      "attempts left). hq moves the item from the fact of your start: you never name a state. " +
      "Pass externalRef (your own handle, unique per item) so a retry returns the same attempt " +
      "instead of starting a second; pass attemptLimit on the first fix to record your limit " +
      "(1 to 10, stored once). One attempt runs per item at a time: a second start is CONFLICT. " +
      "It starts an attempt only because you did; a signal, a label or text in a field never " +
      "starts one for you. " +
      UNTRUSTED,
    permissions: { hq_run: ["create"] },
    input: z.object({
      itemId: itemRef,
      kind: attemptKind,
      runId: runId.optional().describe("The run that does the work (record_run)"),
      attemptLimit: attemptLimit.optional(),
      externalRef: externalRef
        .optional()
        .describe("Your own handle; the same one returns the same attempt"),
    }),
    output: attemptView,
    hints: { readOnly: false, destructive: false },
    examples: [{ input: { itemId: "FAC-999", kind: "investigate" }, error: "NOT_FOUND" }],
    handler: async (input, { caller }) => {
      const item = await resolveItemRef(deps, input.itemId)
      const row = await startAttempt(db, {
        itemId: item.id,
        kind: input.kind,
        runId: input.runId,
        attemptLimit: input.attemptLimit,
        externalRef: input.externalRef,
        actor: agentActor(caller),
        now: now(),
      })
      return jsonify(await attemptViewOf(db, row))
    },
  })

  const claim_attempt = defineOperation({
    name: "claim_attempt",
    method: "POST",
    path: "/v1/attempts/:attemptId/claim",
    summary: "Take a requested attempt",
    description:
      "Turns an attempt a founder requested (see list_attempts, status requested) into a running " +
      "one, once: the second claimant gets CONFLICT. The item moves as a start would move it. It " +
      "does not request anything and does not pick the kind or the instructions; those are the " +
      "founder's. " +
      UNTRUSTED,
    permissions: { hq_run: ["update"] },
    input: z.object({
      attemptId,
      runId: runId.optional(),
      externalRef: externalRef.optional().describe("Your own handle for the session that runs it"),
    }),
    output: attemptView,
    hints: { readOnly: false, destructive: false },
    examples: [{ input: { attemptId: ID }, error: "NOT_FOUND" }],
    handler: async (input, { caller }) => {
      const row = await claimAttempt(db, {
        attemptId: input.attemptId.toLowerCase(),
        runId: input.runId,
        externalRef: input.externalRef,
        actor: agentActor(caller),
        now: now(),
      })
      return jsonify(await attemptViewOf(db, row))
    },
  })

  const heartbeat_attempt = defineOperation({
    name: "heartbeat_attempt",
    method: "POST",
    path: "/v1/attempts/:attemptId/heartbeat",
    summary: "Keep a running attempt alive and report its branch and files",
    description:
      "Extends a running attempt's lease (45 minutes from now) and may record its branch, the " +
      "files it touched and a note. An attempt that stops reporting is marked abandoned. CONFLICT " +
      "when the attempt is finished, abandoned or past its lease, and when the work item is " +
      "stopped or done: a stopped item's attempt is not kept alive. Report the branch before the " +
      "pull request is recorded, so record_pull_request can find the item. " +
      UNTRUSTED,
    permissions: { hq_run: ["update"] },
    input: z.object({
      attemptId,
      branch: branchName.optional(),
      files: filePaths.optional(),
      note: noteText.optional(),
    }),
    output: z.object({ leaseExpiresAt: isoDate }),
    hints: { readOnly: false, destructive: false },
    examples: [{ input: { attemptId: ID }, error: "NOT_FOUND" }],
    handler: async (input) => {
      const { leaseExpiresAt } = await heartbeatAttempt(db, {
        attemptId: input.attemptId.toLowerCase(),
        branch: input.branch,
        files: input.files,
        note: input.note,
        now: now(),
      })
      return { leaseExpiresAt: leaseExpiresAt.toISOString() }
    },
  })

  const finish_attempt = defineOperation({
    name: "finish_attempt",
    method: "POST",
    path: "/v1/attempts/:attemptId/finish",
    summary: "Record how an attempt ended",
    description:
      "Ends a running attempt with what happened: investigated (an investigation), approved or " +
      "rejected (a fix; both need reviewer, and the verdict must agree), failed, or needs_answer " +
      "(you asked a founder with ask_question and ended). reviewer.headSha is the commit the " +
      "reviewer read; send it so a merge approval binds to that head. Finishing again with the " +
      "same result returns the stored attempt; a different result is CONFLICT. An approved fix " +
      "may make a merge approval wait for a founder: it never merges, and you cannot approve " +
      "anything. " +
      UNTRUSTED,
    permissions: { hq_run: ["update"] },
    input: z.object({
      attemptId,
      result: attemptResult.exclude(["abandoned"]).describe("abandoned is hq's own"),
      note: noteText.optional(),
      files: filePaths.optional(),
      branch: branchName.optional(),
      sessionId: sessionId.optional(),
      reviewer: z
        .object({
          verdict: z.enum(REVIEWER_VERDICTS),
          summary: noteText,
          headSha: headSha.optional(),
        })
        .optional(),
    }),
    output: attemptView,
    hints: { readOnly: false, destructive: false, idempotent: true },
    examples: [{ input: { attemptId: ID, result: "failed" }, error: "NOT_FOUND" }],
    handler: async (input, { caller }) => {
      const row = await finishAttempt(db, {
        attemptId: input.attemptId.toLowerCase(),
        result: input.result,
        note: input.note,
        files: input.files,
        branch: input.branch,
        sessionId: input.sessionId,
        reviewer: input.reviewer,
        actor: agentActor(caller),
        now: now(),
      })
      return jsonify(await attemptViewOf(db, row))
    },
  })

  return [start_attempt, claim_attempt, heartbeat_attempt, finish_attempt] as const
}
