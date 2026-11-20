// `pnpm --filter @proof/hq founders:principals [--check]`: the agent's founder list, from HQ_FOUNDERS.
//
// Without a flag it prints the AGENT_FOUNDER_PRINCIPALS line to store in the org's vault, derived
// from the HQ_FOUNDERS list (who it resolves to, by the rules a sync uses) and HQ_SLACK_TEAM_ID. It
// does not read the founders table: mint the new list before `pnpm hq:predeploy` writes the table.
// With --check it compares that with the AGENT_FOUNDER_PRINCIPALS in this environment and exits 1
// on any difference, so a deploy or a CI job can refuse to ship while hq and the agent disagree
// about who the founders are. (`pnpm hq:predeploy` runs the same check itself before it writes.)
import { createDb } from "@proof/db"
import { agentEnv } from "@proof/env/agent"

import { isProductionLike } from "./deploy-mode"
import { hqEnv } from "./env"
import { checkFounderPrincipals, founderPrincipalsFromList } from "./slack/principals"

const config = hqEnv()
const teamId = config.slack.teamId
if (!teamId) {
  process.stderr.write("HQ_DATABASE_URL and HQ_SLACK_TEAM_ID must be set.\n")
  process.exit(2)
}

const derived = await founderPrincipalsFromList(
  createDb(config.databaseUrl),
  teamId,
  config.founders,
  {
    pinnedOnly: isProductionLike(config.nodeEnv),
  },
)
if (process.argv.includes("--check")) {
  const drift = checkFounderPrincipals(derived, agentEnv("AGENT_FOUNDER_PRINCIPALS"))
  if (drift.ok) {
    process.stdout.write(`AGENT_FOUNDER_PRINCIPALS matches HQ_FOUNDERS (${derived.length}).\n`)
  } else {
    process.stderr.write(
      `AGENT_FOUNDER_PRINCIPALS disagrees with the founders HQ_FOUNDERS lists.\n` +
        `  missing from the agent: ${drift.missing.join(", ") || "none"}\n` +
        `  listed by the agent but not founders in hq: ${drift.extra.join(", ") || "none"}\n`,
    )
    process.exitCode = 1
  }
} else {
  process.stdout.write(`AGENT_FOUNDER_PRINCIPALS=${derived.join(",")}\n`)
}
process.exit(process.exitCode ?? 0)
