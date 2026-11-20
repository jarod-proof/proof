import { join } from "node:path"

// The founder the hq target (e2e.config.ts, scripts/e2e-hq-stack.mjs) seeds. hq lets in only
// founders, and an address counts once verified, which hq has no mail sink for: the stack signs this
// account up and marks it verified at startup. Local stack only. Not a test file.
export const HQ_FOUNDER_EMAIL = "hq-founder@example.test"
export const HQ_FOUNDER_PASSWORD = "e2e hq founder on the local stack only"
/**
 * The founder's Slack user, in hq's founders table (HQ_FOUNDERS), and the workspace and signing
 * secret the `slack` target's hq and agent share. Made-up values for the local stack only.
 */
export const HQ_FOUNDER_SLACK_USER = "UE2EFOUNDER"
export const E2E_SLACK_TEAM = "T0E2E"
export const E2E_SLACK_SIGNING_SECRET = "e2e slack signing key on the local stack only"
/** Each `slack` stack writes `<agent port>.json` here: its hq URL and the agent URL. */
export const SLACK_STACKS_DIR = join(process.cwd(), ".e2e", "slack-stacks")
