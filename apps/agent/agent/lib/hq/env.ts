import { agentEnv } from "@proof/env/agent"
import { createHqClient, type HqClient } from "./client.js"

/**
 * The agent's hq client, built from HQ_BASE_URL and HQ_AGENT_API_KEY when it is first needed.
 *
 * @remarks
 * The key is an hq API key with the agent's scope only (read all, propose, runs and spend), from
 * the org's vault. Unset, this throws: callers that guard the spend cap treat that as "cannot check
 * the cap" and refuse the turn, and the memory provider reports the brain as unavailable.
 */
export function hqFromEnv(): HqClient {
  const baseUrl = agentEnv("HQ_BASE_URL")?.trim()
  const apiKey = agentEnv("HQ_AGENT_API_KEY")?.trim()
  if (!baseUrl || !apiKey) {
    throw new Error("HQ_BASE_URL and HQ_AGENT_API_KEY must both be set for the agent to reach hq.")
  }
  return createHqClient({ baseUrl, apiKey })
}
