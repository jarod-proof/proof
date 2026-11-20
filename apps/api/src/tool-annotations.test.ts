// Every MCP tool states its annotations explicitly. The spec defaults destructiveHint to true when
// absent, so a write that leaves `destructive` out is advertised as destructive and clients over-prompt.
import { toTool } from "@proof/mcp"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createTestApp } from "./app.test.helpers"

describe("MCP tool annotations", () => {
  let t: Awaited<ReturnType<typeof createTestApp>>
  beforeAll(async () => {
    t = await createTestApp()
  })
  afterAll(() => t.close())

  // auth "none" and "person" operations are REST only, never tools (see buildServer in @proof/mcp).
  const tools = () => t.operations.filter((op) => op.auth === undefined)

  it("lists the tools the test app serves", () => {
    expect(tools().length).toBeGreaterThan(0)
  })

  it("declares destructive explicitly on every write", () => {
    const missing = tools()
      .filter((op) => op.hints?.readOnly !== true)
      .filter((op) => typeof op.hints?.destructive !== "boolean")
      .map((op) => op.name)
    expect(missing, "writes without hints.destructive (spec default is true)").toEqual([])
  })

  it("maps every tool to MCP annotations with explicit booleans", () => {
    const problems: string[] = []
    for (const op of tools()) {
      const { annotations } = toTool(op)
      if (op.hints?.readOnly === true) {
        if (annotations?.readOnlyHint !== true) problems.push(`${op.name}: readOnlyHint`)
        continue
      }
      if (typeof annotations?.readOnlyHint !== "boolean") problems.push(`${op.name}: readOnlyHint`)
      if (typeof annotations?.destructiveHint !== "boolean") {
        problems.push(`${op.name}: destructiveHint`)
      }
    }
    expect(problems).toEqual([])
  })
})
