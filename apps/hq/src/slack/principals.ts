import {
  type FounderSeed,
  type FounderSyncOptions,
  founderSlackUserIds,
  planFounders,
} from "../data/founders"
import type { Database } from "@proof/db"

/**
 * The agent's founder list, derived from hq's founders table. The agent identifies a Slack person
 * as `slack:<team>:<user>` and answers only approvals from AGENT_FOUNDER_PRINCIPALS; hq decides
 * clicks from the table. Deriving the one from the other keeps a single source of truth: generate
 * AGENT_FOUNDER_PRINCIPALS from this, and run `checkFounderPrincipals` wherever both are known (the
 * `founders:principals --check` script, and a test) so drift fails loudly.
 */
export function founderPrincipals(teamId: string, slackUserIds: readonly string[]): string[] {
  return [...new Set(slackUserIds)].sort().map((id) => `slack:${teamId}:${id}`)
}

export const founderPrincipalsFromDb = async (db: Database, teamId: string): Promise<string[]> =>
  founderPrincipals(teamId, await founderSlackUserIds(db))

/**
 * The agent's founder list for an HQ_FOUNDERS list, without reading the founders table: who the
 * list resolves to (an account that exists, unbanned, verified, and by id when deployed), which is
 * what a sync of it would leave in the table. `pnpm hq:predeploy` compares AGENT_FOUNDER_PRINCIPALS
 * with this before it writes, and the vault's list is minted from it before predeploy runs.
 */
export async function founderPrincipalsFromList(
  db: Database,
  teamId: string,
  seeds: readonly FounderSeed[],
  options: FounderSyncOptions = {},
): Promise<string[]> {
  const { wanted } = await planFounders(db, seeds, options)
  return founderPrincipals(teamId, [...wanted.values()])
}

export interface PrincipalDrift {
  ok: boolean
  /** Founders in hq that the agent does not list: they cannot approve in Slack through eve. */
  missing: string[]
  /** Principals the agent lists that are no founder in hq: they could approve what hq refuses. */
  extra: string[]
}

/** Compare hq's derived list with the agent's configured one (a comma-separated string or a list). */
export function checkFounderPrincipals(
  derived: readonly string[],
  configured: string | readonly string[] | undefined,
): PrincipalDrift {
  const list = typeof configured === "string" ? configured.split(",") : [...(configured ?? [])]
  const have = new Set(list.map((p) => p.trim()).filter(Boolean))
  const want = new Set(derived)
  const missing = [...want].filter((p) => !have.has(p)).sort()
  const extra = [...have].filter((p) => !want.has(p)).sort()
  return { ok: missing.length === 0 && extra.length === 0, missing, extra }
}
