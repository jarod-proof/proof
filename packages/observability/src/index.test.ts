import { AppError, setErrorReporter } from "@proof/errors"
import { createLogger } from "@proof/logger"
import { afterEach, describe, expect, it, vi } from "vitest"
import { REQUEST_ID_HEADER, createHealthHandler, observe, requestIdFrom } from "./index"

function capture() {
  const lines: (Record<string, unknown> & { req?: { headers?: unknown } })[] = []
  const logger = createLogger({
    level: "info",
    destination: { write: (s: string) => void lines.push(JSON.parse(s)) },
  })
  return { logger, lines }
}

const get = (path = "/", init?: RequestInit) => new Request(`http://localhost${path}`, init)

afterEach(() => setErrorReporter(undefined))

describe("requestIdFrom", () => {
  it("reuses a safe incoming id", () => {
    expect(requestIdFrom(new Headers({ [REQUEST_ID_HEADER]: "abc-123_X.y" }))).toBe("abc-123_X.y")
  })

  it.each(["has space", "a".repeat(65), "<script>", ""])("replaces an unsafe id (%j)", (bad) => {
    const id = requestIdFrom(new Headers({ [REQUEST_ID_HEADER]: bad }))
    expect(id).not.toBe(bad)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("mints an id when none is sent", () => {
    expect(requestIdFrom(new Headers())).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe("observe", () => {
  it("passes the response through with a request id and logs one access line", async () => {
    const { logger, lines } = capture()
    const handler = observe(
      (_req, { requestId, log }) => {
        log.info("inside")
        return new Response(requestId, { status: 201, headers: { "x-custom": "1" } })
      },
      { logger },
    )

    const res = await handler(get("/things?token=secret", { method: "POST" }))
    const id = res.headers.get(REQUEST_ID_HEADER)

    expect(res.status).toBe(201)
    expect(res.headers.get("x-custom")).toBe("1")
    expect(await res.text()).toBe(id)
    expect(lines.map((l) => l.msg)).toEqual(["inside", "request"])
    expect(lines.every((l) => l.requestId === id)).toBe(true)
    expect(lines[1]).toMatchObject({ method: "POST", path: "/things", status: 201 })
    expect(JSON.stringify(lines)).not.toContain("secret")
  })

  it("echoes a safe incoming request id", async () => {
    const { logger } = capture()
    const handler = observe(() => new Response("ok"), { logger })
    const res = await handler(get("/", { headers: { [REQUEST_ID_HEADER]: "from-edge-1" } }))
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe("from-edge-1")
  })

  it("turns an exposed 4xx into a public body, logs a warning, and does not report it", async () => {
    const { logger, lines } = capture()
    const reporter = vi.fn()
    setErrorReporter(reporter)
    const handler = observe(
      () => {
        throw new AppError("NOT_FOUND", "No such thing", { context: { thingId: "t1" } })
      },
      { logger },
    )

    const res = await handler(get("/things/t1"))
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body).toEqual({
      error: { code: "NOT_FOUND", message: "No such thing" },
      requestId: res.headers.get(REQUEST_ID_HEADER),
    })
    expect(lines.at(-1)).toMatchObject({
      level: 40,
      msg: "request rejected",
      status: 404,
      thingId: "t1",
    })
    expect(reporter).not.toHaveBeenCalled()
  })

  it("reports and logs a 5xx the handler returns, and passes the response through", async () => {
    const { logger, lines } = capture()
    const reporter = vi.fn()
    setErrorReporter(reporter)
    const handler = observe(() => new Response("upstream down", { status: 502 }), { logger })

    const res = await handler(get("/proxy"))
    expect(res.status).toBe(502)
    expect(await res.text()).toBe("upstream down")
    expect(reporter).toHaveBeenCalledTimes(1)
    expect(lines.at(-1)).toMatchObject({ level: 50, status: 502, path: "/proxy" })
  })

  it("sends the error's own headers, such as retry-after on a 429", async () => {
    const { logger } = capture()
    const handler = observe(
      () => {
        throw new AppError("RATE_LIMITED", "Slow down", { headers: { "retry-after": "30" } })
      },
      { logger },
    )

    const res = await handler(get("/"))
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe("30")
    expect(res.headers.get(REQUEST_ID_HEADER)).toBeTruthy()
  })

  it("hides an unknown error's message, reports it, and logs only allowlisted headers", async () => {
    const { logger, lines } = capture()
    const reporter = vi.fn()
    setErrorReporter(reporter)
    const handler = observe(
      () => {
        throw new Error("connection to db-7 refused")
      },
      { logger },
    )

    const res = await handler(
      get("/boom", {
        headers: {
          authorization: "Bearer s3cret",
          cookie: "sid=s3cret",
          "x-api-key": "s3cret",
          "x-csrf-token": "s3cret",
          "user-agent": "vitest",
        },
      }),
    )
    const body = await res.json()
    const requestId = res.headers.get(REQUEST_ID_HEADER)

    expect(res.status).toBe(500)
    expect(body).toEqual({ error: { code: "INTERNAL", message: "Internal error" }, requestId })
    expect(JSON.stringify(body)).not.toContain("db-7")

    const line = lines.at(-1)
    expect(line).toMatchObject({ level: 50, msg: "request failed", status: 500 })
    expect(line?.req?.headers).toEqual({ "user-agent": "vitest" })
    expect(JSON.stringify(lines)).not.toContain("s3cret")

    expect(reporter).toHaveBeenCalledOnce()
    expect(reporter.mock.calls[0]?.[1]).toMatchObject({ requestId, method: "GET", path: "/boom" })
  })

  it("forwards the framework's extra arguments to the handler", async () => {
    const { logger } = capture()
    const handler = observe(
      async (_req, _ctx, route: { params: Promise<{ id: string }> }) =>
        new Response((await route.params).id),
      { logger },
    )
    const res = await handler(get("/things/t9"), { params: Promise.resolve({ id: "t9" }) })
    expect(await res.text()).toBe("t9")
  })

  it("reports an AppError that is not exposed even if its status is 4xx", async () => {
    const { logger } = capture()
    const reporter = vi.fn()
    setErrorReporter(reporter)
    const handler = observe(
      () => {
        throw new AppError("BAD_REQUEST", "internal detail", { expose: false })
      },
      { logger },
    )

    const res = await handler(get())
    expect(res.status).toBe(400)
    expect((await res.json()).error.message).toBe("Internal error")
    expect(reporter).toHaveBeenCalledOnce()
  })

  it("still responds when the error reporter throws", async () => {
    const { logger } = capture()
    setErrorReporter(() => {
      throw new Error("reporter down")
    })
    const handler = observe(
      () => {
        throw new Error("x")
      },
      { logger },
    )
    expect((await handler(get())).status).toBe(500)
  })
})

describe("createHealthHandler", () => {
  it("returns 200 when every check passes, including sync checks", async () => {
    const health = createHealthHandler({ db: async () => 1, cache: () => true })
    const res = await health()
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ status: "ok", checks: { db: "ok", cache: "ok" } })
  })

  it("returns 503, names the failing check, and keeps the error out of the body", async () => {
    const { logger, lines } = capture()
    const health = createHealthHandler(
      {
        db: async () => {
          throw new Error("password=hunter2 refused")
        },
        cache: () => true,
      },
      { logger },
    )
    const res = await health()
    const text = await res.text()
    expect(res.status).toBe(503)
    expect(JSON.parse(text)).toEqual({ status: "degraded", checks: { db: "fail", cache: "ok" } })
    expect(text).not.toContain("hunter2")
    expect(lines[0]).toMatchObject({ msg: "health check failed", check: "db" })
  })

  it("fails a check that exceeds the timeout", async () => {
    const health = createHealthHandler({ slow: () => new Promise(() => {}) }, { timeoutMs: 20 })
    const res = await health()
    expect(res.status).toBe(503)
    expect((await res.json()).checks.slow).toBe("fail")
  })

  it("is healthy with no checks", async () => {
    expect((await createHealthHandler({})()).status).toBe(200)
  })
})
