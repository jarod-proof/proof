import type { SessionAuthContext } from "eve/context"
import type { HqClient, RunOutcome, RunSummary } from "../hq/client.js"
import { log } from "../log.js"
import { isAutonomous, isSummaryOnly } from "../trust.js"
import { BUILD_ESTIMATE_USD, checkCap, DECISION_ESTIMATE_USD, refusalText } from "./cap.js"
import { priceUsage, type UsageWithCost } from "./prices.js"

/**
 * The spend ledger's hooks: the cap before a turn, the cost after it.
 *
 * @remarks
 * Written against narrow structural types and an injected state store, so the unit tests drive them
 * without an eve runtime; `agent/hooks/spend.ts` binds them to eve's hooks and `defineState`.
 *
 * - `turn.started`: every turn is capped unless the dispatching channel stamped it as an unattended
 *   build (the autonomous principal). The turn's id is written to state first, then the run is
 *   recorded and the estimate reserved in hq. A refusal, an hq outage or a malformed answer cancels
 *   the turn before any model call (`ctx.cancel()`).
 * - `model.requested`: fail closed. A model call whose turn has no marker from `turn.started`, or an
 *   eve turn with no hold, is cancelled (a crash between the marker and the hold would otherwise
 *   let the turn run uncapped).
 * - `usage.recorded` fires once per model run and once per delegated call, so a turn's usage is
 *   summed in state and settled once, at `turn.settled`. A record's cost is never taken from a bare
 *   zero: the gateway reports `costUsd: 0` on calls that used thousands of tokens, so a zero (or no
 *   cost) on a call with tokens is priced at the token floor (`prices.ts`, which states the rule). A
 *   floor is an estimate: it is kept in its own bucket (`floorUsd`), recorded estimated beside the
 *   hold, and the hold settles at the reported part only (0 when only floors arrived).
 *   A decision call is counted once. eve's `decide()` emits a `usage.recorded` of kind "decision"
 *   (owner null) when it runs inside a session, and none outside one. The metered wrapper in
 *   `ledger.ts` announces each call before making it (`decisionExpected`) and counts it itself
 *   (`decisionSpent`); the record that call then emits consumes the announcement and is skipped.
 *   A "decision" record nobody announced, such as one from eve's own `decide()` (LLM tool
 *   approval, auto model routing), is counted like any other record: it is real spend.
 *   Usage that arrives with no open hold (late delegated spend, a build) goes to `record_spend`. Hooks are not exactly-once: each
 *   record is keyed on `ctx.occurrence.idempotencyKey` and skipped when seen. hq's `record_spend`
 *   has no idempotency field, so this guard is best effort (see the report).
 * - A turn's cost is never dropped. The hold settles at the exact cost up to its estimate; the rest
 *   is recorded as its own `record_spend` (exact above the estimate, `estimatedUsd` for records the
 *   provider gave no cost), so it reaches hq whether or not the settle does. A settle or a record
 *   that fails is parked in state and retried by the next hook.
 */

/** Builds are outside the daily cap; they record their cost as `build` spend. */
export type TurnKind = "eve" | "build"

/** A `record_spend` that failed and is retried by the next hook. */
export interface PendingRecord {
  key: string
  source: "eve" | "build"
  amountUsd?: number
  estimatedUsd?: number
  model: string
  /** The run it belongs to; null for none; left out, the current run. */
  runId?: string | null
}

/** A hold whose settle failed: retried by the next hook, so it does not stay open in hq. */
export interface UnsettledHold {
  holdId: string
  /** Left out, hq settles at the hold's estimate, marked estimated. */
  amountUsd?: number
  model: string
}

export interface SpendState {
  kind: TurnKind | null
  /** The turn `turn.started` ran for: the marker `model.requested` checks. */
  turnId: string | null
  runId: string | null
  /** The open hold, until the turn settles. */
  holdId: string | null
  estimateUsd: number
  /** Sum of the costs usage records reported this turn. */
  knownUsd: number
  /** How many records reported a cost, and how many did not. */
  withCost: number
  withoutCost: number
  /** Decision-model calls this turn (and floor excess over the estimate), priced as estimates. */
  extraEstimatedUsd: number
  /**
   * Token-floor costs of records the provider reported as 0: an estimate, never a reported cost, so
   * they are kept out of `knownUsd`, recorded as estimated and never settled into the hold as exact.
   * Optional, read as 0, so state persisted before this field existed still works.
   */
  floorUsd?: number
  /**
   * Decision calls the metered wrapper has announced and counts itself, whose own `usage.recorded`
   * (kind "decision") has not arrived yet: each such record is skipped once. Optional, read as 0,
   * so state persisted before this field existed still works.
   */
  decisionCredits?: number
  /** Idempotency keys already handled (the last 200). */
  seen: string[]
  pending: PendingRecord[]
  unsettled: UnsettledHold[]
  /** True once the turn settled: later usage is recorded, not summed. */
  settled: boolean
  /**
   * Set when this turn was refused. The Slack channel reads it to tell the thread why, because a
   * cancelled turn's `turn.settled` carries no cause naming the hook (observed under `eve eval`).
   */
  refusal: { remainingUsd: number; unavailable: boolean } | null
}

