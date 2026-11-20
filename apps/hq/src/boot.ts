// What hq decides when it starts, as functions server.ts and the Vercel entry call (through
// boot-hq.ts) and nothing else: a deployed hq (NODE_ENV not development or test) must not have
// public sign-up on, takes founders by user id only, and never writes the founders table at boot.
// Kept out of server.ts so a test can reach it: deleting any of these decisions reopens the N5
// squatter (an account registered with a founder's address, verified from the founder's inbox) or
// lets an older deployment put back a founder the newest one removed.
import type { Database } from "@proof/db"

import { type FounderSeed, type FounderSync, syncFounders, verifyFounders } from "./data/founders"
import { assertSignUpClosedWhenDeployed, isProductionLike } from "./deploy-mode"

export interface BootConfig {
  nodeEnv: string | undefined
  /** HQ_ALLOW_SIGNUP. */
  allowSignUp: boolean
  /** HQ_FOUNDERS, parsed. */
  founders: readonly FounderSeed[]
}

/**
 * What a deployed boot throws when the table is not this deployment's list. The message goes to
 * the log and never to a caller (lazy-hq.ts answers a fixed 503).
 */
export class FoundersOutOfDateError extends Error {
  constructor(counts: { missing: number; extra: number }) {
    super(
      `the founders table does not match this deployment's HQ_FOUNDERS (${counts.missing} missing or ` +
        `changed, ${counts.extra} not listed): a newer deploy changed it, or pnpm hq:predeploy has ` +
        "not run for this one. Run pnpm hq:predeploy against this environment, then redeploy.",
    )
    this.name = "FoundersOutOfDateError"
  }
}

/**
 * The deploy-time write: refuses (throws) a deployed hq with sign-up open, then sets the founders
 * table to the list. In a deployed hq an `email=` entry is skipped and only `id:` entries count.
 * `pnpm hq:predeploy` calls this against the production database, so the deploy that ships last
 * is the one whose list the table holds; a local hq's boot calls it too (`prepareBoot`).
 */
export async function publishFounders(
  config: BootConfig,
  db: Database,
  now: Date,
): Promise<FounderSync> {
  assertSignUpClosedWhenDeployed(config)
  return syncFounders(db, config.founders, now, { pinnedOnly: isProductionLike(config.nodeEnv) })
}

/**
 * What a boot does about the founders. Refuses to start (throws) a deployed hq with sign-up open.
 *  - Local and e2e (NODE_ENV development or test): sets the table to the list, as ever.
 *  - Deployed: writes nothing. It throws `FoundersOutOfDateError` unless the table is already
 *    exactly what this deployment's list resolves to. Any request to any deployment can start a
 *    boot, including an old one that is still reachable at its own URL, so a deployed boot that
 *    wrote would let that old deployment re-add a founder the newest one removed.
 */
export async function prepareBoot(
  config: BootConfig,
  db: Database,
  now: Date,
): Promise<FounderSync> {
  assertSignUpClosedWhenDeployed(config)
  if (!isProductionLike(config.nodeEnv)) return publishFounders(config, db, now)
  const checked = await verifyFounders(db, config.founders, { pinnedOnly: true })
  if (!checked.current) throw new FoundersOutOfDateError(checked)
  return { added: [], removed: [], skipped: checked.skipped }
}
