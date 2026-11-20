import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import type { HqClient } from "#lib/hq/client.js"
import { checkCap, DECISION_ESTIMATE_USD, refusalText, turnEstimateUsd } from "#lib/spend/cap.js"
import {
  classify,
  createSpendHooks,
  EMPTY_SPEND_STATE,
  inCalls,
  settlementOf,
  type SpendHookContext,
  type SpendState,
  type SpendStore,
} from "#lib/spend/hooks.js"
import { CALLERS } from "../helpers.js"
import { createHqFixture, type HqFixture } from "../hq/hq-fixture.js"

/**
 * The daily cap and the ledger against hq itself (its real reservation arithmetic and ledger on
 * PGlite). hq's own tests prove the race and the arithmetic; these prove the agent asks, obeys a
 * refusal before any model call, and never loses or zeroes a cost.
 */
let hq: HqFixture

beforeAll(async () => {
  hq = await createHqFixture()
}, 60_000)

afterAll(async () => {
  await hq.close()
})

beforeEach(() => {
  hq.newDay()
})

const memoryStore = (): SpendStore & { state: () => SpendState } => {
  let state: SpendState = { ...EMPTY_SPEND_STATE }
  return {
    get: () => state,
    update: (fn) => {
      state = fn(state)
    },
    state: () => state,
  }
}

let keySeq = 0
const context = (auth = CALLERS.untrusted, key?: string) => {
  const cancel = vi.fn<(reason?: string) => void>()
  const ctx: SpendHookContext = {
    session: { id: "session_1", auth: { current: auth } },
    channel: { kind: "channel:slack" },
    occurrence: { idempotencyKey: key ?? `key-${++keySeq}` },
    cancel,
  }
  return { ctx, cancel }
}

const hooksOn = (client: () => HqClient, store = memoryStore()) => ({
  store,
  hooks: createSpendHooks({
    hq: client,
    store,
    estimateUsd: () => 0.1,
    modelId: () => "test-model",
  }),
})

/** Spends `amountUsd` of today's eve cap, as a finished turn would have. */
const spendToday = (amountUsd: number) =>
  hq.client.recordSpend({ source: "eve", amountUsd, model: "setup" })

const allowance = () => hq.client.getSpendAllowance()

const runCost = async () => {
  const runs = await hq.asAgent("GET", "/v1/runs")
  return runs.body.runs?.[0]
}

describe("the turn estimate", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test("is 0.10 unless set; a sensible value is used; a too-large one is clamped to 5, not ignored", () => {
    expect(turnEstimateUsd()).toBe(0.1)
    vi.stubEnv("AGENT_TURN_ESTIMATE_USD", "0.25")
    expect(turnEstimateUsd()).toBe(0.25)
    vi.stubEnv("AGENT_TURN_ESTIMATE_USD", "20")
    expect(turnEstimateUsd()).toBe(5)
    for (const bad of ["abc", "0", "-1", ""]) {
      vi.stubEnv("AGENT_TURN_ESTIMATE_USD", bad)
      expect(turnEstimateUsd()).toBe(0.1)
    }
  })
})

describe("checkCap", () => {
  test("allows when remaining exceeds the estimate", async () => {
    await spendToday(9.5)
    const result = await checkCap(hq.client, 0.1)
    expect(result).toEqual({ allowed: true, holdId: expect.any(String) })
    expect((await allowance()).reservedUsd).toBeCloseTo(0.1, 4)
  })

  test("refuses at exactly 10.00 spent", async () => {
    await spendToday(10)
    const result = await checkCap(hq.client, 0.01)
    expect(result).toEqual({ allowed: false, remainingUsd: 0 })
    expect((await allowance()).reservedUsd).toBe(0)
  })

  test("a grant raises today's remaining", async () => {
    await spendToday(10)
    expect((await checkCap(hq.client, 0.5)).allowed).toBe(false)
    const grant = await hq.asFounder("POST", "/v1/spend/grants", {
      amountUsd: 5,
      reason: "launch day",
    })
    expect(grant.status).toBe(200)
    expect((await allowance()).remainingUsd).toBe(5)
    expect((await checkCap(hq.client, 0.5)).allowed).toBe(true)
  })

  test("an hq that cannot be asked is a refusal, never a pass", async () => {
    const down: Pick<HqClient, "reserveSpend"> = {
      reserveSpend: () => Promise.reject(new Error("connect ECONNREFUSED")),
    }
    expect(await checkCap(down, 0.1)).toEqual({
      allowed: false,
      remainingUsd: 0,
      unavailable: true,
    })
    const garbled: Pick<HqClient, "reserveSpend"> = {
      reserveSpend: () => Promise.resolve({ holdId: "" }),
    }
    expect((await checkCap(garbled, 0.1)).allowed).toBe(false)
  })
})

