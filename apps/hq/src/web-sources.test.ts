// Guards on the app's sources (web/), read as text: the build must stay free of environment reads
// and the CSP ('self' only) must not be bypassed by inline styles or raw HTML.
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web")

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "dist" ? [] : sources(path)
    }
    return /\.(tsx?|css|html)$/.test(entry.name) ? [path] : []
  })
}

// The config runs in Node at build time; everything else ships to the browser.
const shipped = () =>
  sources(webDir)
    .filter((path) => relative(webDir, path) !== "vite.config.ts")
    .map((path) => ({ file: relative(webDir, path), text: readFileSync(path, "utf8") }))

// Spelled in two parts so that this file does not trip the baseline rule it guards in web/.
const RAW_HTML = new RegExp(`${"dangerously"}SetInnerHTML`)

describe("web sources", () => {
  it("has sources to scan", () => {
    expect(shipped().length).toBeGreaterThan(0)
  })

  it("read no process.env and call no console method", () => {
    for (const { file, text } of shipped()) {
      expect(text, file).not.toMatch(/process\.env/)
      expect(text, file).not.toMatch(/\bconsole\./)
    }
  })

  it("read no import.meta.env beyond BASE_URL, MODE and DEV", () => {
    for (const { file, text } of shipped()) {
      for (const match of text.matchAll(/import\.meta\.env(?:\.(\w+))?/g)) {
        expect(["BASE_URL", "MODE", "DEV"], `${file}: ${match[0]}`).toContain(match[1])
      }
    }
  })

  it("no colour literal outside tokens.css", () => {
    for (const { file, text } of shipped()) {
      if (/\.test\.tsx?$/.test(file)) continue // tests are not shipped and pin the hex values
      if (file === join("src", "styles", "tokens.css")) continue
      expect(text, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(text, file).not.toMatch(/\brgba?\(/)
      expect(text, file).not.toMatch(/\bhsla?\(/)
      expect(text, file).not.toMatch(/\b(?:oklch|oklab|lab|lch|hwb|color|color-mix)\(/)
    }
  })

  it("set no inline style and no raw HTML", () => {
    for (const { file, text } of shipped()) {
      expect(text, file).not.toMatch(/style=\{\{/)
      expect(text, file).not.toMatch(RAW_HTML)
    }
  })
})
