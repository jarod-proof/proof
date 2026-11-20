// The built web app served from the API origin: pages get index.html with a locked-down CSP, assets
// get long-lived caching, everything else stays a JSON 404.
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Hono } from "hono"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createTestApp } from "./app.test.helpers"
import { contentSecurityPolicy, inlineScriptHashes, mountWeb } from "./static"

// apps/app's generated route tree: every route it declares must be served an app page. Read as text,
// since this package has no React or TanStack dependencies to import it with.
const SKILL = "---\nname: test\n---\n\n# Test skill\n"
const routeTreeSource = readFileSync(
  new URL("../../app/src/routeTree.gen.ts", import.meta.url),
  "utf8",
)

// Every path the route tree declares, with each parameter filled in. `/` is the API's own page.
const declaredRoutes = (() => {
  const block = routeTreeSource.slice(
    routeTreeSource.indexOf("export interface FileRoutesByFullPath"),
  )
  const body = block.slice(0, block.indexOf("}"))
  return [...body.matchAll(/'(\/[^']*)':\s*typeof/g)].map((m) => m[1] ?? "")
})()
const sampleParams: Record<string, string> = { $org: "acme", $invitationId: "inv_123" }
const concretePath = (path: string) =>
  path.replace(/\$([a-zA-Z]+)/g, (_, name: string) => sampleParams[name] ?? "sample")

const INLINE = "window.__bootstrap = true"
const inlineHash = `'sha256-${createHash("sha256").update(INLINE).digest("base64")}'`

describe("web app serving", () => {
  let dist: string
  let t: Awaited<ReturnType<typeof createTestApp>>

  beforeAll(async () => {
    dist = mkdtempSync(join(tmpdir(), "proof-web-"))
    mkdirSync(join(dist, "assets"))
    writeFileSync(
      join(dist, "index.html"),
      `<!doctype html><html><body><script>${INLINE}</script>` +
        `<script type="module" src="/assets/app.js"></script></body></html>`,
    )
    writeFileSync(join(dist, "assets", "app.js"), "console.log('app')")
    writeFileSync(join(dist, "assets", "app.css"), "body{}")
    t = await createTestApp([], { webDistDir: dist, skill: SKILL })
  })
  afterAll(async () => {
    await t.close()
    rmSync(dist, { recursive: true, force: true })
  })

  it("serves index.html for every page path, with security headers", async () => {
    const pages = [
      "/sign-in",
      "/sign-up",
      "/consent",
      "/select-organization",
      "/accept-invitation/inv_123",
      "/device",
      "/reset-password",
      "/claim",
      "/settings/agents",
      "/new",
      "/two-factor",
      "/account",
      "/account/profile",
      "/admin",
      "/admin/users",
      "/invite/inv_123",
      "/acme",
      "/acme/settings/agents",
      "/acme/settings/general",
      // A valid slug that no organization has: the shell shows its not-found state.
      "/dashboard",
    ]
    for (const path of pages) {
      const res = await t.req(path)
      expect(res.status, path).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/html")
      expect(await res.text(), path).toContain("window.__bootstrap")
      const csp = res.headers.get("content-security-policy") ?? ""
      expect(csp).toContain("default-src 'self'")
      expect(csp).toContain("frame-ancestors 'none'")
      expect(csp).toContain(`script-src 'self' ${inlineHash}`)
      expect(res.headers.get("x-frame-options")).toBe("DENY")
      expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    }
  })

  it("serves hashed assets with long-lived immutable caching", async () => {
    const js = await t.req("/assets/app.js")
    expect(js.status).toBe(200)
    expect(js.headers.get("content-type")).toContain("text/javascript")
    expect(js.headers.get("cache-control")).toContain("immutable")
    expect(await js.text()).toBe("console.log('app')")
    const css = await t.req("/assets/app.css")
    expect(css.headers.get("content-type")).toContain("text/css")
  })

  it("answers missing assets and paths outside assets with a JSON 404", async () => {
    expect((await t.req("/assets/missing.js")).status).toBe(404)
    // Encoded traversal must not reach index.html or files outside assets/.
    const traversal = await t.req("/assets/%2e%2e%2findex.html")
    expect(traversal.status).toBe(404)
    expect(traversal.headers.get("content-type")).toContain("application/json")
    expect(await traversal.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } })
  })

  it("does not serve index.html for dotted paths, reserved slugs or API paths", async () => {
    // A dot is never part of a slug, and reserved slugs belong to the API (JSON 404 here).
    for (const path of [
      "/dashboard.json",
      "/favicon.ico",
      "/api/nothing",
      "/v1/nothing",
      "/mcp/x",
    ]) {
      const res = await t.req(path)
      expect(res.status, path).toBe(404)
      expect(res.headers.get("content-type"), path).toContain("application/json")
    }
  })

  it("serves index.html for every route the web app declares (except /, which is the API's)", async () => {
    // Derived from apps/app's route tree, so a new route can't ship unserved.
    expect(declaredRoutes).toContain("/$org/settings/agents")
    for (const path of declaredRoutes.filter((route) => route !== "/")) {
      const res = await t.req(concretePath(path))
      expect(res.status, `${path} -> ${concretePath(path)}`).toBe(200)
      expect(await res.text(), path).toContain("window.__bootstrap")
    }
  })

  it("keeps / answering with the llms.txt negotiation", async () => {
    expect(await (await t.req("/")).text()).toMatch(/^# Test API/)
    const browser = await t.req("/", { headers: { accept: "text/html" } })
    expect(browser.headers.get("location")).toBe("/llms.txt")
  })

  it("serves /skill.md as markdown, not the SPA, to agents and browsers", async () => {
    for (const accept of ["text/markdown", "text/html"]) {
      const res = await t.req("/skill.md", { headers: { accept } })
      expect(res.status, accept).toBe(200)
      expect(res.headers.get("content-type"), accept).toContain("text/markdown")
      expect(await res.text(), accept).toBe(SKILL)
    }
  })
})

describe("mountWeb", () => {
  it("fails at startup when the build has no index.html", () => {
    const empty = mkdtempSync(join(tmpdir(), "proof-empty-"))
    try {
      expect(() => mountWeb(new Hono(), empty)).toThrow(/index\.html/)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it("hashes only inline scripts for the CSP", () => {
    const html = `<script src="/a.js"></script><script>${INLINE}</script>`
    expect(inlineScriptHashes(html)).toEqual([inlineHash])
    expect(contentSecurityPolicy("<html></html>")).toContain("script-src 'self';")
  })
})
