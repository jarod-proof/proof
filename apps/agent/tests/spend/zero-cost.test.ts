import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import type { HqClient } from "#lib/hq/client.js"
import { DECISION_ESTIMATE_USD } from "#lib/spend/cap.js"
import { createMeteredDecide } from "#lib/spend/ledger.js"
import {
  createSpendHooks,
  EMPTY_SPEND_STATE,
  type SpendHookContext,
  type SpendState,
  type SpendStore,
  type UsageEvent,
} from "#lib/spend/hooks.js"
import { tokenFloorUsd } from "#lib/spend/prices.js"
import { CALLERS } from "../helpers.js"
import { createHqFixture, type HqFixture } from "../hq/hq-fixture.js"

/**
 * A model that reports `costUsd: 0` must not make the daily cap inert. The real-service spike saw
 * the gateway report $0 on every haiku-5.5 call carrying ~12,000 input tokens. Against hq itself
 * (its real reservation arithmetic and ledger on PGlite): a zero cost is priced at the token
 * floor (`agent/lib/spend/prices.ts`), a missing cost never falls below its estimate, a positive
 * cost stands, and a decision call is counted once.
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

const HAIKU = "anthropic/claude-haiku-5.5"
/** A model id deliberately absent from the price table: it is priced at the unknown-model default. */
const NOT_IN_THE_TABLE = "test/model-not-in-the-price-table"

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
    occurrence: { idempotencyKey: key ?? `zero-key-${++keySeq}` },
    cancel,
  }
  return { ctx, cancel }
}

const hooksFor = (model: string, client: () => HqClient = () => hq.client) => {
  const store = memoryStore()
  return {
    store,
    hooks: createSpendHooks({
      hq: client,
      store,
      estimateUsd: () => 0.1,
      modelId: () => model,
      decisionModelId: () => NOT_IN_THE_TABLE,
    }),
  }
}

const usage = (data: UsageEvent["data"]): UsageEvent => ({ data })

/** What the gateway sent on every haiku call: no cost, ~12,000 input tokens. */
const ZERO_COST_TURN = { costUsd: 0, inputTokens: 12_000, outputTokens: 0 } as const

const allowance = () => hq.client.getSpendAllowance()

const runCost = async () => (await hq.asAgent("GET", "/v1/runs")).body.runs?.[0]

type Hooks = ReturnType<typeof hooksFor>["hooks"]

/** One whole chat turn whose single model call reports `usageRecord`; true when it was let run. */
async function turn(hooks: Hooks, usageRecord: UsageEvent["data"]): Promise<boolean> {
  const start = context()
  await hooks.turnStarted({}, start.ctx)
  if (start.cancel.mock.calls.length > 0) {
    return false
  }
  await hooks.usageRecorded(usage(usageRecord), context().ctx)
  await hooks.turnSettled({ data: { outcome: "completed" } }, context().ctx)
  return true
}

describe("zero-cost turns trip the daily cap", () => {
  test("a model that reports costUsd 0 on 12,000 input tokens a turn trips $10/day, within 40 turns", async () => {
    const { hooks, store } = hooksFor(NOT_IN_THE_TABLE)
    const perTurn = tokenFloorUsd(NOT_IN_THE_TABLE, ZERO_COST_TURN)
    expect(perTurn).toBe(0.3)

    let refusedAt: number | undefined
    for (let i = 1; i <= 40 && refusedAt === undefined; i++) {
      if (
        !(await turn(hooks, { kind: "model", owner: { runId: `run_${i}` }, usage: ZERO_COST_TURN }))
      ) {
        refusedAt = i
      }
    }

    // 33 turns at $0.30 leave $0.10, which the 34th's $0.10 hold still fits; the 35th is refused.
    expect(refusedAt).toBe(35)
    const today = await allowance()
    expect(today.spentUsd).toBeCloseTo(34 * perTurn, 4)
    expect(today.spentUsd).toBeGreaterThanOrEqual(10)
    expect(today.reservedUsd).toBe(0)
    expect(store.state().refusal).toEqual({ remainingUsd: 0, unavailable: false })
  }, 60_000)

  test("the spike's real haiku-5.5 call (cache and output tokens too) is never charged $0", async () => {
    const { hooks } = hooksFor(HAIKU)
    const call = {
      costUsd: 0,
      inputTokens: 12_039,
      outputTokens: 24,
      cacheReadTokens: 11_926,
      cacheWriteTokens: 109,
    }
    expect(await turn(hooks, { kind: "model", owner: { runId: "run_0" }, usage: call })).toBe(true)
    expect((await allowance()).spentUsd).toBeCloseTo(tokenFloorUsd(HAIKU, call), 6)
    expect((await allowance()).spentUsd).toBeGreaterThan(0)
  })
})

