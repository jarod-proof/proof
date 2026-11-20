import { decide } from "eve/ai"
import { hqFromEnv } from "../hq/env.js"
import { log } from "../log.js"
import { chatModelId, MODELS } from "../models.js"
import { turnEstimateUsd } from "./cap.js"
import { createSpendHooks } from "./hooks.js"
import { sessionSpendStore } from "./state.js"

/**
 * The one ledger the agent's hooks and tools share: eve's hooks (`agent/hooks/spend.ts`) and the
 * metered decision model (below) act on the same session state and the same hq key.
 */
export const spendLedger = createSpendHooks({
  hq: hqFromEnv,
  store: sessionSpendStore,
  estimateUsd: turnEstimateUsd,
  modelId: chatModelId,
  decisionModelId: () => MODELS.decision,
})

export interface MeteringDeps {
  /** The real `decide()`; a test passes a fake. */
  decide: typeof decide
  ledger: Pick<typeof spendLedger, "decisionSpent"> &
    Partial<Pick<typeof spendLedger, "decisionExpected" | "decisionAbandoned">>
  /** The decision model's name, recorded with the cost. */
  model: string
}

/** Runs a ledger bookkeeping call; it must never fail the decision call it surrounds. */
function callLedger(fn: () => void): void {
  try {
    fn()
  } catch (error) {
    log.warn("spend: could not track a decision call", error)
  }
}

/**
 * Wraps `decide()` so its cost is recorded, once. Inside a session (every call the agent makes runs
 * in one) eve's `decide()` also emits a `usage.recorded` of kind "decision" (owner null) carrying
 * the gateway's cost. This wrapper counts every decision call the agent makes
 * (inside a chat turn it joins the turn's sum, inside a build it is recorded as build spend), and
 * announces each call first (`decisionExpected`) so the record that call emits is skipped, not
 * counted a second time. A "decision" record nobody announced (eve's own `decide()`, for instance
 * LLM tool approval or auto model routing; the agent uses neither today) is still counted by the
 * usage hook. `build: true` marks pretriage, which is build spend (outside the cap, no run);
 * pretriage's `decide()` runs inside a session too, so its record is announced and counted once.
 *
 * - `decide()`'s result carries tokens and no cost, so the call is charged at the larger of the
 *   decision estimate and its token floor (`prices.ts`), which over-counts the gateway's own figure.
 *   A result that does carry `usage.costUsd` > 0 is charged at that cost.
 * - A call that throws is charged the decision estimate (it may have spent before it failed) and
 *   its error is not swallowed.
 * - Metering failing never fails the call: it is logged, and the call's answer is returned.
 */
export function createMeteredDecide(deps: MeteringDeps) {
  return (options: { build?: boolean } = {}): typeof decide =>
    (async (...args: Parameters<typeof decide>) => {
      // Announce the call first: the `usage.recorded` it emits can arrive before this returns, and
      // must find the announcement. Every call is announced, a pretriage call too: it runs in a
      // dynamic instruction that eve resolves inside a model step, which is inside the usage sink,
      // so it emits a record like any other (eve `harness/kernel.js` runs a step's stages under
      // `withUsageSink`, `harness/usage-sink.js` publishes `decide()`'s record to it).
      callLedger(() => deps.ledger.decisionExpected?.())
      let result: Awaited<ReturnType<typeof decide>>
      try {
        result = await deps.decide(...args)
      } catch (error) {
        // The call may have emitted its record before it failed (the record consumed the
        // announcement and was skipped), so a call that throws is charged the decision estimate: at
        // most $0.02 too much when it emitted nothing, never nothing for spend that happened.
        await meterDecision({ model: deps.model, build: options.build })
        callLedger(() => deps.ledger.decisionAbandoned?.())
        throw error
      }
      const usage = (result as { usage?: Record<string, unknown> }).usage
      const count = (value: unknown) => (typeof value === "number" ? value : undefined)
      await meterDecision({
        costUsd: count(usage?.costUsd),
        ...(count(usage?.inputTokens) !== undefined && { inputTokens: count(usage?.inputTokens) }),
        ...(count(usage?.outputTokens) !== undefined && {
          outputTokens: count(usage?.outputTokens),
        }),
        model: deps.model,
        build: options.build,
      })
      return result
    }) as typeof decide

  /** Records one decision call; metering that fails never fails the call. */
  async function meterDecision(input: Parameters<MeteringDeps["ledger"]["decisionSpent"]>[0]) {
    try {
      await deps.ledger.decisionSpent(input)
    } catch (error) {
      log.warn("spend: could not meter a decision call", error)
    }
  }
}

/**
 * What the production `meteredDecide` is built from: eve's real `decide()`, the agent's one ledger
 * and the decision model's name. Exported so a test can pin them by identity; `createMeteredDecide`
 * reads this object on every call, so the test can also replace a member and watch it being used.
 */
export const meteredDecideDeps: MeteringDeps = {
  decide,
  ledger: spendLedger,
  model: MODELS.decision,
}

/** `decide()` with its cost recorded, on the agent's real ledger. */
export const meteredDecide = createMeteredDecide(meteredDecideDeps)
