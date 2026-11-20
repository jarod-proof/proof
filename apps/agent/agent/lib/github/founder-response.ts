import type {
  ApprovalConfiguration,
  ApprovalPolicy,
  ApprovalResponsePolicy,
} from "eve/tools/approval"
import { founderOnly } from "../spend/escalation.js"

/**
 * Who may answer an approval the agent asks for: a listed founder, on every tool that asks.
 *
 * @remarks
 * eve's default for a tool with no `response` policy is "only the person whose turn requested the
 * call", so without this a founder could approve only a write they asked for themselves, and a
 * collaborator could approve their own repository write by commenting. The trust rule is that only
 * a signed-in founder approves anything (`AGENT_FOUNDER_PRINCIPALS`), whoever asked.
 *
 * It is `founderOnly` (`lib/spend/escalation.ts`) under a reason that fits any tool: a listed
 * founder is allowed, a denial is allowed from anyone `founderOnly` allows, and everyone else is
 * rejected, leaving the request pending for a founder. The Slack channel's `onAnswers`
 * (`founderAnswerAuth`) is the same rule one layer up; each tool carries its own so a tool is safe
 * on any channel.
 *
 * Phase 1: a `github:` principal is never a listed founder (the list holds Slack principals), so a
 * GitHub-thread answer is always rejected. That fails closed.
 */
export const FOUNDER_ONLY_REASON = "Only a founder can approve this."

export const founderResponse: ApprovalResponsePolicy = async (ctx) => {
  const decision = await founderOnly(ctx)
  return decision.status === "allowed"
    ? decision
    : { reason: FOUNDER_ONLY_REASON, status: "rejected" }
}

/**
 * A tool's request-time policy together with the founder response policy: the `approval` for any
 * tool that may stop for a person.
 */
export const founderApproval = <TInput>(
  request: ApprovalPolicy<TInput>,
): ApprovalConfiguration<TInput> => ({
  request,
  response: founderResponse as ApprovalResponsePolicy<TInput>,
})