/** hq as the hooks see it, with every settle and every record_spend logged in order. */
const loggedClient = () => {
  const calls: {
    call: "settle" | "record"
    input: Record<string, unknown>
    spentBefore: number
  }[] = []
  const client: HqClient = {
    ...hq.client,
    settleSpend: async (input) => {
      calls.push({ call: "settle", input, spentBefore: (await allowance()).spentUsd })
      return hq.client.settleSpend(input)
    },
    recordSpend: async (input) => {
      calls.push({ call: "record", input, spentBefore: (await allowance()).spentUsd })
      return hq.client.recordSpend(input)
    },
  }
  return { client, calls }
}

describe("a zero cost is priced at its token floor: estimated, never settled as exact, never at zero", () => {
  test("a zero-cost haiku turn in a hold settles at reported 0 and records one estimated floor", async () => {
    const { client, calls } = loggedClient()
    const { hooks } = hooksFor(HAIKU, () => client)
    await turn(hooks, { kind: "model", usage: ZERO_COST_TURN })
    const settles = calls.filter((c) => c.call === "settle")
    const records = calls.filter((c) => c.call === "record")
    // The hold closes at the reported part, 0 (not undefined, which would settle at 0.10)...
    expect(settles).toHaveLength(1)
    expect(settles[0]?.input).toMatchObject({ amountUsd: 0 })
    // ...and the floor is one estimated record beside it: the day is charged the floor, once.
    expect(records).toHaveLength(1)
    expect(records[0]?.input).toMatchObject({ source: "eve", estimatedUsd: 0.0012 })
    expect(records[0]?.input.amountUsd).toBeUndefined()
    const today = await allowance()
    expect(today.spentUsd).toBeCloseTo(0.0012, 6)
    expect(today.reservedUsd).toBe(0)
    const run = await runCost()
    expect(run?.costUsd).toBeCloseTo(0.0012, 6)
    expect(run?.costEstimated).toBe(true)
  })

  test("the floor is written before the hold closes, so the day's spend never dips", async () => {
    const { client, calls } = loggedClient()
    const { hooks } = hooksFor(HAIKU, () => client)
    await turn(hooks, { kind: "model", usage: ZERO_COST_TURN })
    expect(calls.map((c) => c.call)).toEqual(["record", "settle"])
    // When the hold closed, the floor was already in the ledger.
    expect(calls[1]?.spentBefore).toBeCloseTo(0.0012, 6)
  })

  test("on an unlisted model a zero-cost turn is settled at 0 and recorded estimated at 0.30", async () => {
    const { client, calls } = loggedClient()
    const { hooks } = hooksFor(NOT_IN_THE_TABLE, () => client)
    await turn(hooks, { kind: "model", usage: ZERO_COST_TURN })
    expect(calls.find((c) => c.call === "settle")?.input).toMatchObject({ amountUsd: 0 })
    expect(calls.filter((c) => c.call === "record").map((c) => c.input.estimatedUsd)).toEqual([0.3])
    const today = await allowance()
    expect(today.spentUsd).toBeCloseTo(0.3, 4)
    expect(today.spentUsd).toBeGreaterThan(0)
    expect(today.reservedUsd).toBe(0)
    expect((await runCost())?.costEstimated).toBe(true)
  })

  test("a floor beside a reported cost: the hold settles at the reported part, the floor is estimated", async () => {
    const { client, calls } = loggedClient()
    const { hooks } = hooksFor(NOT_IN_THE_TABLE, () => client)
    await hooks.turnStarted({}, context().ctx)
    await hooks.usageRecorded(usage({ kind: "model", usage: { costUsd: 0.05 } }), context().ctx)
    await hooks.usageRecorded(
      usage({ kind: "model", owner: { callId: "station" }, usage: ZERO_COST_TURN }),
      context().ctx,
    )
    await hooks.turnSettled({ data: { outcome: "completed" } }, context().ctx)
    expect(calls.find((c) => c.call === "settle")?.input).toMatchObject({ amountUsd: 0.05 })
    expect(calls.filter((c) => c.call === "record").map((c) => c.input)).toMatchObject([
      { estimatedUsd: 0.3 },
    ])
    expect((await allowance()).spentUsd).toBeCloseTo(0.35, 4)
  })

  test("a positive reported cost still settles the hold exact, with nothing estimated", async () => {
    const { client, calls } = loggedClient()
    const { hooks } = hooksFor(HAIKU, () => client)
    await turn(hooks, { kind: "model", usage: { ...ZERO_COST_TURN, costUsd: 0.03 } })
    expect(calls.map((c) => c.call)).toEqual(["settle"])
    expect(calls[0]?.input).toMatchObject({ amountUsd: 0.03 })
    expect((await allowance()).spentUsd).toBeCloseTo(0.03, 4)
    expect((await runCost())?.costEstimated).toBe(false)
  })

  test("a turn with nothing at all still settles at its estimate, as before", async () => {
    const { client, calls } = loggedClient()
    const { hooks } = hooksFor(HAIKU, () => client)
    await hooks.turnStarted({}, context().ctx)
    await hooks.turnSettled({ data: { outcome: "cancelled" } }, context().ctx)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input.amountUsd).toBeUndefined()
    expect((await allowance()).spentUsd).toBeCloseTo(0.1, 4)
  })

  test("costUsd 0 with no tokens is an unreported cost: the turn settles at its estimate, estimated", async () => {
    const { hooks } = hooksFor(HAIKU)
    await turn(hooks, { kind: "model", usage: { costUsd: 0 } })
    expect((await allowance()).spentUsd).toBeCloseTo(0.1, 4)
    expect((await runCost())?.costEstimated).toBe(true)
    hq.newDay()
    await turn(hooks, {
      kind: "model",
      usage: {
        costUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    })
    expect((await allowance()).spentUsd).toBeCloseTo(0.1, 4)
  })

  test("two zero-cost records in one turn each count at their floor", async () => {
    const { hooks } = hooksFor(NOT_IN_THE_TABLE)
    await hooks.turnStarted({}, context().ctx)
    await hooks.usageRecorded(usage({ kind: "model", usage: ZERO_COST_TURN }), context().ctx)
    await hooks.usageRecorded(
      usage({ kind: "model", owner: { callId: "station" }, usage: ZERO_COST_TURN }),
      context().ctx,
    )
    await hooks.turnSettled({ data: { outcome: "completed" } }, context().ctx)
    expect((await allowance()).spentUsd).toBeCloseTo(0.6, 4)
  })

  test("zero-cost usage after the turn settled is recorded estimated at its floor, not lost", async () => {
    const { hooks } = hooksFor(NOT_IN_THE_TABLE)
    await hooks.turnStarted({}, context().ctx)
    await hooks.turnSettled({ data: { outcome: "completed" } }, context().ctx)
    await hooks.usageRecorded(
      usage({ kind: "delegated-late", usage: ZERO_COST_TURN }),
      context().ctx,
    )
    // The turn's own hold settled at its estimate (0.10); the late zero-cost call adds its floor.
    expect((await allowance()).spentUsd).toBeCloseTo(0.1 + 0.3, 4)
  })

  test("a build's zero-cost call is recorded as build spend at its floor, outside the cap", async () => {
    const build = hooksFor(NOT_IN_THE_TABLE)
    await build.hooks.turnStarted({}, context(CALLERS.autonomous).ctx)
    await build.hooks.usageRecorded(
      usage({ kind: "model", usage: ZERO_COST_TURN }),
      context(CALLERS.autonomous).ctx,
    )
    // Build spend is outside the eve cap: today's eve spend did not move.
    expect((await allowance()).spentUsd).toBe(0)
    expect((await runCost())?.costUsd).toBeCloseTo(0.3, 4)
    expect((await runCost())?.costEstimated).toBe(true)
  })
})