describe("the turn.started hook", () => {
  test("a refused reservation cancels the turn before any model call", async () => {
    await spendToday(10)
    const { hooks, store } = hooksOn(() => hq.client)
    const { ctx, cancel } = context()
    await hooks.turnStarted({}, ctx)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel.mock.calls[0]?.[0]).toContain("$0.00")
    expect(store.state().holdId).toBeNull()
    // Nothing was held, so no model call has anything to be paid from.
    expect((await allowance()).reservedUsd).toBe(0)
    // The refused run is closed as stopped.
    expect((await runCost())?.outcome).toBe("stopped")
  })

  test("an hq outage cancels the turn: the cap that cannot be checked is not skipped", async () => {
    const { hooks } = hooksOn(() => {
      throw new Error("HQ_BASE_URL is not set")
    })
    const { ctx, cancel } = context()
    await hooks.turnStarted({}, ctx)
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(cancel.mock.calls[0]?.[0]).toBe(refusalText({ remainingUsd: 0, unavailable: true }))
  })

  test("an allowed turn holds its estimate and is not cancelled", async () => {
    const { hooks, store } = hooksOn(() => hq.client)
    const { ctx, cancel } = context()
    await hooks.turnStarted({}, ctx)
    expect(cancel).not.toHaveBeenCalled()
    expect(store.state().holdId).toEqual(expect.any(String))
    expect((await allowance()).reservedUsd).toBeCloseTo(0.1, 4)
  })

  test("every caller is capped except the unattended build principal", () => {
    expect(classify(CALLERS.untrusted)).toBe("eve")
    expect(classify(CALLERS.trusted)).toBe("eve")
    expect(classify(CALLERS.schedule)).toBe("eve")
    expect(classify(CALLERS.anonymous)).toBe("eve")
    // A pull request anyone opened gets a summary run: not a build, so it stays under the cap.
    expect(classify(CALLERS.summary)).toBe("eve")
    expect(classify(CALLERS.autonomous)).toBe("build")
    expect(classify(CALLERS.ticket)).toBe("build")
  })
})

