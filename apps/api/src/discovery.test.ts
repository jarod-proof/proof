// Discovery: how an agent finds this server. The MCP registry record (served and committed as the
// root server.json) must validate against the registry's own schema, be served CORS-enabled, and
// stay in step with the generator. The schema is vendored from
// https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json (fetched once; the
// $id inside it is the same URL). To refresh it, fetch that URL again and re-run this test.
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { DEFAULT_REGISTRY_META, serverJson } from "@proof/api"
import Ajv from "ajv"
import addFormats from "ajv-formats"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { BASE, createTestApp } from "./app.test.helpers"
import { PRODUCT } from "./product"

const ROOT_SERVER_JSON = fileURLToPath(new URL("../../../server.json", import.meta.url))
const REGISTRY_SCHEMA = JSON.parse(
  readFileSync(
    new URL("./__fixtures__/mcp-server.schema.2025-12-11.json", import.meta.url),
    "utf8",
  ),
) as object

// The info server.ts publishes, from product.ts, with its public origin as the baseURL: this is
// what the committed root server.json is generated from.
const ROOT_INFO = {
  title: PRODUCT.name,
  version: PRODUCT.version,
  description: PRODUCT.description,
  baseURL: PRODUCT.publicURL,
}

const ajv = new Ajv({ strict: false, allErrors: true })
addFormats.default(ajv)
const validateRegistry = ajv.compile(REGISTRY_SCHEMA)

function registryErrors(doc: unknown): string {
  return validateRegistry(doc) ? "" : (ajv.errorsText(validateRegistry.errors) ?? "invalid")
}

describe("registry record (server.json)", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  beforeAll(async () => {
    t = await createTestApp()
  })
  afterAll(() => t.close())

  it("is served at /.well-known/mcp/server.json, CORS-enabled, and validates", async () => {
    const res = await t.req("/.well-known/mcp/server.json", {
      headers: { origin: "https://app.example" },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(res.headers.get("access-control-allow-origin")).toBe("*")
    const doc = await res.json()
    expect(doc).toEqual(
      serverJson(
        { title: "Test API", version: "1.0.0", description: "A test API.", baseURL: BASE },
        DEFAULT_REGISTRY_META,
      ),
    )
    expect(registryErrors(doc)).toBe("")
  })

  it("is listed in llms.txt, which marks signup as the one operation with no credential", async () => {
    const txt = await (await t.req("/llms.txt")).text()
    expect(txt).toContain(`${BASE}/.well-known/mcp/server.json`)
    expect(txt).toContain("(`signup`, no credential)")
    expect(txt).not.toContain("Every request needs")
    const full = await (await t.req("/llms-full.txt")).text()
    expect(full).toContain("Credential: none. Anyone may call this.")
    // The signup example is the documented call an agent copies: it must send no credential.
    const start = full.indexOf("## signup\n")
    const signup = full.slice(start, full.indexOf("\n## ", start + 1))
    // The example's code fence only (the description may name the header in prose).
    const fence = signup.slice(signup.indexOf("curl -X POST")).split("```")[0] ?? ""
    expect(fence).toContain("curl -X POST")
    expect(fence).not.toContain("x-api-key")
  })

  it("serves the install snippets from / for non-browser clients", async () => {
    const res = await t.req("/", { headers: { accept: "text/markdown" } })
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("## Install")
  })
})

describe("committed root server.json", () => {
  const generated = serverJson(ROOT_INFO, PRODUCT.registry)

  it("matches the generator, and is regenerated with UPDATE_SERVER_JSON=1", () => {
    if (process.env.UPDATE_SERVER_JSON) {
      writeFileSync(ROOT_SERVER_JSON, `${JSON.stringify(generated, null, 2)}\n`)
    }
    const committed = JSON.parse(readFileSync(ROOT_SERVER_JSON, "utf8"))
    expect(
      committed,
      "run UPDATE_SERVER_JSON=1 pnpm --filter @proof/api-app test discovery",
    ).toEqual(generated)
  })

  it("validates against the registry schema", () => {
    expect(registryErrors(generated)).toBe("")
    // The schema rejects these; a regression in the generator should fail here, not at publish.
    expect(registryErrors({ ...generated, name: "no-namespace" })).not.toBe("")
    expect(registryErrors({ ...generated, description: "x".repeat(101) })).not.toBe("")
  })
})
