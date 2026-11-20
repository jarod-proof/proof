/**
 * What a model call costs by its tokens: the floor under a cost the provider reports as zero.
 *
 * @remarks
 * The spend cap is only as good as the cost it is fed, and the gateway reported `costUsd: 0` on
 * every anthropic/claude-haiku-5.5 call (the real-service spike), whatever the tokens. Taken at face
 * value a zero cost never settles a hold above $0.00, so the $10/day cap could never trip. The rule
 * (it is the same wherever a cost is read):
 *
 * - A positive, finite reported cost stands as reported.
 * - A reported cost of 0, or none, on a call that used tokens is never taken as free: it is priced
 *   at the token floor below. A zero settles at the floor itself; a missing cost settles at the
 *   larger of the turn's estimate and the floor (the existing "missing cost settles at the
 *   estimate" rule can only go up).
 * - A reported 0, or none, with no positive token count is an unreported cost, not a free call (eve
 *   fills every count with 0 when the provider reported none): the turn's estimate stands.
 *
 * Prices are US dollars per million tokens, converted to integer money units ($0.0001, hq's unit)
 * and rounded up, never down. A model not in the table is priced at `UNKNOWN_MODEL_PRICE`, which is
 * deliberately above any model we run: an unknown price is a reason to hold more, not less.
 *
 * Cache tokens: eve fills a record's `inputTokens` from the AI SDK's normalised usage, where it is
 * the whole prompt and the cache read and write counts are the part of it that was cached
 * (`inputTokenDetails`); the spike's haiku record agrees (12,039 input tokens, of which 11,926 were
 * cache reads and 109 cache writes). For a table entry marked `inputIncludesCache` the cached part
 * is therefore charged at its cache rate out of `inputTokens`, and only the rest at the input
 * rate. For every other model it is not shown, so cache tokens are charged on top of the input
 * count, which can only over-count.
 */

/** One money unit is $0.0001, the unit hq's ledger stores. */
const UNITS_PER_USD = 10_000

const TOKENS_PER_PRICE = 1_000_000

/** US dollars per million tokens. */
export interface ModelPrice {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /**
   * True when the model's `inputTokens` already counts its cache tokens (so a cache read is part
   * of the input count, not on top of it). Set only where that is shown: see `MODEL_PRICES`.
   */
  inputIncludesCache?: true
  /**
   * The dearer price a call is charged at when its prompt (input plus cache tokens) is longer than
   * `aboveTokens`, as the gateway's tiered list price has it.
   */
  longContext?: { aboveTokens: number; price: Omit<ModelPrice, "longContext"> }
}

/**
 * The price table, by gateway model id, at the gateway's LIST price (read off the gateway's model
 * catalog). It is a table of list prices and must be re-checked against the gateway whenever a
 * model is added or changed: a stale entry makes the floor, and so the cap, misreport spend to
 * founders.
 *
 * - `anthropic/claude-haiku-5.5` (the chat model): $0.1 in / $0.5 out per million tokens, cache
 *   reads $0.01, cache writes $0.125, and five times that for a prompt over 100,000 tokens. The
 *   gateway nevertheless reported it as free ($0, and its own credit counter agreed): why is not
 *   established, so the floor charges the list price instead of trusting the zero.
 * - `google/gemini-decision-1` (the decision model): $0.1 in; the catalog lists its output as free,
 *   but the floor charges output at the input price too (one record's cost does not prove it), and
 *   no cache prices are listed, so cache tokens are charged as input, never lower.
 *
 * The other models we run (reviewer, implementer, researcher, analyst) have no entry: their usage
 * arrives as delegated calls that carry no model id, so they are priced as `delegated`, at
 * `UNKNOWN_MODEL_PRICE`.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "anthropic/claude-haiku-5.5": {
    inputIncludesCache: true,
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    longContext: {
      aboveTokens: 100_000,
      price: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
    },
  },
  "google/gemini-decision-1": { input: 0.1, output: 0.1, cacheRead: 0.1, cacheWrite: 0.1 },
}

/**
 * What an unlisted model is priced at: above any model we run, so a forgotten or renamed model
 * errs towards counting too much; the list price applies to models in the table only. Cache reads at a tenth of input and writes at 1.25x, as the
 * Anthropic family prices them.
 */
export const UNKNOWN_MODEL_PRICE: ModelPrice = {
  input: 25,
  output: 125,
  cacheRead: 2.5,
  cacheWrite: 31.25,
}

