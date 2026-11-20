// `pnpm hq:predeploy`: the deploy-time step that sets who hq's founders are. It checks everything
// first (predeploy-checks.ts: production, sign-up off, founders by id, and the agent's
// AGENT_FOUNDER_PRINCIPALS against the HQ_FOUNDERS list about to be published) and writes the
// founders table only if every check passed, under an advisory lock. A deployed hq never writes the
// table at boot, it only checks it against its own list, so this is the one place a deploy sets
// the founders, and the deploy that runs it last wins: an older deployment still reachable finds a
// different table and refuses every request. Run it against the production environment before every
// deploy, then deploy. Exit 0 fit to deploy, 1 not (and the table untouched).
import { createDb } from "@proof/db"
import { agentEnv } from "@proof/env/agent"

import { hqEnv } from "./env"
import { runPredeploy } from "./predeploy-checks"

const config = hqEnv()
const db = createDb(config.databaseUrl)
const result = await runPredeploy(config, db, agentEnv("AGENT_FOUNDER_PRINCIPALS"), new Date())
if (!result.ok) {
  process.stderr.write(
    `hq is not fit to deploy:\n${result.problems.map((p) => `  - ${p}`).join("\n")}\n`,
  )
  await db.$client.end()
  process.exit(1)
}
const { synced } = result
process.stdout.write(
  `founders table set from HQ_FOUNDERS: ${synced.added.length} added, ${synced.removed.length} removed, ` +
    `${synced.skipped.length} skipped.\n`,
)
for (const skipped of synced.skipped) {
  process.stderr.write(
    `  not synced: HQ_FOUNDERS entry ${skipped.entry} (${skipped.kind}): ${skipped.why}\n`,
  )
}
await db.$client.end()
process.stdout.write(
  `AGENT_FOUNDER_PRINCIPALS matches the published founders (${result.principals.length}). ` +
    "hq's environment is fit to deploy (production, sign-up off, founders by id).\n",
)
process.exit(0)
