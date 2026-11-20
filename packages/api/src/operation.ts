import { AppError, type ErrorCode, reportError, toAppError } from "@proof/errors"
import { z } from "zod"

import { allowed, isEmpty, type PermissionSet, type PermissionsOf } from "./permissions"

/**
 * Who is calling, for which organization, and what they may do there. `Principal` from
 * `@proof/auth` satisfies this; the registry doesn't depend on auth.
 */
export interface Caller {
  organizationId: string
  actor: { type: "user"; userId: string } | { type: "apiKey"; keyId: string }
  /** Allowed when one grant covers the whole request (see `allowed`). */
  grants: readonly PermissionSet[]
  via: string
  clientId?: string
  /** When a session caller's session was created. Absent for API keys and OAuth tokens. */
  sessionCreatedAt?: Date
}

/** The context of an operation that needs a credential (the default): the caller acts in its org. */
export interface OperationContext {
  caller: Caller
  requestId?: string
  /** Client-chosen key for safe retries of non-readOnly operations (see `Idempotency-Key`). */
  idempotencyKey?: string
}

/**
 * The context of a public operation (`auth: "none"`): there is no caller, only what the request says
 * about where it came from. `ip` is the client address, for limits on anonymous calls.
 */
export interface PublicContext {
  caller?: undefined
  public: { ip: string }
  requestId?: string
}

/** The context a handler gets, by its operation's `auth`: a caller unless the operation is public. */
export type HandlerContext<A> = A extends "none" ? PublicContext : OperationContext

export interface InvokeEvent {
  op: AnyOperation
  input: unknown
  ctx: OperationContext
}

export interface InvokeHooks {
  /**
   * After permission + input validation, before the handler. Return `{ result }` to short-circuit: the
   * handler is skipped and `result` is returned as stored (a replay), without output validation, because
   * it was validated when first produced. Throwing an AppError aborts the call (e.g. CONFLICT,
   * RATE_LIMITED); `after` does not run then, since the handler was never reached.
   */
  before?(e: InvokeEvent): Promise<{ result: unknown } | undefined | void>
  /**
   * Runs once per call that reached the handler or was short-circuited, with the outcome. Errors thrown
   * here are reported via `reportError` and swallowed: they never change what the caller receives.
   */
  after?(e: InvokeEvent & { outcome: InvokeOutcome }): Promise<void>
}

export type InvokeOutcome =
  | { ok: true; result: unknown; replayed: boolean }
  | { ok: false; error: AppError }

