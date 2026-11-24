// The operations that record facts for the pipeline: a signal, a pull request, the contract, a
// question to a founder, and the verification sweep. Each is a thin call into data/ with the actor
// an AGENT operation always has (`agentActor`); none takes a state of the work item.
import { AppError } from "@proof/errors"
import { z } from "zod"

import { askQuestion } from "../data/questions"
import { setContract } from "../data/contract"
import { recordPullRequest } from "../data/pull-requests"
import { recordSignal } from "../data/signals"
import { runVerificationSweep } from "../data/verification"
import { toContractItemView, toQuestionView } from "../data/work-board"
import { MAX_QUESTION_OPTIONS } from "../work/constants"
import { PULL_REQUEST_STATES } from "../work/types"
import { defineOperation } from "./shared"
import { agentActor, jsonify, resolveItemRef, UNTRUSTED, type WorkDeps } from "./work-read"
import {
  branchName,
  contractItemView,
  headSha,
  idRef,
  isoDate,
  itemRef,
  questionOption,
  questionView,
  recordSignalInput,
  sweepResult,
  verifierKind,
  workState,
} from "./work-schemas"

const count = z.number().int().min(0).max(2_147_483_647)

export function workSignalOperations(deps: WorkDeps) {
  const { db, now } = deps

  const record_signal = defineOperation({
    name: "record_signal",
    method: "POST",
    path: "/v1/signals",
    summary: "Record a signal: something that may need work",
    description:
      "Records one signal (a GitHub issue or a failing check) from a source hq is connected to. " +
      "The first signal for a dedupeKey makes a work item in triage; later ones attach to it; a " +
      "signal for an item in verify, or done within 7 days, reopens it. outcome is created, " +
      "attached, reopened or duplicate (the same source and externalId again: redelivery writes " +
      "nothing). A signal never starts work, labels or comments on anything. Sources sentry and " +
      "posthog are not connected and manual is a founder's alone: both are BAD_REQUEST. " +
      "Record only what a trusted party reported; the text you pass is stored as data. " +
      UNTRUSTED,
    permissions: { hq_run: ["create"] },
    input: recordSignalInput,
    output: z.object({
      signalId: z.string(),
      itemId: z.string(),
      displayId: z.string(),
      outcome: z.enum(["created", "attached", "reopened", "duplicate"]),
    }),
    hints: { readOnly: false, destructive: false, idempotent: true },
    examples: [
      {
        input: {
          source: "github_issue",
          externalId: "github-issue:acme/web#1:opened",
          dedupeKey: "github-issue:acme/web#1",
          repo: "acme/web",
          title: "Checkout fails",
          summary: "Checkout fails with a 500",
        },
      },
    ],
    handler: async (input, { caller }) => {
      if (input.source === "manual") {
        throw new AppError("BAD_REQUEST", "Only a founder makes a manual work item", {
          hint: "A key records github_issue and ci_failure signals.",
        })
      }
      return recordSignal(db, { ...input, recorder: agentActor(caller), now: now() })
    },
  })

  const record_pull_request = defineOperation({
    name: "record_pull_request",
    method: "POST",
    path: "/v1/pull-requests",
    summary: "Record what GitHub says about a pull request",
    description:
      "Records (creates or updates) a pull request for the work item named by itemId, or else the " +
      "item whose attempt reported this branch (no item: matched false, not an error). Send the " +
      "full set on every event: base, headSha, isDraft and state are required the first time. " +
      "url must be https://github.com/<the item's repo>/pull/<number>. hq moves the item from the " +
      "fact: an opened pull request, a merge, a close. mergedAt and mergedBy only with state " +
      "merged; mergedAt is clamped to now and set once. It records; it does not merge, mark ready " +
      "or comment on GitHub, and it cannot approve a merge: a new head voids a pending approval. " +
      UNTRUSTED,
    permissions: { hq_run: ["update"] },
    input: z.object({
      itemId: itemRef.optional(),
      branch: branchName,
      number: z.number().int().min(1).max(2_147_483_647),
      url: z.string().max(500),
      base: z.string().min(1).max(200).optional(),
      headSha: headSha.optional(),
      isDraft: z.boolean().optional(),
      state: z.enum(PULL_REQUEST_STATES).optional(),
      additions: count.optional(),
      deletions: count.optional(),
      files: count.optional(),
      checks: z
        .array(
          z.object({
            name: z.string().min(1).max(200),
            state: z.enum(["passed", "failed", "pending"]),
          }),
        )
        .max(100)
        .optional()
        .describe("Upserted by name"),
      mergedBy: z.string().min(1).max(100).optional(),
      mergedAt: isoDate.optional(),
    }),
    output: z.object({
      matched: z.boolean(),
      itemId: z.string().nullable(),
      state: workState.nullable(),
    }),
    hints: { readOnly: false, destructive: false, idempotent: true },
    examples: [
      {
        input: {
          branch: "factory/fix-1",
          number: 1,
          url: "https://github.com/acme/web/pull/1",
          base: "main",
          headSha: "a".repeat(40),
          isDraft: false,
          state: "open",
        },
        output: { matched: false, itemId: null, state: null },
      },
    ],
    handler: async (input, { caller }) =>
      recordPullRequest(db, { ...input, actor: agentActor(caller), now: now() }),
  })

  const set_contract = defineOperation({
    name: "set_contract",
    method: "POST",
    path: "/v1/work-items/:itemId/contract",
    summary: "Record what a fix must satisfy, before the first fix attempt",
    description:
      "Sets the contract of the work item's current cycle: 1 to 8 statements, each checked by a " +
      "verifier (reviewer, ci or signal_recurrence; sentry and posthog are not connected). It " +
      "replaces the cycle's contract until a fix attempt has started, then it is fixed " +
      "(CONFLICT). Only while the item is in triage or plan. A fix cannot start without one. " +
      UNTRUSTED,
    permissions: { hq_run: ["update"] },
    input: z.object({
      itemId: itemRef,
      items: z
        .array(
          z.object({
            text: z.string().min(1).max(300),
            verifier: z.object({
              kind: verifierKind,
              config: z.record(z.string(), z.unknown()).optional(),
            }),
          }),
        )
        .min(1)
        .max(8),
    }),
    output: z.object({ contract: z.array(contractItemView) }),
    hints: { readOnly: false, destructive: false },
    examples: [
      {
        input: {
          itemId: "FAC-999",
          items: [{ text: "Checkout works", verifier: { kind: "reviewer" } }],
        },
        error: "NOT_FOUND",
      },
    ],
    handler: async (input, { caller }) => {
      const item = await resolveItemRef(deps, input.itemId)
      const rows = await setContract(db, {
        itemId: item.id,
        items: input.items,
        actor: agentActor(caller),
        now: now(),
      })
      return jsonify({ contract: rows.map(toContractItemView) })
    },
  })

  const ask_question = defineOperation({
    name: "ask_question",
    method: "POST",
    path: "/v1/work-items/:itemId/questions",
    summary: "Ask a founder a question and wait",
    description:
      `Puts a question with 2 to ${MAX_QUESTION_OPTIONS} options to a founder, who answers in hq. ` +
      "It waits until a founder answers: defaultOptionId is only a recommendation shown on a " +
      "button, never applied on a timer, so end your attempt with needs_answer rather than " +
      "waiting. You cannot answer a question, and an answer does not start anything by itself. " +
      "Only for a work item still in flight. " +
      UNTRUSTED,
    permissions: { hq_run: ["create"] },
    input: z.object({
      itemId: itemRef,
      prompt: z.string().min(1).max(2000),
      options: z.array(questionOption).min(2).max(MAX_QUESTION_OPTIONS),
      defaultOptionId: z.string().max(100).optional(),
      attemptId: idRef("attempt").optional().describe("The attempt that asks"),
    }),
    output: questionView,
    hints: { readOnly: false, destructive: false },
    examples: [
      {
        input: {
          itemId: "FAC-999",
          prompt: "Which fix?",
          options: [
            { id: "a", label: "Patch" },
            { id: "b", label: "Rewrite" },
          ],
        },
        error: "NOT_FOUND",
      },
    ],
    handler: async (input, { caller }) => {
      const item = await resolveItemRef(deps, input.itemId)
      const row = await askQuestion(db, {
        itemId: item.id,
        prompt: input.prompt,
        options: input.options,
        defaultOptionId: input.defaultOptionId,
        attemptId: input.attemptId?.toLowerCase(),
        actor: agentActor(caller),
        now: now(),
      })
      return jsonify(toQuestionView(row))
    },
  })

  const run_verification_sweep = defineOperation({
    name: "run_verification_sweep",
    method: "POST",
    path: "/v1/work/verification-sweep",
    summary: "Run the verification sweep once",
    description:
      "Runs hq's own rules once: attempts whose lease ran out are abandoned, reopened items go " +
      "back to triage, a merge past its 15 minute grace opens its verification window, and a " +
      "window whose contract holds and time is up passes to done (a failed contract or a " +
      "recurring signal reopens it). You name nothing and choose nothing: the evidence moves " +
      "items, and running it twice changes nothing the second time. errors lists what failed " +
      "and was skipped. " +
      UNTRUSTED,
    permissions: { hq_run: ["update"] },
    input: z.object({}),
    output: sweepResult,
    hints: { readOnly: false, destructive: false, idempotent: true },
    examples: [{ input: {} }],
    handler: async () => runVerificationSweep(db, now()),
  })

  return [
    record_signal,
    record_pull_request,
    set_contract,
    ask_question,
    run_verification_sweep,
  ] as const
}
