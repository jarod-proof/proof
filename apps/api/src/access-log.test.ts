// The access log line: with no analytics provider set, it is what says who called which operation
// and how it ended, over REST and MCP alike.
import { createLogger } from "@proof/logger"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { createTestApp } from "./app.test.helpers"

const lines: Record<string, unknown>[] = []
const logger = createLogger({
  level: "info",
  destination: { write: (line: string) => void lines.push(JSON.parse(line)) },
})
let t: Awaited<ReturnType<typeof createTestApp>>

/** The access log lines written since the last call. */
const requests = () => lines.splice(0).filter((l) => l.msg === "request")

beforeAll(async () => {
  t = await createTestApp([], { logger })
})
afterAll(() => t.close())
beforeEach(() => void requests())

describe("the access log", () => {
  it("names the operation, the caller and the outcome of a REST call", async () => {
    await t.req("/v1/projects", t.as(t.fullKey))
    await t.req("/v1/projects/nope", t.as(t.fullKey, { method: "DELETE" }))
    expect(requests()).toEqual([
      expect.objectContaining({
        path: "/v1/projects",
        status: 200,
        operation: "list_projects",
        outcome: "ok",
        organizationId: t.owner.orgId,
        actorType: "apiKey",
        actorId: expect.any(String),
        via: "api-key",
      }),
      expect.objectContaining({ operation: "delete_project", status: 404, outcome: "NOT_FOUND" }),
    ])
  })

  it("names the operation of a call with no credential, and no caller", async () => {
    await t.req("/v1/projects")
    const [line] = requests()
    expect(line).toMatchObject({ operation: "list_projects", outcome: "UNAUTHORIZED", status: 401 })
    expect(line).not.toHaveProperty("actorId")
  })

  it("names the tool and its outcome for MCP, where a failed tool is still a 200", async () => {
    const client = await t.mcpClient(t.fullKey)
    await client.callTool({ name: "delete_project", arguments: { id: "nope" } })
    await client.close()
    expect(requests()).toContainEqual(
      expect.objectContaining({
        path: "/mcp",
        status: 200,
        operation: "delete_project",
        outcome: "NOT_FOUND",
        organizationId: t.owner.orgId,
        actorType: "apiKey",
      }),
    )
  })

  it("names a person's session", async () => {
    await t.req("/v1/projects", t.as(t.viewer.cookie))
    expect(requests()).toEqual([
      expect.objectContaining({
        actorType: "user",
        actorId: t.viewer.userId,
        via: "session",
        organizationId: t.owner.orgId,
      }),
    ])
  })
})