export const EMPTY_SPEND_STATE: SpendState = {
  kind: null,
  turnId: null,
  runId: null,
  holdId: null,
  estimateUsd: 0,
  knownUsd: 0,
  withCost: 0,
  withoutCost: 0,
  extraEstimatedUsd: 0,
  seen: [],
  pending: [],
  unsettled: [],
  settled: true,
  refusal: null,
}

export interface SpendStore {
  get(): SpendState
  update(fn: (state: SpendState) => SpendState): void
}

/** What the hooks read of eve's hook context. */
export interface SpendHookContext {
  readonly session: {
    readonly id: string
    readonly auth: { readonly current: SessionAuthContext | null }
  }
  readonly channel: { readonly kind?: string }
  readonly occurrence: { readonly idempotencyKey: string }
  readonly turn?: { readonly id: string } | null
  cancel(reason?: string): void
}

export interface UsageEvent {
  data: {
    /** Absent or null for usage nothing owns (a decision call, cache warming). */
    owner?: { runId: string } | { callId: string } | { changeId: string } | null
    kind: string
    /** Eve fills every count with 0 when the provider reported none; the cost may be 0 or absent. */
    usage: UsageWithCost
  }
}

export interface TurnSettledEvent {
  data: { outcome: "completed" | "failed" | "cancelled" }
}

export interface SpendHookDeps {
  /** Resolved per call: a missing key or URL fails closed in the turn, not at load. */
  hq: () => HqClient
  store: SpendStore
  /** What a turn is assumed to cost until known (dollars). */
  estimateUsd: () => number
  /** The model name recorded with the cost. */
  modelId: () => string
  /** The decision model's id, to price a decision record nobody announced; unknown when left out. */
  decisionModelId?: () => string
}

const SEEN_LIMIT = 200
const SETTLE_ATTEMPTS = 2

/**
 * Whether a turn is an unattended build (outside the daily cap) or capped (chat, schedules, and the
 * summary of a pull request anyone opened: that run is not a build, and its trigger is the least
 * trusted input there is, so it stays under the cap).
 */
export function classify(auth: SessionAuthContext | null): TurnKind {
  return isAutonomous(auth) && !isSummaryOnly(auth) ? "build" : "eve"
}

/** hq refuses one call over this many dollars; larger costs go in several calls. */
export const MAX_CALL_USD = 1000

/** An amount as calls hq accepts: pieces of at most MAX_CALL_USD that add up to the whole. */
export function inCalls(amountUsd: number): number[] {
  const pieces: number[] = []
  let left = Math.round(amountUsd * 10_000)
  const most = MAX_CALL_USD * 10_000
  while (left > most) {
    pieces.push(MAX_CALL_USD)
    left -= most
  }
  pieces.push(left / 10_000)
  return pieces
}

const round4 = (amount: number) => Math.round(amount * 10_000) / 10_000

/**
 * A priced record as `record_spend` takes it: a reported cost is exact; a token floor or an
 * unreported cost is an estimate (at least `fallbackUsd`, and at least the floor), so hq marks it so.
 */
function recordedAs(
  priced: ReturnType<typeof priceUsage>,
  fallbackUsd: number,
): { amountUsd?: number; estimatedUsd?: number } {
  if (priced.kind === "reported") {
    return { amountUsd: priced.amountUsd }
  }
  if (priced.kind === "floor") {
    return { estimatedUsd: priced.amountUsd }
  }
  return { estimatedUsd: Math.max(fallbackUsd, priced.floorUsd) }
}

/** How a finished turn's cost is split between the hold's settlement and separate records. */
export interface Settlement {
  /**
   * What the hold settles at, exact (reported cost only, never a floor). Undefined: hq settles at
   * the hold's estimate, marked estimated. 0 is not undefined: it closes the hold at nothing and
   * leaves the turn's cost to the records.
   */
  settleAt: number | undefined
  /** Exact cost above the hold's estimate: recorded on its own. */
  excessUsd: number
  /**
   * Cost not reported by the provider, priced at an estimate (or at a token floor): recorded on
   * its own, estimated.
   */
  estimatedUsd: number
}

