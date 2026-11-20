import { slackChannel } from "eve/channels/slack"
import { slackConfig } from "../lib/slack/config.js"

/**
 * The Slack channel: mentions and DMs in, replies, approvals and the cap refusal out.
 *
 * @remarks
 * Credentials are eve's portable ones, `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`, from the org's
 * vault. Who may start a turn and who may answer an approval (founders only) are in
 * `agent/lib/slack/config.ts`; the click that grants spend in hq is Task 8.
 */
export default slackChannel(slackConfig)