export interface InvokeOptions {
  hooks?: InvokeHooks
  /**
   * Text for FORBIDDEN hints, e.g. "Needs project:read; OAuth scope `read` or an API key with project:read".
   * Receives the permissions the caller lacks, measured against their closest grant.
   */
  permissionHint?: (missing: PermissionSet) => string
  /**
   * Whether the caller acts for the operator organization, for `audience: "operator"` operations.
   * Omitted, no caller is the operator, so those operations are refused to everyone.
   */
  isOperator?: (caller: Caller) => boolean
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

type AnyObject = z.ZodObject<z.ZodRawShape>

/**
 * Who may call an operation. Omitted, a credential is required (an API key or OAuth token), and the
 * handler gets a `caller`.
 *
 * `"person"` is for what only a signed-in person does for themselves (their own avatar): the web
 * app's session, never an API key or OAuth token. Such an operation:
 *   - is refused with FORBIDDEN to any other caller, before its input is read;
 *   - is served over REST only, not as an MCP tool (agents never hold a session);
 *   - runs the invoke hooks like any other, and is documented with the session cookie as its security.
 *
 * `"none"` makes the operation public, for the few that exist before anyone has an account (signup).
 * A public operation:
 *   - has no organization, so `permissions` must be `{}` (`defineOperation` throws otherwise);
 *   - is served over REST only, not as an MCP tool (calling it by name is "unknown tool");
 *   - runs no invoke hooks: no metering, no Idempotency-Key, no audit. Its handler gets a
 *     `PublicContext` with the client's `ip` and no caller;
 *   - is documented with `security: []` in OpenAPI, and listed as needing no credential in llms.txt.
 * A credential sent with a public operation is ignored.
 */
export type OperationAuth = "none" | "person"

/**
 * `"operator"` is for what only the operator organization does: the one that runs the product
 * (managing feature flags). Such an operation:
 *   - is refused with FORBIDDEN, before its permissions or input are checked, to a caller who does
 *     not act for the operator organization (`InvokeOptions.isOperator`);
 *   - is an MCP tool only for callers in the operator organization;
 *   - is left out of llms.txt and llms-full.txt, which customers' agents read, and documented in
 *     OpenAPI with `x-audience: operator` (the operator's own CLI and SDK read it there).
 */
export type OperationAudience = "operator"

export interface OperationSpec<
  I extends AnyObject,
  O extends z.ZodType,
  P = PermissionSet,
  A extends OperationAuth | undefined = undefined,
> {
  /** snake_case. The MCP tool name and the OpenAPI operationId. */
  name: string
  method: HttpMethod
  /** Hono-style path, e.g. `/v1/notes/:id`. Path params must be keys of `input`. */
  path: string
  /** One line: what it does. Shown in tool lists and llms.txt. */
  summary: string
  /** Written for an agent: when to use it, what it returns, what to call next. */
  description: string
  /** Required permissions, all of them, in the caller's organization. `{}` means any caller. */
  permissions: P
  /** Omitted: a credential is required. `"person"`: web app only; `"none"`: public (see `OperationAuth`). */
  auth?: A
  /** `"operator"`: only the operator organization may call it (see `OperationAudience`). */
  audience?: OperationAudience
  /**
   * Path params, query and JSON body are merged into one object and validated against this.
   * Query values arrive as strings: use `z.coerce` for numbers and booleans in GET operations.
   */
  input: I
  output: O
  /** Hints for agents (MCP tool annotations). */
  hints?: { readOnly?: boolean; destructive?: boolean; idempotent?: boolean }
  /**
   * A sensitive action: a session caller must have signed in recently (FRESH_AGE_SECONDS in
   * `@proof/auth`), or the call is refused with SESSION_NOT_FRESH. API keys and OAuth tokens have no
   * sign-in age, so they are not checked. Enforced by the invoke hooks in apps/api.
   */
  fresh?: true
  /**
   * Shown in llms-full.txt; the first becomes the OpenAPI example. Contract tests run each one as an
   * organization owner: `output` must validate, and `error` documents an expected failure instead.
   */
  examples?: { input: z.input<I>; output?: z.input<O>; error?: ErrorCode }[]
  // Method syntax keeps the handler's parameters bivariant, so typed operations fit in one list.
  handler(input: z.output<I>, ctx: HandlerContext<A>): Promise<z.input<O>> | z.input<O>
}

export type Operation<
  I extends AnyObject = AnyObject,
  O extends z.ZodType = z.ZodType,
  A extends OperationAuth | undefined = undefined,
> = OperationSpec<I, O, PermissionSet, A>

// An array of differently-typed operations needs this escape hatch.
export type AnyOperation = Operation<any, any, OperationAuth | undefined>

const NAME = /^[a-z][a-z0-9_]{0,63}$/

/** Declare an operation once; REST routes, MCP tools, OpenAPI and llms.txt are generated from it. */
export function defineOperation<
  I extends AnyObject,
  O extends z.ZodType,
  A extends OperationAuth | undefined = undefined,
>(spec: OperationSpec<I, O, PermissionSet, A>): Operation<I, O, A> {
  for (const [resource, actions] of Object.entries(spec.permissions)) {
    if (actions.length === 0) throw new Error(`${spec.name}: no actions listed for ${resource}`)
  }
  if (spec.auth === "none" && Object.keys(spec.permissions).length > 0) {
    throw new Error(`${spec.name}: a public operation (auth: "none") takes no permissions`)
  }
  if (spec.audience === "operator" && spec.auth === "none") {
    throw new Error(`${spec.name}: an operator operation needs a caller; it can't be public`)
  }
  if (!NAME.test(spec.name)) throw new Error(`Operation name must be snake_case: ${spec.name}`)
  for (const param of pathParams(spec.path)) {
    if (!(param in spec.input.shape)) {
      throw new Error(`${spec.name}: path param :${param} is not in the input schema`)
    }
  }
  return spec
}

/**
 * `defineOperation` with permissions checked against a catalog at compile time:
 * `const defineOperation = operationsFor<Catalog>()`, then `permissions: { project: ["read"] }`.
 */
export function operationsFor<C extends PermissionSet>() {
  return <
    I extends AnyObject,
    O extends z.ZodType,
    A extends OperationAuth | undefined = undefined,
  >(
    spec: OperationSpec<I, O, PermissionsOf<C>, A>,
  ): Operation<I, O, A> => defineOperation(spec as OperationSpec<I, O, PermissionSet, A>)
}

/** Names of `:params` in a path. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] ?? "")
}

/** Check names are unique and method+path pairs don't collide. Call once at startup. */
export function defineRegistry<const T extends readonly AnyOperation[]>(ops: T): T {
  const names = new Set<string>()
  const routes = new Set<string>()
  for (const op of ops) {
    if (names.has(op.name)) throw new Error(`Duplicate operation name: ${op.name}`)
    const route = `${op.method} ${op.path.replace(/:[A-Za-z0-9_]+/g, ":")}`
    if (routes.has(route)) throw new Error(`Duplicate route: ${op.method} ${op.path}`)
    names.add(op.name)
    routes.add(route)
  }
  return ops
}

/**
 * Throws FORBIDDEN, with the permission hint, unless the caller's grants cover the operation. `invoke`
 * runs it first; a surface that reads its own arguments (MCP's idempotencyKey) runs it before those.
 */
export function assertAllowed(
  op: AnyOperation,
  caller: Caller,
  options: Pick<InvokeOptions, "permissionHint"> = {},
): void {
  if (allowed(caller.grants, op.permissions)) return
  const missing = missingPermissions(caller.grants, op.permissions)
  throw new AppError("FORBIDDEN", `Missing permission: ${formatPermissions(missing)}`, {
    context: { operation: op.name, organizationId: caller.organizationId },
    hint: options.permissionHint?.(missing),
  })
}

/** An `auth: "person"` operation is for a signed-in person only (see `OperationAuth`). */
export function assertPerson(op: AnyOperation, caller: Caller): void {
  if (op.auth !== "person" || caller.via === "session") return
  throw new AppError("FORBIDDEN", "Only a person signed in to the web app can do this", {
    context: { operation: op.name, organizationId: caller.organizationId },
    hint: "Do it in the web app. API keys and AI clients can't call this operation.",
  })
}

/** Whether an operation's audience includes the caller (see `OperationAudience`). */
export const inAudience = (
  op: AnyOperation,
  caller: Caller,
  options: Pick<InvokeOptions, "isOperator"> = {},
): boolean => op.audience !== "operator" || options.isOperator?.(caller) === true

/** An `audience: "operator"` operation is for the operator organization only. */
export function assertAudience(
  op: AnyOperation,
  caller: Caller,
  options: Pick<InvokeOptions, "isOperator"> = {},
): void {
  if (inAudience(op, caller, options)) return
  throw new AppError("FORBIDDEN", "Only the operator organization can do this", {
    context: { operation: op.name, organizationId: caller.organizationId },
    hint: "This operation runs the product itself. Call it as a member, key or agent of the operator organization.",
  })
}

/**
 * Run an operation for a caller: check permissions, validate input, run `before` hooks, call the handler,
 * validate output, then run `after` hooks. Throws AppError (FORBIDDEN, BAD_REQUEST, or whatever a hook
 * throws); anything else the handler throws propagates unchanged.
 */
export async function invoke(
  op: AnyOperation,
  raw: unknown,
  ctx: OperationContext | PublicContext,
  options: InvokeOptions = {},
) {
  // A public operation has no caller to check and no organization for hooks to meter or audit.
  if (op.auth === "none") return runHandler(op, parseInput(op, raw), ctx)

  if (!hasCaller(ctx)) {
    throw new AppError("INTERNAL", `${op.name} needs a caller`, { context: { operation: op.name } })
  }
  assertPerson(op, ctx.caller)
  assertAudience(op, ctx.caller, options)
  assertAllowed(op, ctx.caller, options)
  const input = parseInput(op, raw)
  const event: InvokeEvent = { op, input, ctx }
  const hooks = options.hooks
  const replay = await hooks?.before?.(event)
  if (replay) {
    await runAfter(hooks, event, { ok: true, result: replay.result, replayed: true })
    return replay.result
  }
  let result: unknown
  try {
    result = await runHandler(op, input, ctx)
  } catch (e) {
    await runAfter(hooks, event, { ok: false, error: toAppError(e) })
    throw e
  }
  await runAfter(hooks, event, { ok: true, result, replayed: false })
  return result
}

const hasCaller = (ctx: OperationContext | PublicContext): ctx is OperationContext =>
  ctx.caller !== undefined

/** The input, validated against the operation's schema (BAD_REQUEST when it does not match). */
function parseInput(op: AnyOperation, raw: unknown): unknown {
  const parsed = op.input.safeParse(raw ?? {})
  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", z.prettifyError(parsed.error), {
      context: { operation: op.name },
    })
  }
  return parsed.data
}

