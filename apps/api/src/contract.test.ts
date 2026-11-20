// Contract tests: the published docs (openapi.json, llms-full.txt examples) are the contract agents
// code against. Every example must be valid against the spec, every live response must match the
// spec (or fail with the error the example documents), REST and MCP must agree, and any change to
// the spec shows up as a diff of openapi.json. Examples run as an organization owner.
import { Validator } from "@seriousme/openapi-schema-validator"
import { type AnyOperation, openApiPath } from "@proof/api"
import { Ajv2020 } from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createTestApp, requestFor } from "./app.test.helpers"

type Spec = {
  paths: Record<string, Record<string, OperationObject>>
}
type OperationObject = {
  parameters?: { name: string; in: string; schema: object }[]
  requestBody?: { content: { "application/json": { schema: object } } }
  responses: {
    "200": { content: { "application/json": { schema: object } } }
    default: { content: { "application/json": { schema: object } } }
  }
}

const ajv = new Ajv2020({ strict: false, allErrors: true })
addFormats.default(ajv)

function check(schema: object, value: unknown) {
  const validate = ajv.compile(schema)
  return validate(value) ? null : ajv.errorsText(validate.errors)
}

const t = await createTestApp()

describe("API contract", () => {
  let spec: Spec
  let errorSchema: object
  beforeAll(async () => {
    spec = (await (await t.req("/openapi.json")).json()) as Spec & {
      components: { schemas: { Error: object } }
    }
    errorSchema = (spec as unknown as { components: { schemas: { Error: object } } }).components
      .schemas.Error
  })
  afterAll(() => t.close())

  const specFor = (op: AnyOperation) => {
    const o = spec.paths[openApiPath(op.path)]?.[op.method.toLowerCase()]
    if (!o) throw new Error(`${op.name} is missing from openapi.json`)
    return o
  }

  it("is a valid OpenAPI 3.1 document", async () => {
    const result = await new Validator().validate(structuredClone(spec))
    expect(result.errors ?? [], JSON.stringify(result.errors)).toEqual([])
    expect(result.valid).toBe(true)
  })

  it("matches the committed openapi.json (review the diff: it is the public contract)", async () => {
    await expect(`${JSON.stringify(spec, null, 2)}\n`).toMatchFileSnapshot("../openapi.json")
  })

  describe.each(t.operations.map((op) => [op.name, op] as const))("%s", (_name, op) => {
    it("documents at least one example", () => {
      expect(op.examples?.length ?? 0).toBeGreaterThan(0)
    })

    it("has examples that are valid against the spec", () => {
      const o = specFor(op)
      for (const ex of op.examples ?? []) {
        const input = ex.input as Record<string, unknown>
        for (const p of o.parameters ?? []) {
          if (p.name in input) expect(check(p.schema, input[p.name]), p.name).toBeNull()
        }
        if (o.requestBody) {
          const body = Object.fromEntries(
            Object.entries(input).filter(([k]) => !o.parameters?.some((p) => p.name === k)),
          )
          expect(check(o.requestBody.content["application/json"].schema, body)).toBeNull()
        }
        if (ex.output !== undefined) {
          expect(check(o.responses["200"].content["application/json"].schema, ex.output)).toBeNull()
        }
      }
    })

    it("answers each example over REST as documented and as the spec says", async () => {
      for (const ex of op.examples ?? []) {
        const { path, init } = requestFor(op, ex.input as Record<string, unknown>)
        // A public operation is called with no credential, as its example says.
        const res = await t.req(path, op.auth === "none" ? init : t.as(t.owner.cookie, init))
        const body = await res.json()
        if (ex.error) {
          expect(body).toMatchObject({ error: { code: ex.error } })
          expect(check(errorSchema, body)).toBeNull()
        } else {
          expect(res.status, JSON.stringify(body)).toBe(200)
          const schema = specFor(op).responses["200"].content["application/json"].schema
          expect(check(schema, body)).toBeNull()
        }
      }
    })

    // Public and person-only operations are not MCP tools, so there is nothing to compare them with.
    it.skipIf(op.auth !== undefined)("behaves the same over MCP as over REST", async () => {
      const client = await t.mcpClient(t.owner.cookie)
      // Results with generated fields (ids, keys, timestamps) differ per call; compare their shape.
      const shape = (v: unknown): unknown =>
        Array.isArray(v)
          ? v.map(shape)
          : v && typeof v === "object"
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]))
            : typeof v
      try {
        for (const ex of op.examples ?? []) {
          const args = ex.input as Record<string, unknown>
          const { path, init } = requestFor(op, args)
          const rest = await (await t.req(path, t.as(t.owner.cookie, init))).json()
          const mcp = await client.callTool({ name: op.name, arguments: args })
          const text = (mcp.content as { type: string; text: string }[])[0]?.text ?? "null"
          const result = mcp.structuredContent ?? JSON.parse(text)
          if (ex.error) {
            expect(mcp.isError).toBe(true)
            expect(result).toMatchObject({ code: ex.error })
            expect(rest).toMatchObject({ error: { code: ex.error } })
          } else {
            expect(mcp.isError ?? false).toBe(false)
            expect(shape(result)).toEqual(shape(rest))
          }
        }
      } finally {
        await client.close()
      }
    })
  })
})