/**
 * What to settle a turn at, and what to record beside it.
 *
 * Every record without a cost is priced at one estimate, whichever branch: N such records cost N
 * estimates, with or without a record that reported a cost. A token floor (a reported 0 on a call
 * with tokens) is an estimate of its own amount: it is recorded estimated and never settled into
 * the hold as if the gateway had reported it.
 * - No record reported a cost: the hold settles at its estimate (marked estimated by hq), which
 *   covers the first record without a cost; the other N - 1 are recorded estimated. When there is
 *   no record without a cost either, only floors (`floorUsd`), the hold settles at 0 and the floors
 *   are the turn's cost: settling at the estimate on top of them would charge a turn far more than
 *   its tokens cost. A turn with nothing at all still settles at the estimate.
 * - Some did: the hold settles at the reported cost up to its estimate and the rest of it is
 *   recorded exact; each of the N records without a cost, each floor and each decision-model call
 *   is priced at an estimate and recorded estimated. A missing cost is never taken as zero.
 */
export function settlementOf(state: SpendState): Settlement {
  const floors = state.floorUsd ?? 0
  if (state.withCost === 0) {
    // The hold's own estimate stands for the first record without a cost (hq marks it estimated);
    // each further one is priced at the estimate too, as in the branch below: N records, N estimates.
    return {
      settleAt: state.withoutCost === 0 && floors > 0 ? 0 : undefined,
      excessUsd: 0,
      estimatedUsd: round4(
        Math.max(0, state.withoutCost - 1) * state.estimateUsd + state.extraEstimatedUsd + floors,
      ),
    }
  }
  return {
    settleAt: Math.min(state.knownUsd, state.estimateUsd),
    excessUsd: round4(Math.max(0, state.knownUsd - state.estimateUsd)),
    estimatedUsd: round4(state.withoutCost * state.estimateUsd + state.extraEstimatedUsd + floors),
  }
}

const OUTCOMES: Record<TurnSettledEvent["data"]["outcome"], RunOutcome> = {
  completed: "succeeded",
  failed: "failed",
  cancelled: "stopped",
}