/** The handler, with its output checked against the operation's output schema. */
async function runHandler(
  op: AnyOperation,
  input: unknown,
  ctx: OperationContext | PublicContext,
): Promise<unknown> {
  const out = op.output.safeParse(await op.handler(input, ctx))
  if (!out.success) {
    throw new AppError("INTERNAL", `${op.name} returned an invalid result`, {
      cause: out.error,
      context: { operation: op.name },
    })
  }
  return out.data
}

/** Errors from `after` are reported and dropped: they must not change the response. */
async function runAfter(
  hooks: InvokeHooks | undefined,
  event: InvokeEvent,
  outcome: InvokeOutcome,
): Promise<void> {
  if (!hooks?.after) return
  try {
    await hooks.after({ ...event, outcome })
  } catch (e) {
    reportError(e, { operation: event.op.name, phase: "after" })
  }
}

const countActions = (p: PermissionSet) => Object.values(p).reduce((n, a) => n + a.length, 0)

/**
 * The permissions a caller lacks for `need`, measured against the grant closest to covering it, so the
 * hint names the smallest missing set. With no grants at all, everything in `need` is missing.
 */
export function missingPermissions(
  grants: readonly PermissionSet[],
  need: PermissionSet,
): PermissionSet {
  if (isEmpty(need)) return {}
  const missingIn = (g: PermissionSet): Record<string, string[]> => {
    const out: Record<string, string[]> = {}
    for (const [resource, actions] of Object.entries(need)) {
      const lacking = actions.filter((a) => !g[resource]?.includes(a))
      if (lacking.length > 0) out[resource] = lacking
    }
    return out
  }
  if (grants.length === 0) return need
  return grants
    .map(missingIn)
    .reduce((best, cur) => (countActions(cur) < countActions(best) ? cur : best))
}

/** `{ project: ["read", "update"] }` -> "project:read, project:update" */
export function formatPermissions(p: PermissionSet): string {
  return Object.entries(p)
    .flatMap(([resource, actions]) => actions.map((a) => `${resource}:${a}`))
    .join(", ")
}
