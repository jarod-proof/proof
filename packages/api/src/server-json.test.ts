import { describe, expect, it } from "vitest"
import { installSnippets, serverName } from "./llms"
import { DEFAULT_REGISTRY_META, SERVER_JSON_SCHEMA, serverJson } from "./server-json"

const info = {
  title: "Acme API",
  version: "1.2.0",
  description: "Acme API",
  baseURL: "https://api.acme.test",
}

describe("serverJson", () => {
  it("describes one streamable-http remote at /mcp", () => {
    expect(serverJson(info, { name: "io.github.acme/api", description: "Acme API." })).toEqual({
      $schema: SERVER_JSON_SCHEMA,
      name: "io.github.acme/api",
      title: "Acme API",
      description: "Acme API.",
      version: "1.2.0",
      websiteUrl: "https://api.acme.test/llms.txt",
      remotes: [{ type: "streamable-http", url: "https://api.acme.test/mcp" }],
    })
  })

  it("keeps the default registry meta within registry limits", () => {
    expect(DEFAULT_REGISTRY_META.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/)
    expect(DEFAULT_REGISTRY_META.description.length).toBeLessThanOrEqual(100)
    expect(serverJson(info).name).toBe(DEFAULT_REGISTRY_META.name)
  })
})

describe("install snippets", () => {
  it("slugs the title into the server name", () => {
    expect(serverName(info)).toBe("acme-api")
    expect(serverName({ ...info, title: "  --  " })).toBe("api")
  })

  it("names the MCP URL in the snippets and encodes the Cursor deeplink config", () => {
    const txt = installSnippets(info, ["signup"]).join("\n")
    expect(txt).toContain("claude mcp add --transport http acme-api https://api.acme.test/mcp")
    const link =
      /cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=acme-api&config=([^)\s]+)\)/.exec(
        txt,
      )
    expect(link).not.toBeNull()
    const config = JSON.parse(atob(decodeURIComponent(link?.[1] ?? "")))
    expect(config).toEqual({ url: "https://api.acme.test/mcp" })
  })

  it("gives a connector for claude.ai, and a Gemini CLI command and settings entry", () => {
    const txt = installSnippets(info).join("\n")
    expect(txt).toContain("### Claude on claude.ai")
    expect(txt).toContain("Add custom connector")
    expect(txt).toContain("gemini mcp add --transport http acme-api https://api.acme.test/mcp")
    expect(txt).toContain('"httpUrl": "https://api.acme.test/mcp"')
  })

  it("tells a Codex user to sign in after adding the server", () => {
    expect(installSnippets(info).join("\n")).toContain("codex mcp login acme-api")
  })

  it("points the CLI at this deployment's origin, with the signup-free commands", () => {
    const txt = installSnippets(info).join("\n")
    expect(txt).toContain("### CLI")
    expect(txt).toContain("npx @proof/cli login --base-url https://api.acme.test")
    expect(txt).toContain("npx @proof/cli call <operation>")
  })

  it("includes the self-signup section only when signup is public", () => {
    expect(installSnippets(info).join("\n")).not.toContain("self-signup")
    expect(installSnippets(info, ["signup"]).join("\n")).toContain("/v1/signup")
  })
})
