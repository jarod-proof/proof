import { agentEnvList } from "@proof/env/agent"
import type { ApprovalResponsePolicy } from "eve/tools/approval"
import { traceToProbe } from "../offline/probe.js"

/**
 * Asking for a bigger model: what the tool may ask for, who may say yes, and what happens after.
 *
 * @remarks
 * The default chat model is the cheap one. A question that needs more asks first
 * (`request_bigger_model`): eve posts an approval with the model and the estimate, and only a
 * founder's click lets the tool run. The click that raises today's allowance in hq and re-runs the
 * question with the bigger model is Task 8; here that step is the {@link BiggerModelRunner}
 * interface with a stub that calls no model.
 */

/** The models a question may be escalated to, in gateway ids. The model cannot name another. */
export const ESCALATION_MODELS = [
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-opus-5.5",
] as const

/** The most one escalation may be estimated at, in dollars. */
export const MAX_ESCALATION_ESTIMATE_USD = 5

export interface EscalationRequest {
  question: string
  model: (typeof ESCALATION_MODELS)[number]
  estimateUsd: number
}

export type EscalationResult = { status: "not-wired"; note: string }

/**
 * What runs once a founder approved: raise the allowance through hq and re-run the question on the
 * bigger model. Task 8 provides the real one; until then the stub below runs nothing.
 */
export interface BiggerModelRunner {
  run(request: EscalationRequest): Promise<EscalationResult>
}

/** Task 8 replaces this. It calls no model and says so. */
export const stubRunner: BiggerModelRunner = {
  async run(request) {
    await traceToProbe("bigger-model-run", request)
    return {
      status: "not-wired",
      note: "A founder approved, but the allowance grant and the re-run on the bigger model are not wired yet.",
    }
  },
}

/** The prompt an approval card shows: the model, the estimate and the question. */
export function escalationPrompt(request: EscalationRequest): string {
  return `Run ${request.model} for about $${request.estimateUsd.toFixed(2)} on: ${request.question.slice(0, 300)}`
}

/**
 * Only a listed founder may approve an escalation (AGENT_FOUNDER_PRINCIPALS, comma-separated
 * principal ids such as `slack:T01:U01`). Nobody listed means nobody approves. Anyone may dismiss
 * it. A rejected response leaves the request pending for the right person.
 */
export const founderOnly: ApprovalResponsePolicy = ({ response }) => {
  if (response.decision === "deny") {
    return { status: "allowed" }
  }
  const founders = agentEnvList("AGENT_FOUNDER_PRINCIPALS")
  if (founders.includes(response.principal.principalId)) {
    return { status: "allowed" }
  }
  return { status: "rejected", reason: "Only a founder can approve a bigger model." }
}