describe("settling a turn", () => {
  test("a turn whose model call reports no costUsd settles at the estimate", async () => {
    const { hooks } = hooksOn(() => hq.client)
    const start = context()
    await hooks.turnStarted({}, start.ctx)
    await hooks.usageRecorded({ data: { kind: "model", usage: {} } }, context().ctx)
    await hooks.turnSettled({ data: { outcome: "completed" } }, context().ctx)

    const today = await allowance()
    expect(today.spentUsd).toBeCloseTo(0.1, 4)
    expect(today.reservedUsd).toBe(0)
    const run = await runCost()
    expect(run?.costUsd).toBeCloseTo(0.1, 4)
    expect(run?.costEstimated).toBe(true)
    expect(run?.outcome).toBe("succeeded")
  })

  test("the turn's usage is summed and settled once, at the real cost", async () => {
    const { hooks } = hooksOn(() => hq.client)
    await hooks.turnStarted({}, context().ctx)
    await hooks.usageRecorded({ data: { kind: "model", usage: { costUsd: 0.03 } } }, context().ctx)
    await hooks.usageRecorded(
      { data: { kind: "model", owner: { callId: "c1" }, usage: { costUsd: 0.045 } } },
      context().ctx,
    )
    await hooks.turnSettled({ data: { outcome: "completed" } }, context().ctx)
    const today = await allowance()
    expect(today.spentUsd).toBeCloseTo(0.075, 4)
    expect((await runCost())?.costEstimated).toBe(false)
  })

  test("a record without a cost is priced at the estimate beside what was reported, not at zero", async () => {
    const { hooks } = hooksOn(() => hq.client)
    await hooks.turnStarted({}, context().ctx)
    await hooks.usageRecorded({ data: { kind: "model", usage: { costUsd: 0.02 } } }, context().ctx)
    await hooks.usageRecorded({ data: { kind: "model", usage: {} } }, context().ctx)
    await hooks.turnSettled({ data: { outcome: "completed" } }, context().ctx)
    expect((await allowance()).spentUsd).toBeCloseTo(0.02 + 0.1, 4)
    expect((await runCost())?.costEstimated).toBe(true)
  })

  test("two records without a cost settle at $0.20, estimated: each is priced, not just the first", async () => {
    const { hooks } = hooksOn(() => hq.client)
    await hooks.turnStarted({}, context().ctx)
    await hooks.usageRecorded({ data: { kind: "model", usage: {} } }, context().ctx)
    await hooks.usageRecorded(
      { data: { kind: "model", owner: { callId: "station" }, usage: {} } },
      context().ctx,
    )
    await hooks.turnSettled({ data: { outcome: "completed" } }, context().ctx)
    const today = await allowance()
    expect(today.spentUsd).toBeCloseTo(0.2, 4)
    expect(today.reservedUsd).toBe(0)
    expect((await runCost())?.costEstimated).toBe(true)
  })

  test("N records without a cost price at N estimates, with or without a record that reported one", () => {
    const base = { ...EMPTY_SPEND_STATE, estimateUsd: 0.1 }
    // What a turn counts in the end: the hold's settlement (an unreported one is the estimate).
    const total = (state: SpendState) => {
      const { settleAt, excessUsd, estimatedUsd } = settlementOf(state)
      return (settleAt ?? state.estimateUsd) + excessUsd + estimatedUsd
    }
    for (const n of [1, 2, 3, 5]) {
      expect(total({ ...base, withoutCost: n }), `${n} unreported`).toBeCloseTo(n * 0.1, 6)
      // One record that reported $0.01 beside them: that cost, plus the same N estimates.
      expect(
        total({ ...base, withCost: 1, knownUsd: 0.01, withoutCost: n }),
        `${n} unreported beside one reported`,
      ).toBeCloseTo(0.01 + n * 0.1, 6)
    }
    // A decision call is an estimate of its own in either branch.
    expect(total({ ...base, withoutCost: 1, extraEstimatedUsd: 0.02 })).toBeCloseTo(0.12, 6)
  })

  test("$0.30 reported plus one record without a cost settles above $0.30, marked estimated", async () => {
    const { hooks } = hooksOn(() => hq.client)
    await hooks.turnStarted({}, context().ctx)
    await hooks.usageRecorded({ data: { kind: "model", usage: { costUsd: 0.3 } } }, context().ctx)
    await hooks.usageRecorded(
      { data: { kind: "model", owner: { callId: "station" }, usage: {} } },
      context().ctx,
    )
    await hooks.turnSettled({ data: { outcome: "completed" } }, context().ctx)
    const today = await allowance()
    expect(today.spentUsd).toBeGreaterThan(0.3)
    expect(today.spentUsd).toBeCloseTo(0.3 + 0.1, 4)
    expect(today.reservedUsd).toBe(0)
    expect((await runCost())?.costEstimated).toBe(true)
  })

  test("a decision-model call joins the turn at its estimate, marked estimated", async () => {
    const { hooks } = hooksOn(() => hq.client)
    await hooks.turnStarted({}, context().ctx)
    await hooks.usageRecorded({ data: { kind: "model", usage: { costUsd: 0.3 } } }, context().ctx)
    await hooks.decisionSpent({ model: "decision-model" })
    await hooks.turnSettled({ data: { outcome: "completed" } }, context().ctx)
    expect((await allowance()).spentUsd).toBeCloseTo(0.3 + DECISION_ESTIMATE_USD, 4)
    expect((await runCost())?.costEstimated).toBe(true)
  })

  test("a decision call before a build's first turn is recorded as build spend, outside the cap", async () => {
    const sent: Parameters<HqClient["recordSpend"]>[0][] = []
    const recorder = {
      recordSpend: (input: Parameters<HqClient["recordSpend"]>[0]) => {
        sent.push(input)
        return Promise.resolve({ id: "x", amountUsd: 0, estimated: false })
      },
    } as HqClient
    const { hooks } = hooksOn(() => recorder)
    await hooks.decisionSpent({ model: "decision-model", build: true })
    await hooks.decisionSpent({ model: "decision-model", costUsd: 0.05, build: true })
    expect(sent).toEqual([
      {
        runId: undefined,
        source: "build",
        amountUsd: undefined,
        estimatedUsd: DECISION_ESTIMATE_USD,
        model: "decision-model",
      },
      {
        runId: undefined,
        source: "build",
        amountUsd: 0.05,
        estimatedUsd: undefined,
        model: "decision-model",
      },
    ])
  })

  test("usage that arrives after the turn settled is recorded once, not lost", async () => {
    const { hooks } = hooksOn(() => hq.client)
    await hooks.turnStarted({}, context().ctx)
    await hooks.turnSettled({ data: { outcome: "completed" } }, context().ctx)
    const late = context(CALLERS.untrusted, "late-1")
    await hooks.usageRecorded(
      { data: { kind: "delegated-late", usage: { costUsd: 0.04 } } },
      late.ctx,
    )
    // The same event delivered again (hooks are not exactly-once) adds nothing.
    await hooks.usageRecorded(
      { data: { kind: "delegated-late", usage: { costUsd: 0.04 } } },
      late.ctx,
    )
    expect((await allowance()).spentUsd).toBeCloseTo(0.1 + 0.04, 4)
  })

  test("a cost over hq's per-call limit settles at the limit and records the rest: nothing is lost", async () => {
    expect(inCalls(2500.5)).toEqual([1000, 1000, 500.5])
    expect(inCalls(0.0123)).toEqual([0.0123])
    const { hooks } = hooksOn(() => hq.client)
    await hooks.turnStarted({}, context().ctx)
    await hooks.usageRecorded(
      { data: { kind: "model", usage: { costUsd: 1500.25 } } },
      context().ctx,
    )
    await hooks.turnSettled({ data: { outcome: "completed" } }, context().ctx)
    const today = await allowance()
    expect(today.spentUsd).toBeCloseTo(1500.25, 4)
    expect(today.reservedUsd).toBe(0)
    expect((await runCost())?.costUsd).toBeCloseTo(1500.25, 4)
  })

  test("a settle delivered twice does not settle twice", async () => {
    const { hooks } = hooksOn(() => hq.client)
    await hooks.turnStarted({}, context().ctx)
    const settled = context(CALLERS.untrusted, "settled-1")
    await hooks.turnSettled({ data: { outcome: "completed" } }, settled.ctx)
    await hooks.turnSettled({ data: { outcome: "completed" } }, settled.ctx)
    expect((await allowance()).spentUsd).toBeCloseTo(0.1, 4)
  })

  test("a failing hq never throws out of a hook and the held estimate still counts", async () => {
    const real = hooksOn(() => hq.client)
    await real.hooks.turnStarted({}, context().ctx)
    const broken = createSpendHooks({
      hq: () => {
        throw new Error("hq is down")
      },
      store: real.store,
      estimateUsd: () => 0.1,
      modelId: () => "test-model",
    })
    await expect(
      broken.usageRecorded({ data: { kind: "model", usage: { costUsd: 0.03 } } }, context().ctx),
    ).resolves.toBeUndefined()
    await expect(
      broken.turnSettled({ data: { outcome: "completed" } }, context().ctx),
    ).resolves.toBeUndefined()
    // The hold was never settled, so it still counts at its estimate: nothing is lost.
    expect((await allowance()).reservedUsd).toBeCloseTo(0.1, 4)
  })

  test("hq down at settle with a cost above the estimate: once hq is back the whole cost is in", async () => {
    let up = true
    const flaky = () => {
      if (!up) {
        throw new Error("hq is down")
      }
      return hq.client
    }
    const { hooks, store } = hooksOn(flaky)
    await hooks.turnStarted({}, context().ctx)
    await hooks.usageRecorded({ data: { kind: "model", usage: { costUsd: 2 } } }, context().ctx)
    up = false
    await hooks.turnSettled({ data: { outcome: "completed" } }, context().ctx)
    // The hold is parked to settle again, and the cost above it is parked to be recorded.
    expect(store.state().unsettled).toHaveLength(1)
    expect(store.state().pending).toHaveLength(1)
    up = true
    // The day's next hook of any kind flushes both. The probe is an announced decision record,
    // which adds no spend of its own: a bare zero-cost "model" record is priced now, never free.
    hooks.decisionExpected()
    await hooks.usageRecorded({ data: { kind: "decision", usage: { costUsd: 0 } } }, context().ctx)
    const today = await allowance()
    expect(today.reservedUsd).toBe(0)
    expect(today.spentUsd).toBeCloseTo(2, 4)
    expect(store.state().unsettled).toEqual([])
    expect(store.state().pending).toEqual([])
  })

  test("a settle whose reply was lost (then CONFLICT) still records the cost above $1000 once", async () => {
    let calls = 0
    const lossy: HqClient = {
      ...hq.client,
      settleSpend: async (input) => {
        calls += 1
        const reply = await hq.client.settleSpend(input)
        if (calls === 1) {
          throw new Error("the reply was lost")
        }
        return reply
      },
    }
    const { hooks } = hooksOn(() => lossy)
    await hooks.turnStarted({}, context().ctx)
    await hooks.usageRecorded(
      { data: { kind: "model", usage: { costUsd: 1500.25 } } },
      context().ctx,
    )
    await hooks.turnSettled({ data: { outcome: "completed" } }, context().ctx)
    expect(calls).toBe(2)
    const today = await allowance()
    expect(today.spentUsd).toBeCloseTo(1500.25, 4)
    expect(today.reservedUsd).toBe(0)
  })
})

