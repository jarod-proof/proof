// The eight founder operations of the work pipeline: create an item, request an attempt, answer a
// question, approve a merge, stop, reopen, retry, ask for a revert. Each is a founder's decision.
//
// Who may call them (the trust surface, two layers, each enough alone):
//  1. Every one requires `hq_proposal:decide`, a person-only action (PERSON_ONLY_ACTIONS). hq's
//     front door takes person-only actions out of the grants of every key and OAuth token, so a
//     key never holds it, even one minted with it.
//  2. Every handler's first line is `requireFounder`: a signed-in person on the founders list.
// A write that a session makes must also come from a trusted Origin (hq's REST layer).
//
// The `actor` of every data call is the founder, set here and never read from input. None of them
// takes a target state: each maps onto one data function, and the machine decides what is allowed.
import { AppError, reportError } from "@proof/errors"
import { z } from "zod"

import { requestAttempt } from "../data/attempts"
import {
  answerInstructions,
  currentCycleAttemptKind,
  recordRefusedAttemptRequest,
} from "../data/answer-follow-up"
import { approveMerge, reopenItem, requestRevert, retryItem, stopItem } from "../data/decisions"
import { answerQuestion } from "../data/questions"
import { attemptViewOf, toQuestionView } from "../data/work-board"
import { createManualItem } from "../data/work-items"
import { ATTEMPT_DISPATCH_MODE, PAYLOAD_MAX_BYTES } from "../work/constants"
import { defineOperation, type HqDeps, requireFounder } from "./shared"
import { jsonify, resolveItemRef, UNTRUSTED } from "./work-read"
import {
  attemptKind,
  attemptView,
  headSha,
  idRef,
  itemRef,
  noteText,
  questionView,
  workState,
} from "./work-schemas"

/** The operations' names, in the order of the plan's table (I10). */
export const FOUNDER_WORK_OPERATIONS: readonly string[] = [
  "create_work_item",
  "request_attempt",
  "answer_question",
  "approve_merge",
  "stop_work_item",
  "reopen_work_item",
  "retry_work_item",
  "request_revert",
]

const FOUNDER_ONLY =
  "Only a signed-in founder can call it: API keys, OAuth tokens and anyone not on the founder " +
  "list get FORBIDDEN, so never call it on your own judgement. "

/** What the label route says: the instruction the item page shows too. */
const LABEL_HINT =
  "Add the `agent:build` label to the issue to start the agent (if it already has the label, " +
  "remove it and add it again: GitHub starts a run only when the label is added)."

const optionalNote = noteText.optional()

