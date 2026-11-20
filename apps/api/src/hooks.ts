// Cross-cutting behaviour for every operation call, REST and MCP alike, wired through `invoke`'s hooks:
//   - metering: every call counts toward its organization's daily limit (the plan's, lower while
//     unclaimed; @byo-oss/entitlements consumeUsage, so a refused call counts nothing)
//   - idempotency: a non-readOnly call with an Idempotency-Key runs once; retries replay its response
//   - audit: every non-readOnly call is recorded with its outcome (including refusals made here)
//   - permission hints: a FORBIDDEN names the OAuth scope or API key permission that would allow it
//   - fresh sessions: a `fresh` operation refuses a session that signed in over an hour ago
//   - operator operations: only the operator organization's callers may run them
//   - analytics: every call is an `operation.called` event, except a person's reads in the web app
import { createHash } from "node:crypto"

import {
  type AnyOperation,
  type Caller,
  covers,
  formatPermissions,
  type InvokeEvent,
  type InvokeOptions,
  type InvokeOutcome,
  type OperationContext,
  type PermissionSet,
} from "@proof/api"
import { type Analytics, noopAnalytics } from "@proof/analytics"
import { isFresh, OAUTH_SCOPE_GRANTS, OAUTH_SCOPES } from "@proof/auth"
import type { Database } from "@proof/db"
import { AppError, type ErrorCode, reportError } from "@proof/errors"

import { recordAuditEvent } from "./data/audit"
import {
  completeIdempotencyKey,
  releaseIdempotencyKey,
  reserveIdempotencyKey,
} from "./data/idempotency"
import { type Meter, type Reading, secondsUntil, utcDay } from "./meter"
import type { ApiNotifier } from "./notifications"
import { actsForOperator, inCallerOrg, type Operator } from "./tenant"

export interface ApiHooks {
  /** Pass to `invoke` (REST) and `createMcpHandler` (MCP). */
  invokeOptions: InvokeOptions
  /** RateLimit-* headers for a call that was metered; empty otherwise. Read after `invoke` returns. */
  rateLimitHeaders(ctx: OperationContext): Record<string, string>
}

const isMutating = (op: AnyOperation) => op.hints?.readOnly !== true

/** JSON with sorted keys, so the same input always hashes the same way. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v ?? null)).join(",")}]`
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

/**
 * The hash an Idempotency-Key is bound to: the operation, who is calling, and the validated input.
 * The actor is part of it, so one credential's key can't replay another actor's response (a key
 * minted for someone else must never be handed back).
 */
export const requestHash = (operation: string, actor: Caller["actor"], input: unknown): string =>
  createHash("sha256").update(stableJson({ operation, actor, input })).digest("hex")