describe("the model.requested guard", () => {
  const withTurn = (id: string) => ({ ...context().ctx, turn: { id } })

  test("a turn that ran turn.started and holds its estimate is let through", async () => {
    const { hooks } = hooksOn(() => hq.client)
    await hooks.turnStarted({}, withTurn("turn_0"))
    const call = context()
    hooks.modelRequested({}, { ...call.ctx, turn: { id: "turn_0" } })
    expect(call.cancel).not.toHaveBeenCalled()
  })

  test("a model call in a turn without turn.started's marker is cancelled", async () => {
    const { hooks } = hooksOn(() => hq.client)
    await hooks.turnStarted({}, withTurn("turn_0"))
    const call = context()
    hooks.modelRequested({}, { ...call.ctx, turn: { id: "turn_1" } })
    expect(call.cancel).toHaveBeenCalledTimes(1)
    const fresh = context()
    hooksOn(() => hq.client).hooks.modelRequested({}, { ...fresh.ctx, turn: { id: "turn_0" } })
    expect(fresh.cancel).toHaveBeenCalledTimes(1)
  })

  test("an eve turn that never got its hold is cancelled before the model call", async () => {
    // The state a crash between the marker and the reservation leaves: marked, no hold.
    const store = memoryStore()
    store.update(() => ({
      ...EMPTY_SPEND_STATE,
      kind: "eve" as const,
      turnId: "turn_0",
      settled: false,
    }))
    const { hooks } = hooksOn(() => hq.client, store)
    const call = context()
    hooks.modelRequested({}, { ...call.ctx, turn: { id: "turn_0" } })
    expect(call.cancel).toHaveBeenCalledTimes(1)
    // The thread is told why it is quiet.
    expect(store.state().refusal).toEqual({ remainingUsd: 0, unavailable: true })
  })
})

describe("unattended builds", () => {
  test("a build is not reserved against the cap and its cost is recorded as build spend", async () => {
    await spendToday(10)
    const { hooks } = hooksOn(() => hq.client)
    const { ctx, cancel } = context(CALLERS.autonomous)
    await hooks.turnStarted({}, ctx)
    expect(cancel).not.toHaveBeenCalled()
    await hooks.usageRecorded(
      { data: { kind: "model", usage: { costUsd: 0.4 } } },
      context(CALLERS.autonomous).ctx,
    )
    await hooks.usageRecorded(
      { data: { kind: "model", usage: {} } },
      context(CALLERS.autonomous).ctx,
    )
    const today = await allowance()
    // Build spend is outside the eve cap: the day is still at exactly 10.00.
    expect(today.spentUsd).toBe(10)
    expect(today.reservedUsd).toBe(0)
    const run = await runCost()
    expect(run?.costUsd).toBeCloseTo(0.4 + 0.25, 4)
    expect(run?.costEstimated).toBe(true)
  })
})
