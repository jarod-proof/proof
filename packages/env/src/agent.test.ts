import { afterEach, describe, expect, it, vi } from "vitest"
import { AGENT_ENV_NAMES, agentEnv, agentEnvList } from "./agent"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("agentEnv", () => {
  it("reads the variable as it is now, never a snapshot", () => {
    vi.stubEnv("HQ_BASE_URL", "http://127.0.0.1:1")
    expect(agentEnv("HQ_BASE_URL")).toBe("http://127.0.0.1:1")
    vi.stubEnv("HQ_BASE_URL", "http://127.0.0.1:2")
    expect(agentEnv("HQ_BASE_URL")).toBe("http://127.0.0.1:2")
  })

  it("is undefined when unset and keeps an empty string empty", () => {
    vi.stubEnv("HQ_AGENT_API_KEY", undefined)
    expect(agentEnv("HQ_AGENT_API_KEY")).toBeUndefined()
    vi.stubEnv("HQ_AGENT_API_KEY", "")
    expect(agentEnv("HQ_AGENT_API_KEY")).toBe("")
  })

  it("does not need the product's database or auth secret", async () => {
    vi.stubEnv("DATABASE_URL", undefined)
    vi.stubEnv("BETTER_AUTH_SECRET", undefined)
    await expect(import("./agent")).resolves.toBeDefined()
  })

  it("lists a comma-separated variable, trimmed, empty items dropped", () => {
    vi.stubEnv("AGENT_FOUNDER_PRINCIPALS", " slack:T0:U1 ,, slack:T0:U2,")
    expect(agentEnvList("AGENT_FOUNDER_PRINCIPALS")).toEqual(["slack:T0:U1", "slack:T0:U2"])
    vi.stubEnv("AGENT_FOUNDER_PRINCIPALS", "")
    expect(agentEnvList("AGENT_FOUNDER_PRINCIPALS")).toEqual([])
  })

  it("names every variable once", () => {
    expect(new Set(AGENT_ENV_NAMES).size).toBe(AGENT_ENV_NAMES.length)
  })
})
