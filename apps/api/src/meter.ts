// Metering: product API calls per organization per UTC day, against the plan's `requests` limit
// (the plan catalog, @proof/plans, through @byo-oss/entitlements). An organization is "unclaimed"
// while its owners' emails are unverified (provisional signups, see @proof/auth signup.ts); it gets
// the lower UNCLAIMED_ORG_DAILY_REQUEST_LIMIT until an owner claims the account (resolveEntitlements
// in @proof/auth entitlements.ts). Counting is entitlements' consumeUsage: one guarded increment,
// and a refused call counts nothing.
import type { Caller } from "@proof/api"
import type { PlanEntitlements } from "@proof/auth"
import type { Database } from "@proof/db"
import { catalog } from "@proof/plans"

import { organizationClaimed } from "./data/organizations"

/** The metered limit key in the plan catalog. */
export const REQUESTS = "requests"

export interface OrgStatus {
  /** An owner has verified their email. */
  claimed: boolean
}

/** One call's consumption: whether it may run, and the numbers for the RateLimit-* headers. */
export interface Reading {
  allowed: boolean
  /** Why it was refused: the day's limit is used up (`limit_reached`) or 0 (`not_in_plan`). */
  reason: "ok" | "not_in_plan" | "limit_reached" | "error"
  /** Calls allowed per day; null when the plan is unlimited (Team, or a staff override). */
  limit: number | null
  used: number
  /** Calls left today; null when unlimited. */
  remaining: number | null
  /** When the day's counter resets (the next 00:00 UTC). */
  resetAt: Date
  /** The first refusal of the day for this organization: the one that sends the notice. */
  firstRefusal: boolean
  /** The plan's own limit: what the organization gets once claimed; null when unlimited. */
  planLimit: number | null
}

/** The UTC calendar day (`YYYY-MM-DD`) that usage is counted in. */
export const utcDay = (now: Date): string => now.toISOString().slice(0, 10)

/** Seconds from `now` until `resetAt` (at least 1). */
export const secondsUntil = (resetAt: Date, now: Date = new Date()): number =>
  Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000))

/** A limit as a number, or null for `"unlimited"` (the Team plan, or a staff override). */
const cap = (limit: number | "unlimited"): number | null => (limit === "unlimited" ? null : limit)

export interface Meter {
  /** Whether the organization is claimed. */
  status(caller: Caller): Promise<OrgStatus>
  /** Count one call. Outside any transaction (entitlements refuses to consume inside one). */
  consume(caller: Caller): Promise<Reading>
  /** The organization's calls so far today and its limit; consumes nothing. */
  usageToday(
    caller: Caller,
    now?: Date,
  ): Promise<{ day: string; total: number; limit: number | null }>
  /** The daily limit an organization has now (signup reports the new organization's); null = unlimited. */
  limitOf(organizationId: string): Promise<number | null>
}

export function createMeter({
  db,
  entitlements,
}: {
  db: Database
  entitlements: PlanEntitlements
}): Meter {
  // The lookup is memoized per caller object, which is created once per REST request or MCP call.
  const statuses = new WeakMap<Caller, Promise<OrgStatus>>()

  function status(caller: Caller): Promise<OrgStatus> {
    let cached = statuses.get(caller)
    if (!cached) {
      cached = organizationClaimed(db, caller.organizationId).then((claimed) => ({ claimed }))
      statuses.set(caller, cached)
    }
    return cached
  }

  return {
    status,
    async limitOf(organizationId) {
      return cap((await entitlements.getLimit(organizationId, REQUESTS)).limit)
    },
    async consume(caller) {
      const r = await entitlements.consumeUsage(caller.organizationId, REQUESTS)
      return {
        allowed: r.allowed,
        reason: r.reason,
        limit: cap(r.limit),
        used: r.used,
        remaining: cap(r.remaining),
        resetAt: r.resetAt,
        firstRefusal: r.firstRefusal,
        planLimit: cap(catalog.plans[r.plan].limits.requests),
      }
    },
    async usageToday(caller, now = new Date()) {
      const r = await entitlements.getLimit(caller.organizationId, REQUESTS)
      return { day: utcDay(now), total: r.used, limit: cap(r.limit) }
    },
  }
}
