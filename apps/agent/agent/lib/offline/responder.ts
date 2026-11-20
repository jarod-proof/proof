import type { MockModelResponder } from "eve/evals"
import { traceToProbe } from "./probe.js"

/**
 * The scripted model the agent runs on in offline mode (AGENT_OFFLINE=1), for `pnpm eval`.
 *
 * @remarks
 * It stands in for the chat model so the evals can drive the real hooks, tools, memory and
 * approval machinery without a provider call. It reads one marker out of the user's message and
 * answers with the tool call a real model would be expected to make, and nothing else:
 *
 * - "remember that X": a proposal in the brain (`hq__propose_entry`). It never writes directly,
 *   because the only write tool the agent has is a proposal.
 * - "[hard]": asks for a bigger model (`request_bigger_model`), with an estimate.
 * - anything else: a plain reply.
 */

const slugOf = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "note"

export const offlineResponder: MockModelResponder = async ({ lastUserMessage, toolResults }) => {
  // The harness counts these: a refused turn must leave none.
  await traceToProbe("model-call", { lastUserMessage })
  if (toolResults.length > 0) {
    return "Done."
  }
  const message = lastUserMessage ?? ""
  const remember = /remember that (.+)/i.exec(message)
  if (remember?.[1]) {
    const fact = remember[1].trim()
    return {
      toolCalls: [
        {
          name: "hq__propose_entry",
          input: {
            kind: "fact",
            slug: slugOf(fact),
            title: fact.slice(0, 80),
            text: fact,
            reason: "A person asked me to remember it in Slack.",
          },
        },
      ],
    }
  }
  if (message.includes("[hard]")) {
    return {
      toolCalls: [
        {
          name: "request_bigger_model",
          input: {
            question: message.replace("[hard]", "").trim(),
            model: "anthropic/claude-sonnet-5.5",
            estimateUsd: 0.75,
          },
        },
      ],
    }
  }
  return { text: "Offline reply.", usage: { inputTokens: 40, outputTokens: 4 } }
}