describe("the positive and the missing cost paths are unchanged, only never lower", () => {
  test("a positive reported cost stands, even below the token floor", async () => {
    const { hooks } = hooksFor(NOT_IN_THE_TABLE)
    await turn(hooks, { kind: "model", usage: { ...ZERO_COST_TURN, costUsd: 0.0005 } })
    expect((await allowance()).spentUsd).toBeCloseTo(0.0005, 6)
    expect((await runCost())?.costEstimated).toBe(false)
  })

  test("a missing cost with few tokens still settles at the estimate, estimated", async () => {
    const { hooks } = hooksFor(HAIKU)
    await turn(hooks, { kind: "model", usage: { inputTokens: 500, outputTokens: 20 } })
    expect((await allowance()).spentUsd).toBeCloseTo(0.1, 4)
    expect((await runCost())?.costEstimated).toBe(true)
  })

  test("a missing cost whose tokens cost more than the estimate settles at the floor, estimated", async () => {
    const { hooks } = hooksFor(NOT_IN_THE_TABLE)
    await turn(hooks, { kind: "model", usage: { inputTokens: 12_000, outputTokens: 0 } })
    expect((await allowance()).spentUsd).toBeCloseTo(0.3, 4)
    expect((await runCost())?.costEstimated).toBe(true)
  })
})

