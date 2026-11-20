import { defineHook } from "eve/hooks"
import { spendLedger } from "../lib/spend/ledger.js"

/**
 * The daily spend cap and the ledger, as eve hooks. A refused turn is cancelled here and tells the
 * Slack renderer why through session state (`SpendState.refusal`), because the cancelled turn's
 * `turn.settled` carries no cause.
 *
 * - `turn.started` marks the turn, then reserves its estimate in hq before the first model call,
 *   and cancels the turn when hq refuses or cannot be asked.
 * - `model.requested` fails closed: a model call without that marker or without a hold is cancelled.
 * - `usage.recorded` sums what each model run and delegated call cost.
 * - `turn.settled` settles the hold once, and records what the hold does not cover.
 *
 * The logic is in `agent/lib/spend/hooks.ts`, where it is tested without an eve runtime.
 */
export default defineHook({
  events: {
    "turn.started": (event, ctx) => spendLedger.turnStarted(event, ctx),
    "model.requested": (event, ctx) => spendLedger.modelRequested(event, ctx),
    "usage.recorded": (event, ctx) => spendLedger.usageRecorded(event, ctx),
    "turn.settled": (event, ctx) => spendLedger.turnSettled(event, ctx),
  },
})