export function workFounderOperations(deps: HqDeps) {
  const { db, now } = deps
  const dispatchMode = () => deps.dispatchMode ?? ATTEMPT_DISPATCH_MODE

  const create_work_item = defineOperation({
    name: "create_work_item",
    method: "POST",
    path: "/v1/work-items",
    summary: "Create a work item by hand (a founder's decision)",
    description:
      "Makes a work item with source manual in triage, from a title, an optional body and the " +
      "repo (owner/name) it is about. It records the item and starts nothing: an attempt starts " +
      "only from the agent:build label or, where hq dispatches, a founder's request_attempt. " +
      FOUNDER_ONLY +
      UNTRUSTED,
    permissions: { hq_proposal: ["decide"] },
    input: z.object({
      title: z.string().min(1).max(300),
      body: z.string().max(PAYLOAD_MAX_BYTES).optional(),
      repo: z
        .string()
        .regex(/^[\w.-]+\/[\w.-]+$/, "Expected owner/name")
        .max(200),
    }),
    output: z.object({ itemId: z.string(), displayId: z.string() }),
    hints: { readOnly: false, destructive: false },
    examples: [{ input: { title: "Add dark mode", repo: "acme/web" }, error: "FORBIDDEN" }],
    handler: async (input, { caller }) => {
      const founderId = await requireFounder(deps, caller)
      return createManualItem(db, { ...input, founderId, now: now() })
    },
  })

  const request_attempt = defineOperation({
    name: "request_attempt",
    method: "POST",
    path: "/v1/work-items/:itemId/attempt-requests",
    summary: "Ask the agent to start an attempt at a work item (a founder's decision)",
    description:
      "Records a requested attempt (investigate or fix) with optional instructions for the " +
      "agent to claim. It starts nothing itself and moves no state; it is BAD_REQUEST while hq " +
      "starts attempts from the agent:build label instead, and CONFLICT when an attempt is " +
      "already waiting or running or a fix has no budget left. " +
      FOUNDER_ONLY +
      UNTRUSTED,
    permissions: { hq_proposal: ["decide"] },
    input: z.object({
      itemId: itemRef,
      kind: attemptKind,
      instructions: optionalNote,
    }),
    output: attemptView,
    hints: { readOnly: false, destructive: false },
    examples: [{ input: { itemId: "FAC-999", kind: "investigate" }, error: "FORBIDDEN" }],
    handler: async (input, { caller }) => {
      const founderId = await requireFounder(deps, caller)
      if (dispatchMode() === "label") {
        throw new AppError(
          "BAD_REQUEST",
          "This factory starts attempts from the agent:build label",
          {
            hint: LABEL_HINT,
          },
        )
      }
      const item = await resolveItemRef(deps, input.itemId)
      const row = await requestAttempt(db, {
        origin: "founder_request",
        itemId: item.id,
        kind: input.kind,
        instructions: input.instructions,
        founderId,
        now: now(),
      })
      return jsonify(await attemptViewOf(db, row))
    },
  })

  const answer_question = defineOperation({
    name: "answer_question",
    method: "POST",
    path: "/v1/questions/:questionId/answer",
    summary: "Answer a question the agent asked (a founder's decision)",
    description:
      "Records the founder's chosen option and optional note on an open question, once. Where hq " +
      "dispatches attempts it then also requests an attempt for the item, as the answering " +
      "founder, with the answer in its instructions; where attempts start from the label it only " +
      "records. If that request is refused the answer stays recorded, the item's history says " +
      "why, and the reply is the refusal. A recommended default is never applied for a founder. " +
      FOUNDER_ONLY +
      UNTRUSTED,
    permissions: { hq_proposal: ["decide"] },
    input: z.object({
      questionId: idRef("question"),
      optionId: z.string().min(1).max(100),
      note: optionalNote,
    }),
    output: questionView,
    hints: { readOnly: false, destructive: false },
    examples: [
      {
        input: { questionId: "00000000-0000-0000-0000-000000000000", optionId: "a" },
        error: "FORBIDDEN",
      },
    ],
    handler: async (input, { caller }) => {
      const founderId = await requireFounder(deps, caller)
      const at = now()
      // The answer commits first, in the data function's own transaction.
      const answered = await answerQuestion(db, {
        questionId: input.questionId,
        optionId: input.optionId,
        note: input.note,
        founderId,
        now: at,
      })
      const view = jsonify(toQuestionView(answered))
      if (dispatchMode() === "label") return view
      // Then the request, through the one door, on the root database: never inside a transaction.
      const kind = await currentCycleAttemptKind(db, answered.itemId)
      const chosen = answered.options.find((o) => o.id === answered.answeredOptionId)
      const instructions = answerInstructions(chosen?.label ?? input.optionId, answered.answerNote)
      try {
        await requestAttempt(db, {
          origin: "founder_request",
          itemId: answered.itemId,
          kind,
          instructions,
          founderId,
          now: at,
        })
      } catch (error) {
        // Only the door's own refusals (CONFLICT: the start rules and the limit; FORBIDDEN: a
        // Phase 5 policy) leave the "no attempt requested" event. Any other error is rethrown as
        // it is, and the answer stays recorded either way.
        if (
          error instanceof AppError &&
          (error.code === "CONFLICT" || error.code === "FORBIDDEN")
        ) {
          await recordRefusedAttemptRequest(db, {
            itemId: answered.itemId,
            questionId: answered.id,
            optionId: input.optionId,
            kind,
            code: error.code,
            message: error.message,
            founderId,
            at: new Date(at.getTime() + 1),
          }).catch((cause: unknown) =>
            reportError(cause, { operation: "answer_question", itemId: answered.itemId }),
          )
        }
        throw error
      }
      return view
    },
  })

  const approve_merge = defineOperation({
    name: "approve_merge",
    method: "POST",
    path: "/v1/work-items/:itemId/merge-approval",
    summary: "Approve the merge of a work item's pull request at one head (a founder's decision)",
    description:
      "Records a founder's go-ahead bound to the pull request's head sha: CONFLICT when the head " +
      "moved since the founder looked, when the pull request is not open or not the item's " +
      "current one, or when it is already approved. It changes nothing on GitHub and merges " +
      "nothing; the merge is observed later. " +
      FOUNDER_ONLY +
      UNTRUSTED,
    permissions: { hq_proposal: ["decide"] },
    input: z.object({ itemId: itemRef, headSha, note: optionalNote }),
    output: z.object({
      status: z.literal("approved"),
      headSha: z.string(),
      pullRequestUrl: z.string(),
    }),
    hints: { readOnly: false, destructive: false },
    examples: [{ input: { itemId: "FAC-999", headSha: "a".repeat(40) }, error: "FORBIDDEN" }],
    handler: async (input, { caller }) => {
      const founderId = await requireFounder(deps, caller)
      const item = await resolveItemRef(deps, input.itemId)
      const approved = await approveMerge(db, {
        itemId: item.id,
        headSha: input.headSha,
        note: input.note,
        founderId,
        now: now(),
      })
      return { status: "approved" as const, ...approved }
    },
  })

  const stop_work_item = defineOperation({
    name: "stop_work_item",
    method: "POST",
    path: "/v1/work-items/:itemId/stop",
    summary: "Stop a work item (a founder's decision)",
    description:
      "Stops an item that is in flight: its verification window ends, open questions are " +
      "withdrawn, a pending merge approval is voided and a requested attempt is ended. A build " +
      "already running is left to finish on its own. CONFLICT for an item that is done, " +
      "reopened or already stopped. " +
      FOUNDER_ONLY +
      UNTRUSTED,
    permissions: { hq_proposal: ["decide"] },
    input: z.object({ itemId: itemRef, note: optionalNote }),
    output: z.object({ state: workState }),
    hints: { readOnly: false, destructive: false },
    examples: [{ input: { itemId: "FAC-999" }, error: "FORBIDDEN" }],
    handler: async (input, { caller }) => {
      const founderId = await requireFounder(deps, caller)
      const item = await resolveItemRef(deps, input.itemId)
      const row = await stopItem(db, { itemId: item.id, note: input.note, founderId, now: now() })
      return { state: row.state }
    },
  })

  const reopen_work_item = defineOperation({
    name: "reopen_work_item",
    method: "POST",
    path: "/v1/work-items/:itemId/reopen",
    summary: "Reopen a work item (a founder's decision)",
    description:
      "Takes back an item that is verifying or done (it becomes reopened and hq retriages it) " +
      "or one a founder stopped (it goes to triage in a new cycle). CONFLICT for any other " +
      "state. It starts no attempt. " +
      FOUNDER_ONLY +
      UNTRUSTED,
    permissions: { hq_proposal: ["decide"] },
    input: z.object({ itemId: itemRef, note: optionalNote }),
    output: z.object({ state: workState }),
    hints: { readOnly: false, destructive: false },
    examples: [{ input: { itemId: "FAC-999" }, error: "FORBIDDEN" }],
    handler: async (input, { caller }) => {
      const founderId = await requireFounder(deps, caller)
      const item = await resolveItemRef(deps, input.itemId)
      const row = await reopenItem(db, { itemId: item.id, note: input.note, founderId, now: now() })
      return { state: row.state }
    },
  })

  const retry_work_item = defineOperation({
    name: "retry_work_item",
    method: "POST",
    path: "/v1/work-items/:itemId/retry",
    summary: "Grant one more fix attempt to an item that used its budget (a founder's decision)",
    description:
      "Raises the item's attempt limit by one, with a note (required) that becomes a founder " +
      "note on the item. CONFLICT unless the item has used its fix attempts and waits on that. " +
      "It starts no attempt. " +
      FOUNDER_ONLY +
      UNTRUSTED,
    permissions: { hq_proposal: ["decide"] },
    input: z.object({ itemId: itemRef, note: noteText.min(1) }),
    output: z.object({ attemptLimit: z.number().int() }),
    hints: { readOnly: false, destructive: false },
    examples: [{ input: { itemId: "FAC-999", note: "One more." }, error: "FORBIDDEN" }],
    handler: async (input, { caller }) => {
      const founderId = await requireFounder(deps, caller)
      const item = await resolveItemRef(deps, input.itemId)
      return retryItem(db, { itemId: item.id, note: input.note, founderId, now: now() })
    },
  })

  const request_revert = defineOperation({
    name: "request_revert",
    method: "POST",
    path: "/v1/work-items/:itemId/revert-request",
    summary: "Ask for a merged change to be reverted (a founder's decision)",
    description:
      "Moves an item whose pull request was merged (deploying, verifying or done) to reopened " +
      "with a recorded request to revert; hq retriages it and a normal fix attempt does the " +
      "work. It reverts nothing on GitHub. CONFLICT without a merged pull request. " +
      FOUNDER_ONLY +
      UNTRUSTED,
    permissions: { hq_proposal: ["decide"] },
    input: z.object({ itemId: itemRef, note: optionalNote }),
    output: z.object({ state: workState }),
    hints: { readOnly: false, destructive: false },
    examples: [{ input: { itemId: "FAC-999" }, error: "FORBIDDEN" }],
    handler: async (input, { caller }) => {
      const founderId = await requireFounder(deps, caller)
      const item = await resolveItemRef(deps, input.itemId)
      const row = await requestRevert(db, {
        itemId: item.id,
        note: input.note,
        founderId,
        now: now(),
      })
      return { state: row.state }
    },
  })

  return [
    create_work_item,
    request_attempt,
    answer_question,
    approve_merge,
    stop_work_item,
    reopen_work_item,
    retry_work_item,
    request_revert,
  ] as const
}