/** Names the OAuth scopes (and API key permission) that would allow what the caller lacks. */
export function permissionHint(missing: PermissionSet): string {
  const needed = formatPermissions(missing)
  const scopes = OAUTH_SCOPES.filter((s) => covers(OAUTH_SCOPE_GRANTS[s], missing))
  const via =
    scopes.length > 0
      ? `an OAuth token with scope ${scopes.map((s) => `\`${s}\``).join(" or ")}, or an API key with ${needed}`
      : `an API key with ${needed} (no OAuth scope grants it)`
  return `Needs ${needed}. Use ${via}.`
}

/**
 * A `fresh` operation needs a session that signed in recently (`isFresh`, one hour). Only a session
 * caller is checked: an API key or OAuth token has no sign-in age, so it passes. A session whose age
 * is unknown counts as stale. Runs before metering and idempotency, so a refusal costs nothing and a
 * stored response is not replayed to a stale session.
 */
export function assertFreshSession(op: AnyOperation, caller: Caller, now: Date = new Date()): void {
  if (op.fresh !== true || caller.via !== "session") return
  if (caller.sessionCreatedAt && isFresh(caller.sessionCreatedAt, now.getTime())) return
  throw new AppError("SESSION_NOT_FRESH", "This action needs a recent sign-in", {
    hint: "Sign in again to confirm it's you, then retry. The sign-in must be under an hour old.",
    context: { operation: op.name },
  })
}

export function createApiHooks({
  db,
  meter,
  secret,
  notifier,
  operator,
  analytics = noopAnalytics,
}: {
  db: Database
  meter: Meter
  /** The operator organization: only its callers may run `audience: "operator"` operations. */
  operator?: Operator
  /** The server secret (BETTER_AUTH_SECRET): idempotency records are keyed and sealed with it. */
  secret: string
  /** Sends usage.limit_reached. Without it the limit is enforced but nobody is told. */
  notifier?: ApiNotifier
  /** Where `operation.called` goes. Default: nowhere. */
  analytics?: Analytics
}): ApiHooks {
  const readings = new WeakMap<OperationContext, Reading>()
  // Keys this call reserved; completed or released in `after`.
  const reserved = new WeakMap<OperationContext, string>()

  async function audit(op: AnyOperation, ctx: OperationContext, outcome: "ok" | ErrorCode) {
    const { caller } = ctx
    try {
      await inCallerOrg(caller, (org, proof) =>
        recordAuditEvent(db, org, proof, {
          actorType: caller.actor.type === "user" ? "user" : "apiKey",
          actorId: caller.actor.type === "user" ? caller.actor.userId : caller.actor.keyId,
          // The principal's clientId is the key id for an API key; audit names OAuth clients only.
          clientId: caller.via === "oauth" ? caller.clientId : undefined,
          operation: op.name,
          outcome,
          requestId: ctx.requestId,
        }),
      )
    } catch (e) {
      // An audit write that fails must not change the response the caller gets.
      reportError(e, { operation: op.name, phase: "audit" })
    }
  }

  /**
   * One `operation.called` event. A person's reads in the web app are skipped, as metering skips
   * them: they are its polling, and its page views say what the person looked at.
   */
  function track(op: AnyOperation, ctx: OperationContext, outcome: "ok" | ErrorCode) {
    const { caller } = ctx
    if (caller.via === "session" && !isMutating(op)) return
    analytics.capture(
      {
        name: "operation.called",
        properties: {
          operation: op.name,
          outcome,
          via: caller.via,
          ...(caller.via === "oauth" && caller.clientId && { oauthClientId: caller.clientId }),
        },
      },
      { actor: caller.actor, organizationId: caller.organizationId },
    )
  }

  /**
   * Tells the organization's billing managers that today's limit was reached: once per organization per
   * UTC day. Entitlements marks the first refusal of the period (`firstRefusal`, counted in the same
   * guarded write as the refusal), so concurrent refusals send one notice between them. Never fails
   * the refusal.
   */
  async function noticeLimitReached(caller: Caller, limit: number): Promise<void> {
    if (!notifier) return
    try {
      await inCallerOrg(caller, (org, proof) =>
        notifier.inOrg(org, proof, { type: "usage.limit_reached", limit }),
      )
    } catch (error) {
      reportError(error, { phase: "notify", notification: "usage.limit_reached" })
    }
  }

  /** Counts the call against the organization's day, refusing it over the limit. */
  async function consume(_op: AnyOperation, ctx: OperationContext): Promise<void> {
    const reading = await meter.consume(ctx.caller)
    readings.set(ctx, reading)
    if (reading.allowed) return
    const { resetAt } = reading
    // A refusal always has a number: an unlimited plan is never refused.
    const limit = reading.limit ?? 0
    const day = utcDay(new Date(resetAt.getTime() - 1))
    const resetIn = secondsUntil(resetAt)
    if (reading.firstRefusal) await noticeLimitReached(ctx.caller, limit)
    const { claimed } = await meter.status(ctx.caller)
    const raised =
      reading.planLimit === null
        ? "lift the limit"
        : `raise the limit to ${reading.planLimit} per day`
    throw new AppError(
      "RATE_LIMITED",
      `Daily request limit of ${limit} reached for this organization (${day}, UTC)`,
      {
        hint:
          claimed || (reading.planLimit !== null && reading.planLimit <= limit)
            ? "The counter resets at 00:00 UTC. Retry after the Retry-After seconds."
            : `The owner has not verified their email yet, so the limit is ${limit} per day. ` +
              `Verify it (the claim link from signup) to ${raised}, ` +
              "or retry after the Retry-After seconds.",
        headers: { "retry-after": String(resetIn) },
        context: { limit, day },
      },
    )
  }

  async function before(e: InvokeEvent): Promise<{ result: unknown } | undefined> {
    const { op, input, ctx } = e
    const mutating = isMutating(op)
    try {
      assertFreshSession(op, ctx.caller)
      // A person's reads in the web app aren't metered: its polling (inbox, running count, live
      // runs) would spend the agents' daily budget otherwise. Writes count for every caller, so a
      // session cookie can't script around the limit.
      if (ctx.caller.via !== "session" || mutating) await consume(op, ctx)

      if (!mutating || ctx.idempotencyKey === undefined) return undefined
      const key = ctx.idempotencyKey
      const state = await inCallerOrg(ctx.caller, (org, proof) =>
        reserveIdempotencyKey(db, org, proof, {
          secret,
          key,
          operation: op.name,
          requestHash: requestHash(op.name, ctx.caller.actor, input),
        }),
      )
      if (state.state === "done") return { result: state.response }
      if (state.state === "in_progress") {
        throw new AppError("CONFLICT", "A request with this Idempotency-Key is still running", {
          hint:
            "Wait a moment, then retry with the same Idempotency-Key and the same body. A call " +
            "that never finished frees its key after 5 minutes.",
        })
      }
      if (state.state === "mismatch") {
        throw new AppError(
          "CONFLICT",
          "This Idempotency-Key was already used for a different request",
          {
            hint: "Use a new Idempotency-Key for a new request. To repeat this exact request, send the same body and operation.",
          },
        )
      }
      reserved.set(ctx, key)
      return undefined
    } catch (err) {
      // `after` does not run for errors thrown here, so refusals are audited on the way out.
      if (
        mutating &&
        err instanceof AppError &&
        (err.code === "RATE_LIMITED" || err.code === "CONFLICT" || err.code === "SESSION_NOT_FRESH")
      ) {
        await audit(op, ctx, err.code)
      }
      if (err instanceof AppError) track(op, ctx, err.code)
      throw err
    }
  }

  async function after(e: InvokeEvent & { outcome: InvokeOutcome }): Promise<void> {
    const { op, ctx, outcome } = e
    const key = reserved.get(ctx)
    try {
      if (key !== undefined) {
        reserved.delete(ctx)
        await inCallerOrg(ctx.caller, (org, proof) =>
          outcome.ok
            ? completeIdempotencyKey(db, org, proof, { secret, key, response: outcome.result })
            : releaseIdempotencyKey(db, org, proof, { secret, key }),
        )
      }
    } finally {
      const result = outcome.ok ? "ok" : outcome.error.code
      track(op, ctx, result)
      if (isMutating(op)) await audit(op, ctx, result)
    }
  }

  return {
    invokeOptions: {
      hooks: { before, after },
      permissionHint,
      isOperator: operator ? actsForOperator(operator) : undefined,
    },
    rateLimitHeaders(ctx): Record<string, string> {
      const r: Reading | undefined = readings.get(ctx)
      // No pair for an unlimited plan: there is no limit or remaining count to report.
      if (!r || r.limit === null || r.remaining === null) return {}
      return {
        "ratelimit-limit": String(r.limit),
        "ratelimit-remaining": String(Math.max(0, r.remaining)),
        "ratelimit-reset": String(secondsUntil(r.resetAt)),
      }
    },
  }
}
