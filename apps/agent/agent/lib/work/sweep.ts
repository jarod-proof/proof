import { agentEnv } from "@proof/env/agent"
import { createHqClient, HqError, type HqClient, type SweepResult } from "../hq/client.js"
import { log } from "../log.js"

/**
 * The work sweep: hq's verification sweep, called on a schedule by the agent's own key.
 *
 * @remarks
 * hq owns every rule (abandon an attempt whose lease ran out, retriage a reopened item, open a
 * verification window past the deploy grace, settle a window) and its own clock; the agent only
 * asks. So this sends no body, no date and no choice: the call is `POST /v1/work/verification-sweep`
 * with `{}`, and running it twice changes nothing the second time. It fails closed: hq down, hq
 * refusing, the environment unset or a reply it cannot read are logged and do nothing, and nothing
 * here throws out to the schedule or tries again (the next fire is the retry).
 *
 * `dispatched` is always 0: the dispatcher (Task 14's second half) is not built because the attempt
 * dispatch decision is `label` (`decisions/dispatch.md`), so the sweep never lists, claims or
 * dispatches an attempt request.
 */

/** Per call. The sweep walks items on hq's side, so it gets more than the hooks' 3 seconds. */
export const SWEEP_HQ_TIMEOUT_MS = 25_000

/** How much of an error's message is logged: it is hq's own text, kept short regardless. */
const MESSAGE_CAP = 200

/** The most error keys the repeat counter remembers (a stuck item must not grow it forever). */
const MAX_COUNTED = 500

export interface SweepDeps {
  hq: HqClient
}

export interface SweepOutcome {
  /** hq's report, or null when hq could not be asked. */
  sweep: SweepResult | null
  /** Attempt requests handed to a dispatcher: always 0 while the dispatch decision is `label`. */
  dispatched: number
}

/** Consecutive sweeps in which one `item:rule` failed, in this process. */
let repeats = new Map<string, number>()

/** The repeat count of every `item:rule` that failed in the latest sweep (tests and diagnostics). */
export function sweepErrorRepeats(): Record<string, number> {
  return Object.fromEntries(repeats)
}

/** Forgets the repeat counts (tests). */
export function resetSweepStats(): void {
  repeats = new Map()
}

/** Never lets a failing logger fail a sweep. */
function warn(message: string, details: Record<string, unknown>): void {
  try {
    log.warn(message, details)
  } catch {
    // Logging is best effort here.
  }
}

/**
 * Logs what a sweep could not do, and counts each item's consecutive failures. Only the item, the
 * rule and hq's own capped message are logged: never a body, an outside text or a key. The counter
 * is per process (a cold start begins again at 1), so an alert on `repeats` is a floor, not a count.
 */
function reportErrors(errors: SweepResult["errors"]): void {
  const next = new Map<string, number>()
  for (const { itemId, rule, message } of errors) {
    const key = `${itemId ?? "none"}:${rule}`
    // The first time a key fails in this sweep it is one more than the last sweep's count.
    const count = next.get(key) ?? (repeats.get(key) ?? 0) + 1
    if (next.size < MAX_COUNTED) {
      next.set(key, count)
    }
    warn("work_sweep_item_error", {
      itemId,
      rule,
      message: message.slice(0, MESSAGE_CAP),
      repeats: count,
    })
  }
  repeats = next
  if (errors.length > 0) {
    warn("work_sweep_errors", { count: errors.length })
  }
}

/**
 * Runs the sweep once.
 *
 * @returns hq's report, or `{ sweep: null, dispatched: 0 }` when hq could not be asked. Never throws.
 */
export async function runWorkSweep(deps: SweepDeps): Promise<SweepOutcome> {
  let sweep: SweepResult
  try {
    sweep = await deps.hq.runVerificationSweep()
  } catch (error) {
    // Only the status and code: hq's message can carry text the sweep read.
    warn("work_sweep_unavailable", {
      status: error instanceof HqError ? error.status : undefined,
      code: error instanceof HqError ? error.code : undefined,
    })
    return { sweep: null, dispatched: 0 }
  }
  reportErrors(sweep.errors)
  return { sweep, dispatched: 0 }
}

/** The agent's hq client for the sweep, or null when HQ_BASE_URL or HQ_AGENT_API_KEY is unset. */
export function sweepHq(): HqClient | null {
  const baseUrl = agentEnv("HQ_BASE_URL")?.trim()
  const apiKey = agentEnv("HQ_AGENT_API_KEY")?.trim()
  if (!baseUrl || !apiKey) {
    return null
  }
  return createHqClient({ baseUrl, apiKey, timeoutMs: SWEEP_HQ_TIMEOUT_MS })
}

/**
 * What one schedule fire does: build the client, sweep once. Every failure is logged and swallowed
 * (the schedule has nowhere to report one, and a failed invocation is not retried by Vercel).
 */
export async function runScheduledSweep(make: () => HqClient | null = sweepHq): Promise<void> {
  try {
    const hq = make()
    if (!hq) {
      warn("work_sweep_skipped", { reason: "HQ_BASE_URL or HQ_AGENT_API_KEY is not set" })
      return
    }
    await runWorkSweep({ hq })
  } catch (error) {
    warn("work_sweep_failed", { error: error instanceof Error ? error.name : "unknown" })
  }
}
