import { agentEnv } from "@proof/env/agent"
import { type ClickCapture, clickCapture } from "./capture.js"
import { isSlackRequestAuthentic } from "./verify.js"

/**
 * eve's `webhookVerifier` for the Slack channel: the signature check for every inbound Slack
 * request (mentions, DMs, answers, clicks), plus keeping the bytes of a card click for hq.
 *
 * @remarks
 * Supplying a verifier replaces eve's own signing-secret check entirely, so this one must refuse
 * everything eve's would: it answers `true` only for a request whose v0 signature, over the exact
 * body text eve passes in, verifies with SLACK_SIGNING_SECRET, within the time window. Anything
 * else, an unset secret included, is `false`, which eve turns into a 401. It returns `true`, never
 * a string: eve would take a returned string as the replacement body.
 */
export function createSlackWebhookVerifier(
  options: { secret?: () => string | undefined; capture?: ClickCapture; now?: () => Date } = {},
) {
  const secret = options.secret ?? (() => agentEnv("SLACK_SIGNING_SECRET"))
  const capture = options.capture ?? clickCapture
  const now = options.now ?? (() => new Date())

  return async function verifySlackWebhook(request: Request, body: string): Promise<boolean> {
    const signingSecret = secret()
    if (!signingSecret) return false
    const signature = request.headers.get("x-slack-signature") ?? ""
    const timestamp = request.headers.get("x-slack-request-timestamp") ?? ""
    if (
      !isSlackRequestAuthentic({
        rawBody: body,
        signature,
        timestamp,
        secret: signingSecret,
        now: now(),
      })
    ) {
      return false
    }
    capture.keep({ rawBody: body, signature, timestamp })
    return true
  }
}
