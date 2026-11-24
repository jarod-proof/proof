// Pins every row of the hq design tokens (plan I5). Reads tokens.css and index.html as text.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(resolve(here, "tokens.css"), "utf8")
const html = readFileSync(resolve(here, "..", "..", "index.html"), "utf8")

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) return {}
  const end = css.indexOf("}", start)
  const map: Record<string, string> = {}
  for (const match of css.slice(start, end).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const raw = (match[2] ?? "").trim()
    map[match[1] ?? ""] = raw.startsWith("#") ? raw.toLowerCase() : raw
  }
  return map
}

const dark = block(".dark")
const theme = block("@theme inline")
const plainTheme = block("@theme")

describe("hq design tokens (.dark)", () => {
  it("pins the colour rows of I5", () => {
    expect(dark["--background"]).toBe("#0b0d10")
    expect(dark["--panel"]).toBe("#0f1217")
    expect(dark["--card"]).toBe("#151a21")
    expect(dark["--popover"]).toBe("#151a21")
    expect(dark["--muted"]).toBe("#12161c")
    expect(dark["--secondary"]).toBe("#12161c")
    expect(dark["--accent"]).toBe("#1b222c")
    expect(dark["--border"]).toBe("#232a33")
    expect(dark["--input"]).toBe("#2f3743")
    expect(dark["--foreground"]).toBe("#e8eaed")
    expect(dark["--card-foreground"]).toBe("#e8eaed")
    expect(dark["--accent-foreground"]).toBe("#e8eaed")
    expect(dark["--secondary-foreground"]).toBe("#e8eaed")
    expect(dark["--soft"]).toBe("#c9d0da")
    expect(dark["--muted-foreground"]).toBe("#a8b1bf")
    expect(dark["--faint"]).toBe("#8b95a5")
    expect(dark["--primary"]).toBe("#7ab2ff")
    expect(dark["--ring"]).toBe("#7ab2ff")
    expect(dark["--primary-foreground"]).toBe("#0b0d10")
    expect(dark["--solar-foreground"]).toBe("#0b0d10")
    expect(dark["--solar"]).toBe("#ffc266")
    expect(dark["--success"]).toBe("#4fd1c5")
    expect(dark["--destructive"]).toBe("#ff8f85")
    expect(dark["--violet"]).toBe("#b79cff")
    expect(dark["--track"]).toBe("#1f2630")
    expect(dark["--attention-surface"]).toBe("#171a1e")
    expect(dark["--attention-border"]).toBe("#3a3320")
    expect(dark["--ok-surface"]).toBe("#10242a")
    expect(dark["--ok-border"]).toBe("#1f4a47")
  })

  it("pins the sidebar rows of I5", () => {
    expect(dark["--sidebar"]).toBe("#0b0d10")
    expect(dark["--sidebar-foreground"]).toBe("#a8b1bf")
    expect(dark["--sidebar-primary"]).toBe("#7ab2ff")
    expect(dark["--sidebar-primary-foreground"]).toBe("#0b0d10")
    expect(dark["--sidebar-accent"]).toBe("#1b222c")
    expect(dark["--sidebar-accent-foreground"]).toBe("#e8eaed")
    expect(dark["--sidebar-border"]).toBe("#232a33")
    expect(dark["--sidebar-ring"]).toBe("#7ab2ff")
  })

  it("pins radii, touch size and font stacks", () => {
    expect(plainTheme["--radius-shell"]).toBe("14px")
    expect(plainTheme["--radius-card"]).toBe("12px")
    expect(plainTheme["--radius-control"]).toBe("10px")
    expect(plainTheme["--spacing-touch"]).toBe("44px")
    expect(plainTheme["--font-sans"]).toBe('"Inter Variable", system-ui, sans-serif')
    expect(plainTheme["--font-mono"]).toBe(
      '"JetBrains Mono Variable", ui-monospace, Menlo, monospace',
    )
  })

  it("sets color-scheme dark on html.dark", () => {
    expect(css).toMatch(/html\.dark\s*\{[^}]*color-scheme:\s*dark/)
  })
})

describe("hq design tokens (@theme inline)", () => {
  it("declares each token class Tailwind needs in @theme inline", () => {
    expect(theme["--color-panel"]).toBe("var(--panel)")
    expect(theme["--color-faint"]).toBe("var(--faint)")
    expect(theme["--color-soft"]).toBe("var(--soft)")
    expect(theme["--color-solar"]).toBe("var(--solar)")
    expect(theme["--color-track"]).toBe("var(--track)")
    expect(theme["--color-violet"]).toBe("var(--violet)")
    expect(theme["--color-attention-surface"]).toBe("var(--attention-surface)")
    expect(theme["--color-attention-border"]).toBe("var(--attention-border)")
    expect(theme["--color-ok-surface"]).toBe("var(--ok-surface)")
    expect(theme["--color-ok-border"]).toBe("var(--ok-border)")
  })
})

describe("index.html", () => {
  it("is dark and static", () => {
    expect(html).toMatch(/<html lang="en" class="dark">/)
    expect(html).toMatch(/<title>HQ<\/title>/)
    expect(html.match(/<script type="module" src="[^"]+"><\/script>/g)).toHaveLength(1)
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
  })
})
