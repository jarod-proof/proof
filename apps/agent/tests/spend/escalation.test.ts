import { afterEach, describe, expect, test, vi } from "vitest"
import tool from "../../agent/tools/request_bigger_model.js"
import { escalationPrompt, founderOnly, stubRunner } from "#lib/spend/escalation.js"
import { approvalContext, CALLERS, outcome } from "../helpers.js"

/**
 * request_bigger_model: it asks with an estimate, only a founder can approve, and it runs no model
 * itself. The click that grants spend in hq and re-runs the question is Task 8; the evals prove the
 * ordering through eve's own approval machinery (evals/spend/escalation-asks.eval.ts).
 */
afterEach(() => {
  vi.unstubAllEnvs()
})

const response = (decision: "approve" | "deny", principalId: string) =>
  ({
    request: {},
    session: {},
    auth: {},
    response: {
      decision,
      principal: { principalId, principalType: "user", authenticator: "slack", attributes: {} },
    },
  }) as never

type ApprovalShape = {
  request: (ctx: never) => unknown
  prompt?: (ctx: never) => string
}
const approval = (tool as unknown as { approval: ApprovalShape }).approval

describe("request_bigger_model", () => {
  test("every caller must ask a person first: the call is never run without an approval", async () => {
    const input = { question: "hard", model: "anthropic/claude-sonnet-5.5", estimateUsd: 0.75 }
    for (const [name, caller] of Object.entries(CALLERS)) {
      const status = await approval.request(approvalContext(caller, input))
      expect(outcome(status), `caller ${name}`).toBe("user-approval")
    }
  })

  test("the approval card names the model and the estimate", () => {
    const card = escalationPrompt({
      question: "How should we price a team plan?",
      model: "anthropic/claude-sonnet-5.5",
      estimateUsd: 0.75,
    })
    expect(card).toContain("anthropic/claude-sonnet-5.5")
    expect(card).toContain("$0.75")
  })

  test("the model can only name the listed models, and an estimate within bounds", () => {
    const schema = (
      tool as unknown as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }
    ).inputSchema
    const ok = { question: "q", model: "anthropic/claude-opus-5.5", estimateUsd: 1 }
    expect(schema.safeParse(ok).success).toBe(true)
    expect(schema.safeParse({ ...ok, model: "openai/some-huge-model" }).success).toBe(false)
    expect(schema.safeParse({ ...ok, estimateUsd: 0 }).success).toBe(false)
    expect(schema.safeParse({ ...ok, estimateUsd: 500 }).success).toBe(false)
  })

  test("the stub behind approval calls no model and says it is not wired", async () => {
    const result = await stubRunner.run({
      question: "q",
      model: "anthropic/claude-sonnet-5.5",
      estimateUsd: 0.5,
    })
    expect(result.status).toBe("not-wired")
  })
})

describe("who may approve a bigger model", () => {
  test("a listed founder may approve", async () => {
    vi.stubEnv("AGENT_FOUNDER_PRINCIPALS", "slack:T0:UFOUNDER, slack:T0:UOTHER")
    expect(await founderOnly(response("approve", "slack:T0:UFOUNDER"))).toEqual({
      status: "allowed",
    })
  })

  test("another workspace member is refused and the request stays open", async () => {
    vi.stubEnv("AGENT_FOUNDER_PRINCIPALS", "slack:T0:UFOUNDER")
    const verdict = await founderOnly(response("approve", "slack:T0:USTRANGER"))
    expect(verdict.status).toBe("rejected")
  })

  test("with no founders listed nobody can approve", async () => {
    vi.stubEnv("AGENT_FOUNDER_PRINCIPALS", "")
    expect((await founderOnly(response("approve", "slack:T0:UFOUNDER"))).status).toBe("rejected")
    expect((await founderOnly(response("approve", "local-dev"))).status).toBe("rejected")
  })

  test("anyone may dismiss the request", async () => {
    vi.stubEnv("AGENT_FOUNDER_PRINCIPALS", "slack:T0:UFOUNDER")
    expect(await founderOnly(response("deny", "slack:T0:USTRANGER"))).toEqual({ status: "allowed" })
  })
})
