// What `pnpm hq:predeploy` does, as a function a test can reach: every check first, then (only if
// all passed) the one write. A refused predeploy leaves the founders table exactly as it was, so a
// deploy that is aborted for drift cannot leave production on a table its instances refuse.
import type { Database } from "@proof/db"

import { type BootConfig, publishFounders } from "./boot"
import { predeployProblems } from "./deploy-mode"
import type { FounderSync } from "./data/founders"
import { checkFounderPrincipals, founderPrincipalsFromList } from "./slack/principals"

export type PredeployResult =
  | { ok: true; synced: FounderSync; principals: string[] }
  | { ok: false; problems: string[] }

/**
 * Checks, in order and without writing: the environment (`predeployProblems`: production, sign-up
 * off, founders by id), HQ_SLACK_TEAM_ID, and the agent's founder list. The agent's list
 * (AGENT_FOUNDER_PRINCIPALS) is compared with the principals of the HQ_FOUNDERS list about to be
 * published, not with the table, which still holds the previous deploy's founders. Then
 * `publishFounders` writes the table. So a founder added or removed passes once the vault's list
 * was minted from the new HQ_FOUNDERS (`pnpm founders:principals`), and a disagreement stops the
 * deploy before anything changes.
 */
export async function runPredeploy(
  config: BootConfig & { slack: { teamId?: string | undefined } },
  db: Database,
  agentPrincipals: string | undefined,
  now: Date,
): Promise<PredeployResult> {
  const problems = predeployProblems(config)
  const teamId = config.slack.teamId
  if (!teamId) problems.push("HQ_SLACK_TEAM_ID is not set: the agent's founder list needs it.")
  if (problems.length > 0 || !teamId) return { ok: false, problems }

  const principals = await founderPrincipalsFromList(db, teamId, config.founders, {
    pinnedOnly: true,
  })
  const drift = checkFounderPrincipals(principals, agentPrincipals)
  if (!drift.ok) {
    return {
      ok: false,
      problems: [
        "AGENT_FOUNDER_PRINCIPALS disagrees with the founders HQ_FOUNDERS publishes " +
          `(missing from the agent: ${drift.missing.join(", ") || "none"}; listed by the agent ` +
          `but not founders: ${drift.extra.join(", ") || "none"}). Nothing was written. Mint ` +
          "the agent's list with pnpm founders:principals, store it, then run predeploy again.",
      ],
    }
  }
  const synced = await publishFounders(config, db, now)
  return { ok: true, synced, principals }
}