/** The price a model's tokens are floored at: its table entry, else the unknown-model price. */
export function priceOf(model: string): ModelPrice {
  return MODEL_PRICES[model.trim().toLowerCase()] ?? UNKNOWN_MODEL_PRICE
}

/** The token counts of one usage record; any may be missing or garbage (it counts as zero). */
export interface UsageTokens {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface UsageWithCost extends UsageTokens {
  costUsd?: number
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0

/**
 * The price in money units per million tokens, as an integer so the arithmetic stays integral. A
 * price that is not a whole number of units is rounded UP (the epsilon only absorbs float noise
 * such as 0.0001 x 10,000), never to nearest: the floor must not undershoot a list price.
 */
const units = (usdPerMillion: number) => Math.ceil(usdPerMillion * UNITS_PER_USD - 1e-9)

/**
 * The least a call's tokens can have cost at this model's price, in dollars rounded up to a whole
 * money unit ($0.0001). 0 only when no token was reported.
 */
export function tokenFloorUsd(model: string, usage: UsageTokens): number {
  const listed = priceOf(model)
  const cache = count(usage.cacheReadTokens) + count(usage.cacheWriteTokens)
  // Where the model's input count includes its cache tokens, the cached part is charged at its
  // cache rate and only the rest at the input rate, and the prompt is the input count alone. A
  // count that is smaller than the cache it should contain says it does not include it after all:
  // then (as for every model not known to) the cache tokens are charged on top of the input.
  const included = listed.inputIncludesCache === true && count(usage.inputTokens) >= cache
  const freshInput = included ? count(usage.inputTokens) - cache : count(usage.inputTokens)
  const prompt = included ? count(usage.inputTokens) : count(usage.inputTokens) + cache
  const price =
    listed.longContext !== undefined && prompt > listed.longContext.aboveTokens
      ? listed.longContext.price
      : listed
  const unitsOwed =
    (freshInput * units(price.input) +
      count(usage.outputTokens) * units(price.output) +
      count(usage.cacheReadTokens) * units(price.cacheRead) +
      count(usage.cacheWriteTokens) * units(price.cacheWrite)) /
    TOKENS_PER_PRICE
  // Exact for whole token counts (an integer over a power of ten divides exactly when it divides).
  return Math.max(0, Math.ceil(unitsOwed)) / UNITS_PER_USD
}

/** Whether a usage record reports any token at all. */
export const hasTokens = (usage: UsageTokens): boolean =>
  count(usage.inputTokens) +
    count(usage.outputTokens) +
    count(usage.cacheReadTokens) +
    count(usage.cacheWriteTokens) >
  0

/** A usable reported cost: a finite number, zero or more. Anything else is "none reported". */
export const reportedCost = (usage: { costUsd?: unknown }): number | undefined =>
  typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0
    ? usage.costUsd
    : undefined

/** How a usage record is to be charged (see the rule above). */
export type PricedUsage =
  /** The provider reported a positive cost: it stands. */
  | { kind: "reported"; amountUsd: number }
  /** The provider reported 0 on a call with tokens: charged at the token floor. */
  | { kind: "floor"; amountUsd: number }
  /**
   * No usable cost (none, or 0 with no tokens): the caller's estimate stands, raised to
   * `floorUsd` when the tokens cost more than the estimate (`floorUsd` is 0 without tokens).
   */
  | { kind: "unreported"; floorUsd: number }

/** Prices one usage record; `model` is the id its tokens are priced at. */
export function priceUsage(model: string, usage: UsageWithCost): PricedUsage {
  const reported = reportedCost(usage)
  if (reported !== undefined && reported > 0) {
    return { kind: "reported", amountUsd: reported }
  }
  const floorUsd = hasTokens(usage) ? tokenFloorUsd(model, usage) : 0
  if (reported === 0 && floorUsd > 0) {
    return { kind: "floor", amountUsd: floorUsd }
  }
  return { kind: "unreported", floorUsd }
}

/**
 * What a normal chat turn is sized at: the Foreman prompt (~12,000 input tokens, seen on every
 * call in the spike) sent on each of about six model calls in a tool loop, and a few thousand
 * tokens written.
 */
export const NORMAL_TURN_TOKENS: Required<UsageTokens> = {
  inputTokens: 6 * 12_000,
  outputTokens: 3_000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}
