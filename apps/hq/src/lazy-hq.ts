// The Vercel entry's shell: a Hono app that boots hq on the first request of an instance and
// answers every request through that boot, or refuses every request if the boot did.
import { createLogger } from "@proof/logger"
import { Hono } from "hono"

const logger = createLogger({ name: "hq" })

/** Anything with a web-standard `fetch`: hq's app. */
export interface HqFetch {
  fetch(request: Request): Response | Promise<Response>
}

/** What a refused boot answers, byte for byte: no reason, no variable name, no version. */
export const BOOT_REFUSED_BODY = JSON.stringify({ error: "service unavailable" })

function bootRefused(): Response {
  return new Response(BOOT_REFUSED_BODY, {
    status: 503,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}

/**
 * A Hono app that is hq once `boot` has resolved, and a 503 forever if it did not.
 *
 *  - One boot per instance: the promise is made by the first request and every request, including
 *    those that arrive while it runs, awaits that same promise. Nothing is served before it
 *    resolves, so no request ever meets a founders table that has not been synced.
 *  - A boot that rejects (an unsafe environment, sign-up open in a deployed hq, a bad variable, a
 *    failed sync) is kept: the rejected promise is not replaced, so the instance cannot retry its
 *    way into a half-configured state. Every request is answered 503 with `BOOT_REFUSED_BODY`; the
 *    reason goes to the log once, never to the caller. A fixed environment takes a new deployment
 *    (a fresh instance boots again).
 *  - Nothing runs when this is called: the function loads the entry when an instance starts, before
 *    any request, and a boot there would read the environment and touch the database with no
 *    request to refuse (and a tool that imports the entry at build time would boot at build).
 */
export function createLazyHq(
  boot: () => Promise<HqFetch>,
  /** Where the refusal's reason goes. Tests pass their own. */
  log: { error(fields: { err: unknown }, message: string): void } = logger,
): Hono {
  let booted: Promise<HqFetch> | undefined
  const start = (): Promise<HqFetch> =>
    // `Promise.resolve().then` turns a boot that throws synchronously into a rejection too.
    Promise.resolve()
      .then(boot)
      .catch((error: unknown) => {
        log.error({ err: error }, "hq refused to boot: every request is answered 503")
        throw error
      })

  const app = new Hono()
  app.all("*", async (c) => {
    booted ??= start()
    let hq: HqFetch
    try {
      hq = await booted
    } catch {
      return bootRefused()
    }
    return hq.fetch(c.req.raw)
  })
  return app
}
