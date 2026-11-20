import { afterEach, describe, expect, test, vi } from "vitest"
import { MODELS, modelFor, offlineMode } from "#lib/models.js"
import { traceToProbe } from "#lib/offline/probe.js"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("offline mode", () => {
  test("is off by default and the roles keep their gateway ids", () => {
    expect(offlineMode()).toBe(false)
    expect(modelFor("orchestrator")).toBe(MODELS.orchestrator)
    expect(modelFor("reviewer")).toBe(MODELS.reviewer)
  })

  test("AGENT_OFFLINE=1 swaps in a scripted model, which is not a gateway id", () => {
    vi.stubEnv("AGENT_OFFLINE", "1")
    expect(offlineMode()).toBe(true)
    expect(typeof modelFor("orchestrator")).not.toBe("string")
  })

  test("AGENT_OFFLINE in production refuses to start: scripted models never answer real people", () => {
    vi.stubEnv("AGENT_OFFLINE", "1")
    vi.stubEnv("VERCEL_ENV", "production")
    expect(() => offlineMode()).toThrow(/production/)
    expect(() => modelFor("orchestrator")).toThrow(/production/)
  })

  test("it also refuses under NODE_ENV production or with a Slack bot token present", () => {
    vi.stubEnv("AGENT_OFFLINE", "1")
    vi.stubEnv("NODE_ENV", "production")
    expect(() => offlineMode()).toThrow(/real/)
    vi.stubEnv("NODE_ENV", "test")
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-not-a-real-token")
    expect(() => offlineMode()).toThrow(/real/)
  })

  test("the probe is told nothing unless offline: a production stub never POSTs to AGENT_PROBE_URL", async () => {
    const sent: string[] = []
    vi.stubGlobal("fetch", (url: string) => {
      sent.push(url)
      return Promise.resolve(new Response("{}"))
    })
    vi.stubEnv("AGENT_PROBE_URL", "http://127.0.0.1:9")
    await traceToProbe("bigger-model-run", { question: "private" })
    expect(sent).toEqual([])
    vi.stubEnv("AGENT_OFFLINE", "1")
    await traceToProbe("bigger-model-run", {})
    expect(sent).toEqual(["http://127.0.0.1:9/event"])
  })

  test("only the value 1 turns it on", () => {
    vi.stubEnv("AGENT_OFFLINE", "true")
    expect(offlineMode()).toBe(false)
  })
})
