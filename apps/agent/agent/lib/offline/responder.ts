import type { MockModelRequest, MockModelResponder, MockModelResponse } from "eve/evals"
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
 * - "[records-attempts:<scenario>]": drives the station wrappers for the `records-attempts` eval
 *   (the orchestrator calls the stations in order, a station answers with its structured output).
 * - anything else: a plain reply.
 */

const slugOf = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "note"

const SCENARIO = /\[records-attempts:(ok|fail|limit|ask)\]/
const STATION = /\[station:(analyst|implementer|reviewer)(:prose)?\]/

/** The commit the scripted reviewer says it read (`git rev-parse HEAD`); the eval checks it is kept. */
export const READ_SHA = "b".repeat(40)

/** What each station answers with: the shape its output schema asks for, filled with fixed text. */
const STATION_ANSWERS = {
  analyst: {
    problem_statement: "Totals ignore tax.",
    approach: "Add the tax to the total.",
    plan: ["Add tax to the total"],
    affected_surface: ["src/totals.ts"],
    assumptions: [],
    open_questions: [],
    risks: [],
    acceptance_criteria: ["Checkout totals include tax", "A refund keeps its receipt"],
    test_strategy: "Unit tests.",
    artifact_id: null,
  },
  implementer: {
    base: "main",
    branch: "agent/fix-tax",
    change_summary: [{ path: "src/totals.ts", change: "add tax" }],
    deviations: [],
    known_limitations: [],
    pushed: true,
    verification: [{ command: "pnpm test", result: "pass" }],
  },
  reviewer: {
    blocking_findings: [],
    criteria_results: [
      { criterion: "Checkout totals include tax", evidence: "the diff", pass: true },
    ],
    head_sha: READ_SHA,
    suggestions: [],
    summary: "Looks right.",
    verdict: "approve",
  },
} as const

const RECORDS_ATTEMPTS_PLAN = {
  ok: ["run_analyst", "run_implementer", "run_reviewer"],
  fail: ["run_analyst"],
  limit: ["run_implementer"],
  ask: ["run_implementer", "ask_founder"],
} as const

/**
 * The `records-attempts` eval's script, or null when the message carries no marker. The orchestrator
 * (the message holds `[records-attempts:<scenario>]`) calls the scenario's tools in order, then
 * closes; a station (the tool's message holds `[station:<name>]`) answers with its structured
 * output, or with prose, which eve settles as a failed station.
 */
async function recordsAttempts(
  request: MockModelRequest,
): Promise<MockModelResponse | string | null> {
  const asked = request.userMessages.join("\n")
  const station = STATION.exec(asked)
  if (station?.[1]) {
    // The structured answer is the input of eve's `eve__reply` tool (its schema is the station's);
    // prose is what a station that ignored the structure would say, which eve settles as failed.
    return station[2]
      ? "I looked at it and I think the answer is yes."
      : {
          toolCalls: [
            {
              name: "eve__reply",
              input: STATION_ANSWERS[station[1] as keyof typeof STATION_ANSWERS],
            },
          ],
        }
  }
  const scenario = SCENARIO.exec(asked)?.[1] as keyof typeof RECORDS_ATTEMPTS_PLAN | undefined
  if (scenario === undefined) {
    return null
  }
  const next = RECORDS_ATTEMPTS_PLAN[scenario][request.toolResults.length]
  if (next === undefined) {
    return "Done."
  }
  const input =
    next === "ask_founder"
      ? {
          prompt: "Which fix do you want?",
          options: [
            { id: "patch", label: "Patch it" },
            { id: "rewrite", label: "Rewrite the module" },
          ],
          defaultOptionId: "patch",
        }
      : {
          message: `[station:${next.slice(4)}${scenario === "fail" ? ":prose" : ""}] Work on the item.`,
        }
  return { toolCalls: [{ name: next, input }] }
}

export const offlineResponder: MockModelResponder = async (request) => {
  const { lastUserMessage, toolResults } = request
  // The harness counts these: a refused turn must leave none.
  await traceToProbe("model-call", { lastUserMessage })
  const scripted = await recordsAttempts(request)
  if (scripted !== null) {
    return scripted
  }
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