export function createSpendHooks(deps: SpendHookDeps) {
  const { store } = deps

  const seen = (key: string) => store.get().seen.includes(key)
  const remember = (key: string) =>
    store.update((s) => ({ ...s, seen: [...s.seen, key].slice(-SEEN_LIMIT) }))

  /** Sends one `record_spend`; a failure parks it in state for the next hook. */
  async function record(entry: PendingRecord): Promise<void> {
    // hq takes at most MAX_CALL_USD a call: a larger cost goes in pieces, none of it dropped.
    if (entry.amountUsd !== undefined && entry.amountUsd > MAX_CALL_USD) {
      for (const piece of inCalls(entry.amountUsd)) {
        await record({ ...entry, amountUsd: piece })
      }
      return
    }
    const runId = entry.runId === undefined ? store.get().runId : entry.runId
    try {
      await deps.hq().recordSpend({
        runId: runId ?? undefined,
        source: entry.source,
        amountUsd: entry.amountUsd,
        estimatedUsd: entry.estimatedUsd,
        model: entry.model,
      })
    } catch (error) {
      log.warn("spend: record_spend failed, will retry", error)
      store.update((s) => ({ ...s, pending: [...s.pending, { ...entry, runId }] }))
    }
  }

  /** Settles one hold; true when it is closed (settled now, or already: a CONFLICT). */
  async function settle(hold: UnsettledHold): Promise<boolean> {
    try {
      await deps.hq().settleSpend(hold)
      return true
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "CONFLICT") {
        return true
      }
      log.warn("spend: settle_spend failed", error)
      return false
    }
  }

  /** Retries what an earlier hook could not send: holds to settle, and records. */
  async function flush(): Promise<void> {
    const holds = store.get().unsettled
    if (holds.length > 0) {
      store.update((s) => ({ ...s, unsettled: [] }))
      for (const hold of holds) {
        if (!(await settle(hold))) {
          store.update((s) => ({ ...s, unsettled: [...s.unsettled, hold] }))
        }
      }
    }
    const waiting = store.get().pending
    if (waiting.length > 0) {
      store.update((s) => ({ ...s, pending: [] }))
      for (const entry of waiting) {
        await record(entry)
      }
    }
  }

  async function turnStarted(_event: unknown, ctx: SpendHookContext): Promise<void> {
    const kind = classify(ctx.session.auth.current)
    const estimateUsd = deps.estimateUsd()
    // The marker first, before any hq call: model.requested refuses a turn that lacks it.
    const carried = store.get()
    store.update(() => ({
      ...EMPTY_SPEND_STATE,
      kind,
      turnId: ctx.turn?.id ?? null,
      estimateUsd,
      settled: false,
      seen: carried.seen,
      pending: carried.pending,
      unsettled: carried.unsettled,
    }))
    await flush()
    let runId: string | null = null
    try {
      const run = await deps.hq().recordRun({
        task: kind === "build" ? "build" : "chat",
        trigger: ctx.channel.kind ?? "unknown",
        runner: kind === "build" ? "sandbox" : "eve",
      })
      runId = run.id
    } catch (error) {
      // A run row is bookkeeping: the turn does not depend on it.
      log.warn("spend: record_run failed", error)
    }
    store.update((s) => ({ ...s, runId }))
    if (kind === "build") {
      return
    }

    let hq: HqClient
    try {
      hq = deps.hq()
    } catch {
      // No hq URL or key configured: the cap cannot be checked, so the turn does not run.
      store.update((s) => ({
        ...s,
        settled: true,
        refusal: { remainingUsd: 0, unavailable: true },
      }))
      ctx.cancel(refusalText({ remainingUsd: 0, unavailable: true }))
      return
    }
    const result = await checkCap(hq, estimateUsd, { runId: runId ?? undefined })
    if (result.allowed) {
      store.update((s) => ({ ...s, holdId: result.holdId }))
      return
    }
    store.update((s) => ({
      ...s,
      settled: true,
      refusal: { remainingUsd: result.remainingUsd, unavailable: result.unavailable === true },
    }))
    ctx.cancel(refusalText(result))
    if (runId !== null) {
      try {
        await hq.finishRun({
          id: runId,
          outcome: "stopped",
          summary: {
            worked: [],
            failed: [],
            stop: [
              result.unavailable ? "spend cap could not be checked" : "daily spend cap reached",
            ],
          },
        })
      } catch (error) {
        log.warn("spend: finish_run failed", error)
      }
    }
  }

  /**
   * Fail closed before every model call: the turn must have run `turn.started` (its marker is in
   * state), and an eve turn must hold its estimate. Otherwise the call is cancelled, not allowed.
   */
  function modelRequested(_event: unknown, ctx: SpendHookContext): void {
    const state = store.get()
    const turnId = ctx.turn?.id ?? null
    const unmarked = state.turnId === null || (turnId !== null && state.turnId !== turnId)
    const unheld = state.kind === "eve" && state.holdId === null && !state.settled
    if (unmarked || unheld) {
      // Tell the thread why it is quiet (the Slack renderer posts the refusal from state).
      store.update((s) => ({ ...s, refusal: { remainingUsd: 0, unavailable: true } }))
      ctx.cancel(refusalText({ remainingUsd: 0, unavailable: true }))
    }
  }

  async function usageRecorded(event: UsageEvent, ctx: SpendHookContext): Promise<void> {
    const key = ctx.occurrence.idempotencyKey
    if (seen(key)) {
      return
    }
    remember(key)
    await flush()
    const state = store.get()
    if (event.data.kind === "decision" && (state.decisionCredits ?? 0) > 0) {
      // The metered wrapper announced this call and counts it (see the header): once, not twice.
      store.update((s) => ({ ...s, decisionCredits: (s.decisionCredits ?? 0) - 1 }))
      return
    }
    const model =
      event.data.kind === "decision"
        ? (deps.decisionModelId?.() ?? "decision")
        : event.data.owner && "callId" in event.data.owner
          ? "delegated"
          : deps.modelId()
    const priced = priceUsage(model, event.data.usage)

    if (state.kind === "eve" && state.holdId !== null && !state.settled) {
      store.update((s) =>
        priced.kind === "unreported"
          ? {
              ...s,
              // Priced at the turn's estimate as ever; tokens that cost more than the estimate add
              // the difference, so the record counts at its floor and stays marked estimated.
              withoutCost: s.withoutCost + 1,
              extraEstimatedUsd:
                s.extraEstimatedUsd + Math.max(0, round4(priced.floorUsd - s.estimateUsd)),
            }
          : priced.kind === "floor"
            ? { ...s, floorUsd: (s.floorUsd ?? 0) + priced.amountUsd }
            : { ...s, knownUsd: s.knownUsd + priced.amountUsd, withCost: s.withCost + 1 },
      )
      return
    }

    // No open hold: a build, or spend that arrives after its turn settled. Never lose it.
    const source = state.kind === "build" ? "build" : "eve"
    const fallback =
      source === "build" ? BUILD_ESTIMATE_USD : Math.max(state.estimateUsd, deps.estimateUsd())
    await record({ key, source, model, ...recordedAs(priced, fallback) })
  }

  /** The wrapper is about to make a decision call that `decisionSpent` will count. */
  function decisionExpected(): void {
    store.update((s) => ({ ...s, decisionCredits: (s.decisionCredits ?? 0) + 1 }))
  }

  /** The announced decision call threw before it recorded any usage: nothing to skip. */
  function decisionAbandoned(): void {
    store.update((s) => ({ ...s, decisionCredits: Math.max(0, (s.decisionCredits ?? 0) - 1) }))
  }

  /**
   * A decision-model call (`decide()`): the one place it is counted (the `usage.recorded` the call emits
   * is skipped by `usageRecorded` against `decisionExpected`, so a call is never counted twice). Inside an open eve
   * turn it joins the turn's sum (at its reported cost, else the decision estimate); anywhere else
   * it is recorded straight away, as build spend when it is for a build (`build: true`, pretriage).
   */
  async function decisionSpent(
    input: UsageWithCost & { model: string; build?: boolean },
  ): Promise<void> {
    // `decide()`'s result carries tokens and no cost (its own usage record has the gateway's, which
    // `usageRecorded` skips), so this is in practice max(decision estimate, token floor).
    const priced = priceUsage(input.model, input)
    const state = store.get()
    if (!input.build && state.kind === "eve" && state.holdId !== null && !state.settled) {
      store.update((s) =>
        priced.kind === "unreported"
          ? {
              ...s,
              extraEstimatedUsd:
                s.extraEstimatedUsd + Math.max(DECISION_ESTIMATE_USD, priced.floorUsd),
            }
          : priced.kind === "floor"
            ? { ...s, floorUsd: (s.floorUsd ?? 0) + priced.amountUsd }
            : { ...s, knownUsd: s.knownUsd + priced.amountUsd, withCost: s.withCost + 1 },
      )
      return
    }
    await record({
      key: "decision",
      source: input.build || state.kind === "build" ? "build" : "eve",
      model: input.model,
      runId: input.build ? null : undefined,
      ...recordedAs(priced, DECISION_ESTIMATE_USD),
    })
  }

  async function turnSettled(event: TurnSettledEvent, ctx: SpendHookContext): Promise<void> {
    const key = ctx.occurrence.idempotencyKey
    if (seen(key)) {
      return
    }
    remember(key)
    await flush()
    const state = store.get()
    if (state.kind === null || state.settled) {
      return
    }
    store.update((s) => ({ ...s, settled: true }))

    if (state.holdId !== null) {
      const { settleAt, excessUsd, estimatedUsd } = settlementOf(state)
      const hold: UnsettledHold = {
        holdId: state.holdId,
        amountUsd: settleAt,
        model: deps.modelId(),
      }
      // The records first, then the settle: closing the hold releases its reservation, so a record
      // written after it would leave the day's spend short in between (a floor-only turn settles
      // at 0). In this order the day is briefly over-counted, never under. A record that fails is
      // parked and retried by the next hook, as is a settle that fails.
      if (excessUsd > 0) {
        await record({ key, source: "eve", amountUsd: excessUsd, model: deps.modelId() })
      }
      if (estimatedUsd > 0) {
        await record({ key, source: "eve", estimatedUsd, model: deps.modelId() })
      }
      let closed = false
      for (let attempt = 0; attempt < SETTLE_ATTEMPTS && !closed; attempt++) {
        closed = await settle(hold)
      }
      store.update((s) => ({
        ...s,
        holdId: null,
        unsettled: closed ? s.unsettled : [...s.unsettled, hold],
      }))
    }

    if (state.runId !== null) {
      const summary: RunSummary = {
        worked: event.data.outcome === "completed" ? ["turn completed"] : [],
        failed: event.data.outcome === "failed" ? ["turn failed"] : [],
        stop: event.data.outcome === "cancelled" ? ["turn cancelled"] : [],
      }
      try {
        await deps
          .hq()
          .finishRun({ id: state.runId, outcome: OUTCOMES[event.data.outcome], summary })
      } catch (error) {
        log.warn("spend: finish_run failed", error)
      }
    }
  }

  return {
    turnStarted,
    modelRequested,
    usageRecorded,
    decisionExpected,
    decisionAbandoned,
    decisionSpent,
    turnSettled,
  }
}