describe("each decision call is counted once", () => {
  /** eve's `decide()` result: tokens, no cost. */
  const answer = {
    answers: { team: { choice: "support" } },
    usage: { inputTokens: 1_313, outputTokens: 40, totalTokens: 1_353 },
  }
  const decisionTokens = { inputTokens: 1_313, outputTokens: 40 }
  /** The metered call is charged at this: the decision estimate, or its token floor if larger. */
  const decisionFloor = tokenFloorUsd(NOT_IN_THE_TABLE, decisionTokens)
  const meteredCharge = Math.max(DECISION_ESTIMATE_USD, decisionFloor)
  /** What eve's `decide()` emits: owner null, kind "decision", the gateway's cost. */
  const decisionRecord = (costUsd: number) =>
    usage({ kind: "decision", owner: null, usage: { costUsd, ...decisionTokens } })

  /** `decide()` as eve runs it in a session: the usage record is emitted before it returns. */
  const decideEmitting = (hooks: Hooks, costUsd = 0.0001313, when: "during" | "after" = "during") =>
    (async () => {
      if (when === "during") {
        await hooks.usageRecorded(decisionRecord(costUsd), context().ctx)
      }
      return answer
    }) as never

  const meteredOn = (hooks: Hooks, decide: never) =>
    createMeteredDecide({ decide, ledger: hooks, model: NOT_IN_THE_TABLE })

  test("a metered call and the record eve emits for it add one charge, not two", async () => {
    expect(decisionFloor).toBeGreaterThan(DECISION_ESTIMATE_USD)
    for (const when of ["during", "after"] as const) {
      hq.newDay()
      const { hooks } = hooksFor(HAIKU)
      await hooks.turnStarted({}, context().ctx)
      await hooks.usageRecorded(usage({ kind: "model", usage: { costUsd: 0.03 } }), context().ctx)
      await meteredOn(hooks, decideEmitting(hooks, 0.0001313, when))()({} as never)
      if (when === "after") {
        // The record arrives after the wrapper has returned: it still finds the announcement.
        await hooks.usageRecorded(decisionRecord(0.0001313), context().ctx)
      }
      await hooks.turnSettled({ data: { outcome: "completed" } }, context().ctx)
      expect((await allowance()).spentUsd, when).toBeCloseTo(0.03 + meteredCharge, 4)
    }
  })

  test("two parallel metered calls skip two records, and a third unannounced record is counted", async () => {
    const { hooks } = hooksFor(HAIKU)
    await hooks.turnStarted({}, context().ctx)
    const decide = meteredOn(hooks, decideEmitting(hooks))
    await Promise.all([decide()({} as never), decide()({} as never)])
    // eve's own decide() (LLM tool approval, say): nobody announced it, so it is counted.
    await hooks.usageRecorded(decisionRecord(0.05), context().ctx)
    await hooks.turnSettled({ data: { outcome: "completed" } }, context().ctx)
    expect((await allowance()).spentUsd).toBeCloseTo(2 * meteredCharge + 0.05, 4)
  })

  test("a decision record nobody announced (eve's own decide) is counted, at its floor when it reports 0", async () => {
    const { hooks } = hooksFor(HAIKU)
    await hooks.turnStarted({}, context().ctx)
    await hooks.usageRecorded(decisionRecord(0), context().ctx)
    await hooks.turnSettled({ data: { outcome: "completed" } }, context().ctx)
    // Priced as the decision model (here an unlisted one, at the conservative price): never zero.
    expect((await allowance()).spentUsd).toBeCloseTo(decisionFloor, 4)
  })

  test("a metered call that throws before any record is charged the estimate and leaves no announcement", async () => {
    const { hooks, store } = hooksFor(HAIKU)
    await hooks.turnStarted({}, context().ctx)
    const failing = (() => Promise.reject(new Error("the provider refused"))) as never
    await expect(meteredOn(hooks, failing)()({} as never)).rejects.toThrow("the provider refused")
    expect(store.state().decisionCredits).toBe(0)
    // A record nobody announced is still counted: the abandoned call left no credit to swallow it.
    await hooks.usageRecorded(decisionRecord(0.05), context().ctx)
    await hooks.turnSettled({ data: { outcome: "completed" } }, context().ctx)
    expect((await allowance()).spentUsd).toBeCloseTo(0.05 + DECISION_ESTIMATE_USD, 4)
  })

  test("a call that emits its record and then throws is charged exactly once, at the estimate", async () => {
    const { hooks, store } = hooksFor(HAIKU)
    await hooks.turnStarted({}, context().ctx)
    await hooks.usageRecorded(usage({ kind: "model", usage: { costUsd: 0.03 } }), context().ctx)
    const emitsThenThrows = (async () => {
      await hooks.usageRecorded(decisionRecord(0.0001313), context().ctx)
      throw new Error("the answer did not parse")
    }) as never
    await expect(meteredOn(hooks, emitsThenThrows)()({} as never)).rejects.toThrow(
      "the answer did not parse",
    )
    expect(store.state().decisionCredits).toBe(0)
    await hooks.turnSettled({ data: { outcome: "completed" } }, context().ctx)
    // The record consumed the announcement and was skipped; the failed call is charged once.
    expect((await allowance()).spentUsd).toBeCloseTo(0.03 + DECISION_ESTIMATE_USD, 4)
  })

  test("a state saved before announcements existed (no decisionCredits) still works", async () => {
    const { hooks, store } = hooksFor(HAIKU)
    await hooks.turnStarted({}, context().ctx)
    expect(store.state().decisionCredits).toBeUndefined()
    await hooks.usageRecorded(decisionRecord(0.05), context().ctx)
    expect(store.state().withCost).toBe(1)
    expect(store.state().knownUsd).toBeCloseTo(0.05, 6)
  })

  test("in a build turn the metered call and its record are one build charge", async () => {
    const sent: Parameters<HqClient["recordSpend"]>[0][] = []
    const recorder = {
      recordSpend: (input: Parameters<HqClient["recordSpend"]>[0]) => {
        sent.push(input)
        return Promise.resolve({ id: "x", amountUsd: 0, estimated: false })
      },
      recordRun: () => Promise.resolve({ id: "run-1" }),
    } as unknown as HqClient
    const { hooks } = hooksFor(HAIKU, () => recorder)
    await hooks.turnStarted({}, context(CALLERS.autonomous).ctx)
    await meteredOn(hooks, decideEmitting(hooks))()({} as never)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ source: "build", estimatedUsd: meteredCharge })
  })

  test("a pretriage call (build: true) is announced too: its record is skipped, the call recorded once", async () => {
    const sent: Parameters<HqClient["recordSpend"]>[0][] = []
    const recorder = {
      recordSpend: (input: Parameters<HqClient["recordSpend"]>[0]) => {
        sent.push(input)
        return Promise.resolve({ id: "x", amountUsd: 0, estimated: false })
      },
      recordRun: () => Promise.resolve({ id: "run-1" }),
    } as unknown as HqClient
    const { hooks, store } = hooksFor(HAIKU, () => recorder)
    // Pretriage is a dynamic instruction eve resolves inside a model step, in the build's turn.
    await hooks.turnStarted({}, context(CALLERS.autonomous).ctx)
    await meteredOn(hooks, decideEmitting(hooks))({ build: true })({} as never)
    expect(store.state().decisionCredits).toBe(0)
    expect(sent).toEqual([
      {
        runId: undefined,
        source: "build",
        amountUsd: undefined,
        estimatedUsd: meteredCharge,
        model: NOT_IN_THE_TABLE,
      },
    ])
  })
})

