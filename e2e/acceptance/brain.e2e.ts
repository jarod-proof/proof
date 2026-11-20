import { test } from "@e2e-dev/web"
import { expect } from "e2e"

import { acceptanceSkip, agentClient, claimRun, founderClient, runTag } from "./support"

// Phase 1 acceptance on a deployed org: the brain. A founder proposes a fact and approves it, and
// the newest version is found by search_entries over REST (the agent's key and the founder's
// session) and over MCP. Deterministic, no model. Entries are never deleted, so the fact stays
// behind, named `acceptance-...`.
test("a founder proposes and approves a fact; search_entries over REST and MCP finds it", {
  timeout: 120_000,
  skip: acceptanceSkip,
}, async () => {
  claimRun("brain")
  const founder = await founderClient()
  const agent = agentClient()

  // A word only this run's entry holds.
  const tag = runTag()
  const word = `quokka${tag.replace(/[^a-z0-9]/g, "")}`
  const slug = `${tag}-pricing`
  const proposed = await founder.post("/v1/proposals", {
    kind: "fact",
    slug,
    title: `Acceptance pricing ${tag}`,
    body: { text: `Free, then $20 per seat. ${word}` },
    reason: "acceptance run",
  })
  expect(proposed.status).toBe(200)
  expect(proposed.json.status).toBe("pending")

  const approved = await founder.post(
    `/v1/proposals/${proposed.json.proposalId as string}/decision`,
    { decision: "approve", note: "acceptance run" },
  )
  expect(approved.status).toBe(200)
  expect(approved.json).toMatchObject({ status: "approved", version: 1 })
  const entryId = approved.json.entryId as string

  const ids = (json: Record<string, unknown>) =>
    (json.hits as { id: string }[]).map((hit) => hit.id)

  // REST, as the agent (its key reads the brain) and as the founder.
  const byKey = await agent.post("/v1/search/entries", { query: word })
  expect(byKey.status).toBe(200)
  expect(ids(byKey.json)).toEqual([entryId])
  const bySession = await founder.post("/v1/search/entries", { query: word })
  expect(bySession.status).toBe(200)
  expect(ids(bySession.json)).toEqual([entryId])

  // MCP: the tool is listed, and calling it finds the same entry.
  expect(await agent.mcpTools()).toContain("search_entries")
  const byMcp = await agent.mcp("search_entries", { query: word })
  expect(byMcp.isError).toBe(false)
  expect(ids(byMcp.json)).toEqual([entryId])
})
