// The OpenFeature Remote Evaluation Protocol (OFREP, github.com/open-feature/protocol), so any
// OpenFeature SDK evaluates this product's flags through its OFREP provider: the web app does,
// with @openfeature/ofrep-web-provider. Not in the operation registry: OFREP fixes its own paths,
// error bodies ({ key, errorCode }) and ETag caching, which an operation can't express. Like
// /api/auth/*, it is a protocol route; it authenticates with resolvePrincipal like every other.
//
// Evaluations are always for the caller's own organization: the context's targetingKey is
// replaced by it, so a client can't read another organization's flags by naming it.
import type { Caller } from "@proof/api"
import { AppError } from "@proof/errors"
import { type Evaluation, isFlagKey, murmur3 } from "@proof/flags"
import type { Env, Hono } from "hono"

import type { FlagService } from "./flags"

/** OFREP's success body for one flag. `metadata` stays empty: no rollout detail leaves the API. */
const success = (e: Evaluation) => ({
  key: e.key,
  value: e.value,
  reason: e.reason,
  variant: e.variant,
  metadata: {},
})

/** A weak validator for the bulk body: the same evaluations give the same tag. */
const etagOf = (evaluations: readonly Evaluation[]) =>
  `W/"${murmur3(JSON.stringify(evaluations.map(success))).toString(16)}"`

export function mountOfrep<E extends Env>(
  app: Hono<E>,
  {
    flags,
    authenticate,
  }: { flags: FlagService; authenticate: (req: Request) => Promise<Caller | null> },
) {
  async function callerOf(req: Request): Promise<Caller> {
    const caller = await authenticate(req)
    if (!caller)
      throw new AppError("UNAUTHORIZED", "Send an API key, OAuth access token or session")
    return caller
  }

  app.post("/ofrep/v1/evaluate/flags/:key", async (c) => {
    const caller = await callerOf(c.req.raw)
    const key = c.req.param("key")
    const evaluation = isFlagKey(key) ? await flags.evaluate(caller, key) : null
    if (!evaluation) {
      return c.json(
        { key, errorCode: "FLAG_NOT_FOUND", errorDetails: `No flag ${key} in this build` },
        404,
      )
    }
    return c.json(success(evaluation))
  })

  app.post("/ofrep/v1/evaluate/flags", async (c) => {
    const caller = await callerOf(c.req.raw)
    const evaluations = await flags.evaluateAll(caller)
    const etag = etagOf(evaluations)
    c.header("etag", etag)
    c.header("cache-control", "private, no-cache")
    if (c.req.header("if-none-match") === etag) return c.body(null, 304)
    return c.json({ flags: evaluations.map(success) })
  })
}
