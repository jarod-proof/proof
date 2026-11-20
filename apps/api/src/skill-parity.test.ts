// The shipped skill (skills/proof/SKILL.md) is read by customers' agents, so what it names must be
// what the server does: its error codes equal ErrorCode, its scopes equal OAUTH_SCOPES, every
// operation it names exists in the registry. llms.txt must carry the install snippets the skill
// points at.
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { OAUTH_SCOPES } from "@proof/auth"
import type { ErrorCode } from "@proof/errors"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createTestApp } from "./app.test.helpers"
import { PRODUCT } from "./product"

const SKILL = readFileSync(
  fileURLToPath(new URL("../../../skills/proof/SKILL.md", import.meta.url)),
  "utf8",
)

/** Every ErrorCode. Typed, so adding a code fails to compile here until the skill lists it. */
const ERROR_CODES: Record<ErrorCode, true> = {
  BAD_REQUEST: true,
  UNAUTHORIZED: true,
  FORBIDDEN: true,
  NOT_FOUND: true,
  CONFLICT: true,
  RATE_LIMITED: true,
  SESSION_NOT_FRESH: true,
  INTERNAL: true,
}

/** The skill as an agent reads it: its HTML comment (the template note for whoever forks it) removed. */
const SKILL_TEXT = SKILL.replace(/<!--[\s\S]*?-->/g, "")

/** The text under a `## heading`, up to the next `## `. */
function section(md: string, heading: string): string {
  const marker = `\n## ${heading}\n`
  const start = md.indexOf(marker)
  if (start < 0) throw new Error(`SKILL.md has no "## ${heading}" section`)
  const rest = md.slice(start + marker.length)
  const next = rest.indexOf("\n## ")
  return next < 0 ? rest : rest.slice(0, next)
}

/** Inline code spans without spaces: `read`, `BAD_REQUEST`, `list_projects`. */
const codeSpans = (text: string) => [...text.matchAll(/`([^`\s]+)`/g)].map((m) => m[1] ?? "")

describe("skills/proof/SKILL.md matches the server", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  beforeAll(async () => {
    t = await createTestApp([], { skill: SKILL })
  })
  afterAll(() => t.close())

  it("lists exactly the ErrorCode set in its Errors section", () => {
    const listed = codeSpans(section(SKILL_TEXT, "Errors")).filter((s) => /^[A-Z_]+$/.test(s))
    expect(new Set(listed)).toEqual(new Set(Object.keys(ERROR_CODES)))
  })

  it("lists exactly the OAuth scopes in its Scopes section", () => {
    const listed = codeSpans(section(SKILL_TEXT, "Scopes")).filter((s) => /^[a-z]+$/.test(s))
    expect(new Set(listed)).toEqual(new Set(OAUTH_SCOPES))
  })

  it("names only operations that exist in the registry", () => {
    const names = new Set(t.operations.map((op) => op.name))
    // Lowercase code spans that are not operations: the scopes, and plain words the skill quotes.
    // A new word that fails here must be added to this list, or it is a stale or misnamed operation.
    const notOperations = new Set([...OAUTH_SCOPES, "cursor", "limit", "hint", "null", "resource"])
    const named = codeSpans(SKILL_TEXT).filter((s) => /^[a-z]+(_[a-z]+)*$/.test(s))
    expect(named).toContain("whoami")
    const unknown = named.filter((s) => !names.has(s) && !notOperations.has(s))
    expect(unknown).toEqual([])
  })

  it("names its URLs under the product's public origin (product.ts)", () => {
    const urls = [...SKILL_TEXT.matchAll(/https?:\/\/[^\s)`"'<>]+/g)].map((m) => m[0])
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) expect(url.startsWith(`${PRODUCT.publicURL}/`), url).toBe(true)
  })

  it("points at the install snippets, which llms.txt and llms-full.txt carry", async () => {
    for (const path of ["/llms.txt", "/llms-full.txt"]) {
      const txt = await (await t.req(path)).text()
      expect(txt, path).toContain("## Install")
      expect(txt, path).toContain("claude mcp add --transport http")
      expect(txt, path).toContain("cursor://anysphere.cursor-deeplink/mcp/install?name=")
      expect(txt, path).toContain("code --add-mcp")
      expect(txt, path).toContain("[mcp_servers.")
      expect(txt, path).toContain("urn:ietf:params:oauth:grant-type:device_code")
      expect(txt, path).toContain("/api/auth/device/code")
      expect(txt, path).toContain("/v1/signup")
      expect(txt, path).toContain("gemini mcp add --transport http")
      expect(txt, path).toContain("httpUrl")
      expect(txt, path).toContain("Add custom connector")
      expect(txt, path).toContain("codex mcp login")
      expect(txt, path).toContain("npx @proof/cli login")
      // The skill is the Docs entry agents read first, and it is the served file itself.
      expect(txt, path).toMatch(/- \[Agent skill\]\(https?:\/\/[^)]+\/skill\.md\)/)
    }
  })

  it("serves the skill file itself at /skill.md, as markdown", async () => {
    const res = await t.req("/skill.md")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/markdown")
    expect(await res.text()).toBe(SKILL)
  })
})
