import { defineTool } from "eve/tools"
import { always } from "eve/tools/approval"
import { z } from "zod"
import {
  ESCALATION_MODELS,
  type EscalationRequest,
  escalationPrompt,
  founderOnly,
  MAX_ESCALATION_ESTIMATE_USD,
  stubRunner,
} from "../lib/spend/escalation.js"

/**
 * Ask a founder to let a harder question run on a bigger, dearer model.
 *
 * @remarks
 * Use it only when the default model clearly cannot answer. It runs nothing by itself: eve posts an
 * approval with the model and the estimate, and the tool body runs only after a listed founder
 * approves (`approval.request: always()`, `approval.response: founderOnly`). Until the grant flow
 * lands (Task 8) the body is a stub that calls no model.
 */
export default defineTool({
  description:
    "Ask a founder to approve running a bigger, more expensive model on a hard question. Give the " +
    "question, the model, and your honest estimate of the cost in dollars. A founder decides in the " +
    "thread; nothing runs on the bigger model until they approve. Use it only when you cannot " +
    "answer well yourself.",
  inputSchema: z.object({
    question: z.string().min(1).max(4000),
    model: z.enum(ESCALATION_MODELS),
    estimateUsd: z.number().gt(0).max(MAX_ESCALATION_ESTIMATE_USD),
  }),
  approval: {
    request: always(),
    response: founderOnly,
    prompt: ({ input }) => escalationPrompt(input as EscalationRequest),
  },
  async execute(input) {
    return await stubRunner.run(input)
  },
})
