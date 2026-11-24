import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { OUTPUT_CONFIG } from "../scripts/build-vercel.mjs"
import { createWebApp, SHELL_PATTERN, routeToWeb } from "./web-static"

const SHELL = "<!doctype html><div id=root></div>"
let dir = ""

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "hq-web-"))
  mkdirSync(join(dir, "assets"))
  writeFileSync(join(dir, "index.html"), SHELL)
  writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log(1)")
  writeFileSync(join(dir, "assets", "index-abc123.css"), "a{}")
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const app = () => {
  const web = createWebApp({ dir })
  if (!web) throw new Error("expected a web app")
  return web
}
const routeHeaders = (index: number) => OUTPUT_CONFIG.routes[index]?.headers ?? {}

describe("createWebApp", () => {
  it("serves the shell for the same paths the Build Output route does (one table)", async () => {
    const route = OUTPUT_CONFIG.routes.find((r) => r.dest === "/app/index.html")
    const shell = new RegExp(route?.src ?? "")
    const paths = [
      "/app",
      "/app/",
      "/app/digest",
      "/app/approvals/",
      "/app/a/b/c",
      "/app/assets/x.js",
      "/app/assets/",
      "/application",
      "/admin/proposals",
      "/v1/status",
    ]
    for (const path of paths) {
      const res = await app().request(path)
      if (shell.test(path)) {
        expect(res.status, path).toBe(200)
        expect(res.headers.get("content-type"), path).toContain("text/html")
        expect(res.headers.get("cache-control"), path).toBe("no-store")
        expect(await res.text(), path).toBe(SHELL)
      } else if (path.startsWith("/app/assets/")) {
        expect(res.status, path).toBe(404)
      } else {
        expect(res.status, path).toBe(404)
        expect(await res.text(), path).not.toBe(SHELL)
      }
    }
  })

  it("serves a hashed asset with immutable caching and an unknown asset as 404, not the shell", async () => {
    const js = await app().request("/app/assets/index-abc123.js")
    expect(js.status).toBe(200)
    expect(js.headers.get("cache-control")).toBe(routeHeaders(1)["cache-control"])
    expect(js.headers.get("content-type")).toContain("javascript")
    expect(await js.text()).toBe("console.log(1)")
    const css = await app().request("/app/assets/index-abc123.css")
    expect(css.headers.get("content-type")).toContain("text/css")

    const missing = await app().request("/app/assets/missing.js")
    expect(missing.status).toBe(404)
    expect(missing.headers.get("cache-control")).toBe("no-store")
    expect(await missing.text()).not.toBe(SHELL)
  })

  it("carries the same four security headers as config.json", async () => {
    const expected = routeHeaders(0)
    expect(Object.keys(expected)).toHaveLength(4)
    for (const path of ["/app/digest", "/app/assets/index-abc123.js", "/app/assets/missing.js"]) {
      const res = await app().request(path)
      for (const [name, value] of Object.entries(expected)) {
        expect(res.headers.get(name), `${path} ${name}`).toBe(value)
      }
    }
  })

  it("returns null without an index.html", () => {
    expect(createWebApp({ dir: join(dir, "assets") })).toBeNull()
    expect(createWebApp({ dir: join(dir, "nope") })).toBeNull()
  })

  it("never serves a path outside dir", async () => {
    // A unique name: a fixed one would collide with a parallel run or a leftover file.
    const name = `hq-web-secret-${randomUUID()}.txt`
    writeFileSync(join(dir, "..", name), "secret")
    try {
      for (const path of [
        "/app/../src/server.ts",
        "/app/%2e%2e/package.json",
        `/app/assets/..%2f..%2f${name}`,
        `/app/assets/%2e%2e/%2e%2e/${name}`,
        `/app/assets/..%5c..%5c${name}`,
        // Double-encoded dots and slashes: a second decode must not turn them into traversal.
        `/app/assets/%252e%252e/%252e%252e/${name}`,
        `/app/assets/..%252f..%252f${name}`,
        `/app/assets/%252e%252e%252f%252e%252e%252f${name}`,
        // A null byte ends a C string: nothing may serve the part before it.
        "/app/assets/index-abc123.js%00",
        "/app/assets/index-abc123.js%00.png",
        `/app/assets/..%2f..%2f${name}%00.js`,
        "/app/assets/%00",
      ]) {
        const res = await app().request(path)
        expect(await res.text(), path).not.toContain("secret")
        expect(res.status, path).toBe(404)
      }
    } finally {
      rmSync(join(dir, "..", name), { force: true })
    }
  })

  it("the shell pattern is the Build Output route's pattern, character for character", () => {
    const route = OUTPUT_CONFIG.routes.find((r) => r.dest === "/app/index.html")
    expect(route?.src).toBeDefined()
    expect(SHELL_PATTERN.source).toBe(new RegExp(route?.src ?? "").source)
  })

  it("answers only GET and HEAD", async () => {
    expect((await app().request("/app/digest", { method: "POST" })).status).toBe(404)
    expect((await app().request("/app/digest", { method: "HEAD" })).status).toBe(200)
  })
})

describe("routeToWeb", () => {
  // Each side answers with the env it was given, so a dropped argument shows as `undefined`.
  const echo = (name: string) => {
    const side = new Hono<{ Bindings: { marker: string } }>()
    side.all("*", (c) => c.json({ name, marker: c.env?.marker ?? null }))
    return side
  }
  const env = { marker: "node-server-bindings" }

  it("sends /app and /app/* to the web app and everything else to hq", async () => {
    const fetch = routeToWeb(echo("web"), echo("hq"))
    const names: Record<string, string> = {}
    for (const path of [
      "/app",
      "/app/digest",
      "/app/assets/x.js",
      "/v1/status",
      "/application",
      "/",
    ]) {
      const res = await fetch(new Request(`http://hq.test${path}`), env)
      names[path] = ((await res.json()) as { name: string }).name
    }
    expect(names).toEqual({
      "/app": "web",
      "/app/digest": "web",
      "/app/assets/x.js": "web",
      "/v1/status": "hq",
      "/application": "hq",
      "/": "hq",
    })
  })

  it("passes the env argument through to both fetches", async () => {
    const fetch = routeToWeb(echo("web"), echo("hq"))
    for (const path of ["/app/digest", "/v1/status"]) {
      const res = await fetch(new Request(`http://hq.test${path}`), env)
      expect(((await res.json()) as { marker: string }).marker, path).toBe(env.marker)
    }
  })

  it("is just hq's fetch without a web app", async () => {
    const fetch = routeToWeb(null, echo("hq"))
    const res = await fetch(new Request("http://hq.test/app/digest"), env)
    expect(await res.json()).toEqual({ name: "hq", marker: env.marker })
  })
})
