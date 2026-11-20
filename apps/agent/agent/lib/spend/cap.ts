import { agentEnv } from "@proof/env/agent"
import type { HqClient } from "../hq/client.js"
import { MODELS } from "../models.js"
import { NORMAL_TURN_TOKENS, tokenFloorUsd } from "./prices.js"

/**
 * The daily Eve spend cap ($10.00 a day per org, set in hq): the check a turn passes before any
 * model call.
 *
 * @remarks
 * hq owns the arithmetic. `reserve_spend` holds the turn's estimate in one transaction, so two
 * turns racing at $9.90 cannot both start (proved in hq's own tests). This module only asks and
 * fails closed: a refusal, an hq outage and a malformed answer all mean the turn does not run.
 * Nothing here weakens or reads the cap's size.
 */

/**
 * The least a turn is assumed to cost until its real cost is known. The estimate is also what a
 * model call that reports no cost settles at, so it is never lowered below this.
 */
export const DEFAULT_TURN_ESTIMATE_USD = 0.1

/**
 * What a normal chat turn costs on the chat model by its tokens: the ~12,000-token Foreman prompt
 * on each of about six calls, plus the reply (`NORMAL_TURN_TOKENS`), priced from the table in
 * `prices.ts`, rounded up to a cent. At haiku-5.5's list price that is 72,000 x $0.1/M + 3,000 x
 * $0.5/M = $0.0087, so `DEFAULT_TURN_ESTIMATE_USD` still governs (it covers it eleven times over);
 * a chat model that is repriced or missing from the table raises the estimate by itself.
 */
export function normalTurnUsd(model: string = MODELS.orchestrator): number {
  return Math.ceil(tokenFloorUsd(model, NORMAL_TURN_TOKENS) * 100) / 100
}

/** What one unattended build model run is recorded at when the provider reports no cost. */
export const BUILD_ESTIMATE_USD = 0.25

/** What one decision-model call (`decide()`; its result carries tokens, never a cost) is priced at. */
export const DECISION_ESTIMATE_USD = 0.02

/** The most an estimate may be set to: a typo must not hold the day's whole cap. */
const MAX_ESTIMATE_USD = 5

/**
 * The per-turn estimate: AGENT_TURN_ESTIMATE_USD when it is a sensible amount, else the larger of
 * the default and what a normal turn costs on the chat model by its tokens (never above the clamp).
 * `model` is the chat model it is sized for: the configured one, not `chatModelId()`, because
 * offline that is a mock priced as unknown. A test passes its own.
 */
export function turnEstimateUsd(model: string = MODELS.orchestrator): number {
  const sized = Math.min(
    Math.max(DEFAULT_TURN_ESTIMATE_USD, normalTurnUsd(model)),
    MAX_ESTIMATE_USD,
  )
  const raw = agentEnv("AGENT_TURN_ESTIMATE_USD")
  if (raw === undefined || raw.trim() === "") {
    return sized
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    return sized
  }
  // Too large an amount is clamped, not ignored: an operator who asked for more gets the most.
  return Math.min(value, MAX_ESTIMATE_USD)
}

export type CapResult =
  | { allowed: true; holdId: string }
  | {
      allowed: false
      /** What hq says is left today; 0 when hq could not be asked. */
      remainingUsd: number
      /** True when hq could not be reached or answered badly: the cap could not be checked. */
      unavailable?: true
    }

/**
 * Reserves `estimateUsd` against today's cap.
 *
 * @returns `allowed: true` with the hold to settle when the turn ends, or `allowed: false`. It never
 * throws: when hq cannot be asked the cap cannot be checked, which is a refusal, not a pass.
 */
export async function checkCap(
  hq: Pick<HqClient, "reserveSpend">,
  estimateUsd: number,
  options: { runId?: string } = {},
): Promise<CapResult> {
  let reservation: Awaited<ReturnType<HqClient["reserveSpend"]>>
  try {
    reservation = await hq.reserveSpend({ estimateUsd, runId: options.runId })
  } catch {
    return { allowed: false, remainingUsd: 0, unavailable: true }
  }
  if ("holdId" in reservation && reservation.holdId !== "") {
    return { allowed: true, holdId: reservation.holdId }
  }
  if ("refused" in reservation) {
    return { allowed: false, remainingUsd: Math.max(0, reservation.remainingUsd) }
  }
  return { allowed: false, remainingUsd: 0, unavailable: true }
}

const usd = (amount: number) => `$${amount.toFixed(2)}`

/**
 * What the thread is told when a turn is refused. A pure function of the refusal: the Slack renderer
 * posts it, and tests read it.
 */
export function refusalText(refusal: { remainingUsd: number; unavailable?: boolean }): string {
  if (refusal.unavailable) {
    return "I can't check today's spend cap right now, so I haven't run this. Please try again in a few minutes."
  }
  return `Today's spend cap is reached: ${usd(refusal.remainingUsd)} left, and this turn needs more. I haven't run it. A founder can raise today's allowance (hq's admin spend page, or ask in this thread); then ask me again.`
}
