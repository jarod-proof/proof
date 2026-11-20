// Evaluating feature flags for a caller: always for the caller's own organization (OpenFeature's
// targetingKey is the organization id, whatever a client sends). Rollouts are cached briefly, the
// organization's targets are read per evaluation set, and every evaluation is counted (exposures).
// A request's evaluations are remembered, so a 5xx that follows is counted against the values it saw
// (`errors`), and error reports name them: the evidence a reclaim decision compares.
import { AsyncLocalStorage } from "node:async_hooks"

import type { Caller } from "@proof/api"
import type { Database } from "@proof/db"
import { reportError } from "@proof/errors"
import {
  type Evaluation,
  evaluate,
  type FlagCatalog,
  type FlagKey,
  flags as productFlags,
  type Rollout,
} from "@proof/flags"

import { addExposures, type ExposureCount, loadRollouts, targetsOf } from "./data/feature-flags"
import { inCallerOrg } from "./tenant"

/** How long rollouts are cached. Another instance's change reaches this one within it. */
export const ROLLOUT_TTL_MS = 5_000
/** How often counted exposures are written. */
export const EXPOSURE_FLUSH_MS = 30_000

export interface FlagService {
  /** The flags this build declares. */
  readonly catalog: FlagCatalog
  /** Every catalog flag for the caller's organization, in catalog order. */
  evaluateAll(caller: Caller): Promise<Evaluation[]>
  /** One flag for the caller's organization, or null if the catalog has no such key. */
  evaluate(caller: Caller, key: string): Promise<Evaluation | null>
  /** A flag's value for the caller's organization: the code default if it can't be evaluated. */
  isEnabled(caller: Caller, key: FlagKey): Promise<boolean>
  /** Forget cached rollouts, after a write, so this instance serves the change at once. */
  invalidate(): void
  /** Run a request with its evaluations remembered (see `failed`). */
  scope<T>(fn: () => Promise<T>): Promise<T>
  /** The flags this request evaluated so far, by key: for error reports. */
  seen(): Record<string, boolean>
  /** The request failed with a 5xx: count an error for each value it evaluated. */
  failed(): void
  /** Write counted exposures now. */
  flush(): Promise<void>
  /** Stop the flush timer and write what is left. */
  close(): Promise<void>
}

export interface FlagServiceOptions {
  db: Database
  /** Defaults to the product's catalog (packages/flags). Tests pass their own. */
  catalog?: FlagCatalog
  now?: () => Date
  /** Write exposures on a timer. Off in tests, which flush when they look. */
  autoFlush?: boolean
}

export function createFlagService({
  db,
  catalog = productFlags,
  now = () => new Date(),
  autoFlush = true,
}: FlagServiceOptions): FlagService {
  let cached: { at: number; rollouts: Promise<Map<string, Rollout>> } | undefined
  const rollouts = () => {
    const at = Date.now()
    if (!cached || at - cached.at > ROLLOUT_TTL_MS) {
      const load = loadRollouts(db)
      // A failed load is not cached: the next evaluation tries again.
      load.catch(() => {
        if (cached?.rollouts === load) cached = undefined
      })
      cached = { at, rollouts: load }
    }
    return cached.rollouts
  }

  const counts = new Map<string, ExposureCount>()
  const count = (key: string, value: boolean, field: "count" | "errors") => {
    const day = now().toISOString().slice(0, 10)
    const id = `${day}|${key}|${value}`
    const entry = counts.get(id) ?? { key, day, value, count: 0, errors: 0 }
    entry[field]++
    counts.set(id, entry)
  }

  const requests = new AsyncLocalStorage<Map<string, boolean>>()

  async function evaluateKeys(caller: Caller, keys: readonly string[]): Promise<Evaluation[]> {
    const [state, targets] = await Promise.all([
      rollouts(),
      inCallerOrg(caller, (org, proof) => targetsOf(db, org, proof)),
    ])
    const seen = requests.getStore()
    return keys.flatMap((key) => {
      const flag = catalog[key]
      if (!flag) return []
      const result = evaluate({
        key,
        flag,
        rollout: state.get(key) ?? null,
        target: targets.get(key),
        organizationId: caller.organizationId,
      })
      count(key, result.value, "count")
      seen?.set(key, result.value)
      return [result]
    })
  }

  async function flush(): Promise<void> {
    if (counts.size === 0) return
    const batch = [...counts.values()]
    counts.clear()
    try {
      await addExposures(db, batch)
    } catch (error) {
      // Exposures are evidence, not state: a failed write is reported and the counts kept for the
      // next flush, so a database blip loses nothing.
      for (const c of batch) {
        const id = `${c.day}|${c.key}|${c.value}`
        const entry = counts.get(id) ?? { ...c, count: 0, errors: 0 }
        entry.count += c.count
        entry.errors += c.errors
        counts.set(id, entry)
      }
      reportError(error, { phase: "flag-exposures" })
    }
  }

  const timer = autoFlush ? setInterval(() => void flush(), EXPOSURE_FLUSH_MS) : undefined
  timer?.unref()

  return {
    catalog,
    evaluateAll: (caller) => evaluateKeys(caller, Object.keys(catalog)),
    evaluate: async (caller, key) => (await evaluateKeys(caller, [key]))[0] ?? null,
    async isEnabled(caller, key) {
      try {
        return (await evaluateKeys(caller, [key]))[0]?.value ?? catalog[key]?.default ?? false
      } catch (error) {
        // OpenFeature's rule: evaluation never fails the caller, it falls back to the default.
        reportError(error, { phase: "flag-evaluation", flag: key })
        return catalog[key]?.default ?? false
      }
    },
    invalidate() {
      cached = undefined
    },
    scope: (fn) => requests.run(new Map(), fn),
    seen: () => Object.fromEntries(requests.getStore() ?? []),
    failed() {
      for (const [key, value] of requests.getStore() ?? []) count(key, value, "errors")
    },
    flush,
    async close() {
      if (timer) clearInterval(timer)
      await flush()
    },
  }
}
