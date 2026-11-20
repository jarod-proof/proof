import { decide as eveDecide } from "eve/ai"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { HqClient } from "#lib/hq/client.js"
import { MODELS } from "#lib/models.js"
import { DECISION_ESTIMATE_USD } from "#lib/spend/cap.js"
import {
  createSpendHooks,
  EMPTY_SPEND_STATE,
  type SpendState,
  type SpendStore,
} from "#lib/spend/hooks.js"
import {
  createMeteredDecide,
  meteredDecide,
  meteredDecideDeps,
  spendLedger,
} from "#lib/spend/ledger.js"

/**
 * The decision-model wrapper itself, with the eve `decide()` replaced by a fake that is passed in
 * (no module mocking): the wrapper must return the call's answer and add its cost to the ledger.
 * A wrapper that stops metering fails these, which the source-text checks in metering.test.ts
 * cannot see.
 */
type Recorded = Parameters<HqClient["recordSpend"]>[0]

const setup = (state: Partial<SpendState> = {}) => {
  let current: SpendState = { ...EMPTY_SPEND_STATE, ...state }
  const store: SpendStore = {
    get: () => current,
    update: (fn) => {
      current = fn(current)
    },
  }
  const sent: Recorded[] = []
  const hq = {
    recordSpend: (input: Recorded) => {
      sent.push(input)
      return Promise.resolve({ id: "x", amountUsd: 0, estimated: false })
    },
  } as HqClient
  const ledger = createSpendHooks({
    hq: () => hq,
    store,
    estimateUsd: () => 0.1,
    modelId: () => "chat-model",
  })
  const answer = { answers: { team: { choice: "support" } } }
  let calls = 0
  const fakeDecide = (usage?: { costUsd?: number }) =>
    (() => {
      calls += 1
      return Promise.resolve({ ...answer, usage })
    }) as never
  return { store, sent, ledger, fakeDecide, calls: () => calls }
}

const metered = (ledger: ReturnType<typeof setup>["ledger"], decide: never) =>
  createMeteredDecide({ decide, ledger, model: "decision-model" })

describe("meteredDecide", () => {
  test("a build's decision call returns its answer and is recorded as build spend at the estimate", async () => {
    const t = setup()
    const decide = metered(t.ledger, t.fakeDecide({}))({ build: true })
    const result = await decide({} as never)
    expect(result).toMatchObject({ answers: { team: { choice: "support" } } })
    expect(t.sent).toEqual([
      {
        runId: undefined,
        source: "build",
        amountUsd: undefined,
        estimatedUsd: DECISION_ESTIMATE_USD,
        model: "decision-model",
      },
    ])
  })

  test("a reported cost is recorded as the cost, not the estimate", async () => {
    const t = setup()
    await metered(t.ledger, t.fakeDecide({ costUsd: 0.05 }))({ build: true })({} as never)
    expect(t.sent).toEqual([
      {
        runId: undefined,
        source: "build",
        amountUsd: 0.05,
        estimatedUsd: undefined,
        model: "decision-model",
      },
    ])
  })

  test("inside an open chat turn the call joins the turn's sum and nothing is sent yet", async () => {
    const t = setup({ kind: "eve", holdId: "hold-1", settled: false, estimateUsd: 0.1 })
    await metered(t.ledger, t.fakeDecide({}))()({} as never)
    expect(t.sent).toEqual([])
    expect(t.store.get().extraEstimatedUsd).toBeCloseTo(DECISION_ESTIMATE_USD, 6)
    await metered(t.ledger, t.fakeDecide({ costUsd: 0.05 }))()({} as never)
    expect(t.store.get().knownUsd).toBeCloseTo(0.05, 6)
    expect(t.store.get().withCost).toBe(1)
  })

  test("a call that throws is not swallowed and is charged the decision estimate, once", async () => {
    const t = setup()
    const failing = (() => Promise.reject(new Error("the provider refused"))) as never
    await expect(metered(t.ledger, failing)({ build: true })({} as never)).rejects.toThrow(
      "the provider refused",
    )
    // It may have emitted its usage record before it failed (that record is skipped against the
    // announcement), so the failed call is charged at the estimate, not dropped.
    expect(t.sent).toEqual([
      {
        runId: undefined,
        source: "build",
        amountUsd: undefined,
        estimatedUsd: DECISION_ESTIMATE_USD,
        model: "decision-model",
      },
    ])
    expect(t.store.get().extraEstimatedUsd).toBe(0)
    expect(t.store.get().decisionCredits).toBe(0)
  })

  test("metering that fails never fails the call: the answer is still returned", async () => {
    const t = setup()
    const broken = { decisionSpent: () => Promise.reject(new Error("hq is down")) }
    const decide = createMeteredDecide({
      decide: t.fakeDecide({}),
      ledger: broken,
      model: "decision-model",
    })
    const result = await decide({ build: true })({} as never)
    expect(result).toMatchObject({ answers: { team: { choice: "support" } } })
  })
})

/**
 * The production binding: `meteredDecide` is what triage, CI diagnosis and pretriage call. The
 * wrapper tests above build their own instance, so they cannot see this one swapped for eve's bare
 * `decide` or given a no-op ledger. Nothing here reaches a model: the real `decide` is replaced
 * with a spy on the deps object (`createMeteredDecide` reads it on every call) and the real
 * ledger's `decisionSpent` is spied, so no hq client is touched.
 */
describe("the production meteredDecide", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test("is built from eve's real decide, the agent's ledger and the decision model", () => {
    expect(meteredDecideDeps.decide).toBe(eveDecide)
    expect(meteredDecideDeps.ledger).toBe(spendLedger)
    expect(meteredDecideDeps.model).toBe(MODELS.decision)
  })

  test("is the wrapper, not eve's bare decide", () => {
    // Checked before any call so a bare `decide` is never invoked.
    expect(meteredDecide()).not.toBe(eveDecide)
    expect(meteredDecide({ build: true })).not.toBe(eveDecide)
  })

  test("calls the deps' decide and records the call on the deps' ledger", async () => {
    const answer = { answers: { team: { choice: "support" } }, usage: { costUsd: 0.05 } }
    const underlying = vi.spyOn(meteredDecideDeps, "decide").mockResolvedValue(answer as never)
    const recorded = vi.spyOn(spendLedger, "decisionSpent").mockResolvedValue(undefined)

    const result = await meteredDecide({ build: true })({} as never)

    expect(result).toBe(answer)
    expect(underlying).toHaveBeenCalledTimes(1)
    expect(recorded).toHaveBeenCalledExactlyOnceWith({
      costUsd: 0.05,
      model: MODELS.decision,
      build: true,
    })
  })
})
