/**
 * apps/agent's environment (the eve agent: Foreman, Slack, hq memory, the daily spend cap).
 *
 * A separate entry from `./index.ts`: the product's env validates DATABASE_URL, the auth secret
 * and the rest on first import, none of which the agent has. The agent reads each variable through
 * `agentEnv` at the moment it needs it and never caches, because its modules load at discovery,
 * in tests that stub the environment and under `eve eval`, and each of those sets different values.
 * Nothing here is validated beyond the name: each reader checks its own value and fails closed.
 */

/** Every variable apps/agent reads. Add one here and to `.env.example` before using it. */
export const AGENT_ENV_NAMES = [
  // Foreman: the repository, labels and branches, the sandbox, the intake API.
  "FACTORY_REPO",
  "FACTORY_LABEL",
  "FACTORY_BRANCH_PREFIX",
  "FACTORY_SETUP_COMMAND",
  "FACTORY_BOT_NAME",
  "GITHUB_APP_SLUG",
  "FACTORY_TOKEN_FALLBACK",
  "FACTORY_ALLOW_WORKFLOW_CHANGES",
  "FACTORY_SIGNED_COMMITS",
  "FACTORY_SANDBOX_EGRESS",
  "FACTORY_SANDBOX_ALLOWED_DOMAINS",
  "FACTORY_ALLOW_INSTALL_SCRIPTS",
  "FACTORY_INTAKE_TOKEN",
  "FACTORY_INTAKE_CALLBACK_HOSTS",
  "FACTORY_INTAKE_CALLBACK_SECRET",
  "VERCEL_ENV",
  // Tests that spawn git and need the parent's search path.
  "PATH",
  // hq: the brain and the spend ledger. The key is an hq API key with the agent's scope only.
  "HQ_BASE_URL",
  "HQ_AGENT_API_KEY",
  // The daily cap: what a turn is assumed to cost until its real cost is known (dollars).
  "AGENT_TURN_ESTIMATE_USD",
  // Slack: who may talk to the agent, and who may approve spend (founders).
  "SLACK_ALLOWED_TEAM_IDS",
  "AGENT_FOUNDER_PRINCIPALS",
  // Offline mode (evals, tests): scripted models, and a probe that records what the agent did.
  "AGENT_OFFLINE",
  "AGENT_PROBE_URL",
  // Read only to refuse offline mode where the agent is real.
  "NODE_ENV",
  "SLACK_BOT_TOKEN",
  // The Slack app's signing secret: the agent verifies Slack's request itself so it can forward the
  // raw bytes to hq, which verifies them again (hq reads the same variable through @proof/env).
  "SLACK_SIGNING_SECRET",
  // Where the nightly digest posts (a channel id such as C01ABC). Unset, the digest posts nothing.
  "SLACK_DIGEST_CHANNEL_ID",
  // The org's GitHub App, for installation tokens (agent/lib/github/app-token.ts): its id, the
  // private key PEM (from the vault; `\n` escapes are accepted) and the installation on the org.
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_INSTALLATION_ID",
  // The secret GitHub signs webhooks with; the channel refuses every delivery without it.
  "GITHUB_WEBHOOK_SECRET",
] as const

export type AgentEnvName = (typeof AGENT_ENV_NAMES)[number]

/** The variable's current value (an empty string stays empty), or undefined when unset. */
export function agentEnv(name: AgentEnvName): string | undefined {
  return process.env[name]
}

/** A comma-separated variable as a list: trimmed, empty items dropped. */
export function agentEnvList(name: AgentEnvName): string[] {
  return (agentEnv(name) ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}
