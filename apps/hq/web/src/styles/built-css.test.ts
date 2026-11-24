// Builds the web app once into a temporary directory and pins what the browser actually gets:
// Inter on the body, the token classes Tailwind must generate, and fonts that obey font-src 'self'.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { build } from "vite"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
let outDir = ""
let css = ""

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), "hq-web-css-"))
  await build({
    configFile: join(webDir, "vite.config.ts"),
    logLevel: "silent",
    build: { outDir, emptyOutDir: true },
  })
  const assets = join(outDir, "assets")
  const file = readdirSync(assets).find((name) => name.endsWith(".css")) ?? ""
  css = readFileSync(join(assets, file), "utf8")
}, 120_000)

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})

describe("built css", () => {
  it("sets the body font to Inter Variable", () => {
    const body = /(?:^|[}\s,])body\s*\{[^}]*font-family:\s*([^;}]+)/.exec(css)
    const family = body?.[1] ?? ""
    const resolved = family.includes("var(--font-sans)")
      ? (/--font-sans:\s*([^;}]+)/.exec(css)?.[1] ?? "")
      : family
    expect(resolved).toMatch(/Inter Variable/)
  })

  it("generates min-h-touch and rounded-shell", () => {
    expect(css).toMatch(/\.min-h-touch\s*\{[^}]*min-height:\s*(?:var\(--spacing-touch\)|44px)/)
    expect(css).toMatch(/\.rounded-shell\s*\{[^}]*border-radius:\s*(?:var\(--radius-shell\)|14px)/)
  })

  it("references only /app/assets/ in url() and never a data: URL", () => {
    const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1] ?? "")
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      expect(url).not.toMatch(/^data:/)
      expect(url.startsWith("/app/assets/"), url).toBe(true)
    }
  })
})