describe("usage with no owner", () => {
  test("a record whose owner is null is counted once, at its floor, and does not crash", async () => {
    const { hooks } = hooksFor(NOT_IN_THE_TABLE)
    await hooks.turnStarted({}, context().ctx)
    const key = "null-owner-1"
    const record = usage({ kind: "model", owner: null, usage: ZERO_COST_TURN })
    await expect(hooks.usageRecorded(record, context(CALLERS.untrusted, key).ctx)).resolves.toBe(
      undefined,
    )
    // The same event delivered again (hooks are not exactly-once) adds nothing.
    await hooks.usageRecorded(record, context(CALLERS.untrusted, key).ctx)
    await hooks.turnSettled({ data: { outcome: "completed" } }, context().ctx)
    expect((await allowance()).spentUsd).toBeCloseTo(0.3, 4)
  })

  test("a null-owner record with no open hold (cache warming) is recorded once, not lost", async () => {
    const { hooks } = hooksFor(NOT_IN_THE_TABLE)
    const late = context(CALLERS.untrusted, "null-owner-late")
    const record = usage({ kind: "model", owner: null, usage: ZERO_COST_TURN })
    await hooks.usageRecorded(record, late.ctx)
    await hooks.usageRecorded(record, late.ctx)
    expect((await allowance()).spentUsd).toBeCloseTo(0.3, 4)
  })
})
