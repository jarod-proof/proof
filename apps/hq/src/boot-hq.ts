// Everything hq does between "the process has started" and "there is an app to serve": read the
// environment, open the database, run `prepareBoot` (refuse an unsafe deploy, sync the founders
// table), build auth and the app. One function, so the two entries cannot drift: `server.ts` (the
// Node listener, local and e2e) and `index.ts` (the Vercel function) both call `bootHq` and
// nothing else decides what a safe boot is.
import { createDb, type Database } from "@proof/db"
import { setErrorReporter } from "@proof/errors"
import { createLogger } from "@proof/logger"

import { createHqApp } from "./app"
import { createHqAuth } from "./auth"
import { prepareBoot } from "./boot"
import { isProductionLike } from "./deploy-mode"
import type { hqEnv } from "./env"

const logger = createLogger({ name: "hq" })

/** What `hqEnv` returns: the environment hq boots from. */
export type HqConfig = ReturnType<typeof hqEnv>

export interface BootHqOptions {
  /** The port a launcher passes as an argument (the e2e runner picks a free one). */
  portArg?: string
  /** Tests give the config and the database; a real boot reads the environment. */
  config?: HqConfig
  db?: Database
  /**
   * Boot as a deployed hq whatever NODE_ENV is: sign-up must be closed and the founders table is
   * only verified, never written. The Vercel entry sets it.
   */
  deployed?: boolean
  /** The clock; the founder rows and the app's timestamps read it. */
  now?: () => Date
}

export interface BootedHq {
  app: ReturnType<typeof createHqApp>
  config: HqConfig
}

let reporterRegistered = false

/**
 * Boot hq. Throws, and serves nothing, when the environment is unsafe or incomplete: a deployed
 * hq with sign-up open, a missing database URL, a founder list it cannot parse, a failed sync, a
 * deployed founders table that is not this deployment's list. The app it returns is only ever
 * built after the table has been set to HQ_FOUNDERS (local) or verified against it (deployed).
 */
export async function bootHq(options: BootHqOptions = {}): Promise<BootedHq> {
  if (!reporterRegistered) {
    setErrorReporter((error, context) => {
      logger.error({ err: error, ...context }, error.message)
    })
    reporterRegistered = true
  }
  // The environment is read here and not at import: @proof/env validates on first import, and a test
  // (or a refused boot) must be able to reach this function without it.
  const read = options.config ?? (await import("./env")).hqEnv(options.portArg)
  // The Vercel entry is always a deployed hq: whatever NODE_ENV says (a dashboard override to
  // development would otherwise make this boot write the founders table and open sign-up).
  const config: HqConfig = options.deployed ? { ...read, nodeEnv: "production" } : read
  const now = options.now ?? (() => new Date())
  // A database this call opened is closed again if the boot is refused: nothing else holds it.
  const owned = options.db ? undefined : createDb(config.databaseUrl)
  const db = options.db ?? owned
  if (!db) throw new Error("hq has no database")
  try {
    // A local hq sets the founders table to HQ_FOUNDERS at every boot. A deployed hq refuses to
    // start with public sign-up on (founders are made on the server, by create-founder), takes
    // only the entries pinned by user id, and WRITES NOTHING: it serves only if the table already
    // equals its list (pnpm hq:predeploy wrote it), else this throws and every request is 503.
    // The decisions are in boot.ts.
    const synced = await prepareBoot(config, db, now())
    // Closed unless HQ_ALLOW_SIGNUP: a stranger cannot self-register on hq.
    const auth = createHqAuth(db, config)
    logger.info(
      {
        founders: config.founders.length,
        added: synced.added.length,
        removed: synced.removed.length,
      },
      isProductionLike(config.nodeEnv) ? "founders verified" : "founders synced",
    )
    // Where the entry is in the list and why, never the address: a log is not a place for it.
    for (const skipped of synced.skipped) {
      logger.warn(
        `founder not synced: HQ_FOUNDERS entry ${skipped.entry} (${skipped.kind}): ${skipped.why}`,
      )
    }
    if (config.founders.length === 0) {
      logger.warn("HQ_FOUNDERS is empty: nobody can approve proposals, in the admin or in Slack")
    }
    if (config.allowSignUp) logger.warn("HQ_ALLOW_SIGNUP is on: anyone can create an account on hq")
    if (!config.slack.signingSecret || !config.slack.teamId) {
      logger.warn("SLACK_SIGNING_SECRET or HQ_SLACK_TEAM_ID is unset: Slack approvals are refused")
    }
    const app = createHqApp({
      db,
      auth,
      now,
      slack: config.slack,
      baseURL: config.baseURL,
    })
    return { app, config }
  } catch (error) {
    await owned?.$client.end({ timeout: 1 }).catch(() => undefined)
    throw error
  }
}

/** The Vercel entry's boot: `bootHq` as a deployed hq, which no environment variable can undo. */
export const bootVercel = (options: Omit<BootHqOptions, "deployed"> = {}): Promise<BootedHq> =>
  bootHq({ ...options, deployed: true })
