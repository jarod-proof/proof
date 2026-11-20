import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { generateSchema, OPENAPI_PATH, SCHEMA_PATH } from "../scripts/generate-schema.mjs"

describe("schema.gen.ts", () => {
  it("matches what the generator produces from the committed openapi.json", async () => {
    const spec = JSON.parse(await readFile(OPENAPI_PATH, "utf8"))
    const committed = await readFile(SCHEMA_PATH, "utf8")
    // A stale file means the API contract changed without `pnpm --filter @proof/sdk generate`.
    expect(committed).toBe(await generateSchema(spec))
  })
})
