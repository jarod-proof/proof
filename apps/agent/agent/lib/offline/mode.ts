import { agentEnv } from "@proof/env/agent"

/**
 * Whether the agent runs on scripted models (evals and tests): AGENT_OFFLINE=1.
 *
 * @throws Anywhere that looks real: VERCEL_ENV or NODE_ENV production, or a Slack bot token present.
 * A scripted model answering real people is a misconfiguration to stop at load, not to run quietly
 * (the cap would still reserve, but nobody should be talking to a script).
 */
export function offlineMode(): boolean {
  if (agentEnv("AGENT_OFFLINE") !== "1") {
    return false
  }
  if (
    agentEnv("VERCEL_ENV") === "production" ||
    agentEnv("NODE_ENV") === "production" ||
    Boolean(agentEnv("SLACK_BOT_TOKEN"))
  ) {
    throw new Error(
      "AGENT_OFFLINE=1 is set where the agent is real (production or a Slack bot token): refusing to run on scripted models.",
    )
  }
  return true
}
