import { beforeEach, describe, expect, it, vi } from "vitest"

import { BOOT_REFUSED_BODY, createLazyHq, type HqFetch } from "./lazy-hq"

const logged: { err: unknown; message: string }[] = []
const log = {
  error: (fields: { err: unknown }, message: string) => void logged.push({ ...fields, message }),
}
const lazy = (boot: () => Promise<HqFetch>) => createLazyHq(boot, log)

const ok: HqFetch = { fetch: () => new Response("hq", { status: 200 }) }
const get = async (app: ReturnType<typeof lazy>, path = "/v1/status") =>
  app.request(`http://hq.test${path}`)

beforeEach(() => {
  logged.length = 0
})

describe("createLazyHq", () => {
  it("boots nothing when it is created (the function loads the entry before any request)", () => {
    const boot = vi.fn(async () => ok)
    lazy(boot)
    expect(boot).not.toHaveBeenCalled()
  })

  it("serves nothing until the boot has finished, and boots once for concurrent requests", async () => {
    let finish: (hq: HqFetch) => void = () => undefined
    const boot = vi.fn(() => new Promise<HqFetch>((resolve) => (finish = resolve)))
    const app = lazy(boot)
    const served = vi.fn(() => new Response("hq"))

    const pending = [get(app, "/a"), get(app, "/b"), get(app, "/c")]
    // Let the requests reach the boot: none may be answered, or reach hq, before it resolves.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(boot).toHaveBeenCalledTimes(1)
    expect(served).not.toHaveBeenCalled()

    finish({ fetch: served })
    const replies = await Promise.all(pending)
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200])
    expect(served).toHaveBeenCalledTimes(3)
    await get(app)
    expect(boot).toHaveBeenCalledTimes(1)
  })

  it("hands hq the original request, method, headers and body intact", async () => {
    const seen: Request[] = []
    const app = lazy(async () => ({
      fetch: async (request) => {
        seen.push(request)
        return new Response(await request.text(), { status: 201 })
      },
    }))
    const res = await app.request("http://hq.test/v1/x?y=1", {
      method: "POST",
      headers: { "x-api-key": "k" },
      body: "payload",
    })
    expect(res.status).toBe(201)
    expect(await res.text()).toBe("payload")
    expect(seen[0]?.url).toBe("http://hq.test/v1/x?y=1")
    expect(seen[0]?.headers.get("x-api-key")).toBe("k")
  })

  for (const [name, boot] of [
    [
      "rejects",
      async (): Promise<HqFetch> => {
        throw new Error("HQ_ALLOW_SIGNUP is on in a deployed hq: postgres://user:pw@host/db")
      },
    ],
    [
      "throws before it returns a promise",
      (): Promise<HqFetch> => {
        throw new Error("HQ_DATABASE_URL is not set")
      },
    ],
  ] as const) {
    it(`a boot that ${name} fails every request closed, once, and is never retried`, async () => {
      const spy = vi.fn(boot)
      const app = lazy(spy)
      const replies = await Promise.all([get(app, "/"), get(app, "/v1/status"), get(app, "/mcp")])
      // A request long after the boot failed gets the same refusal, and no second attempt.
      replies.push(
        await get(app, "/v1/entries"),
        await app.request("http://hq.test/", { method: "POST" }),
      )
      for (const res of replies) {
        expect(res.status).toBe(503)
        expect(res.headers.get("cache-control")).toBe("no-store")
        const text = await res.text()
        expect(text).toBe(BOOT_REFUSED_BODY)
        // Nothing of the reason reaches a caller.
        expect(text).not.toMatch(/HQ_|postgres|signup|SIGNUP/i)
      }
      expect(spy).toHaveBeenCalledTimes(1)
      // The reason goes to the log, once.
      expect(logged).toHaveLength(1)
      expect(logged.map((entry) => String(entry.err)).join()).toMatch(/HQ_/)
    })
  }
})
