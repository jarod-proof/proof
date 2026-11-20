/**
 * Hand a Slack card click to hq, which decides it.
 *
 * @remarks
 * The agent decides nothing and sends no credential: it passes the request body and Slack's two
 * signature headers on exactly as received, to `POST /v1/slack/actions`, where hq verifies
 * Slack's signature over those same bytes, maps the Slack user to a founder and runs the decision
 * as that founder. No hq API key, cookie or authorization header is attached, so the agent's key
 * can never reach `decide_proposal` or `grant_spend` through this path.
 */

export interface ForwardedAction {
  /** hq's answer: 200 done, 403 refused, 409 nothing changed. */
  status: number
  /** What to tell the person who clicked. */
  text: string
}

export interface ForwardOptions {
  /** hq's base URL (HQ_BASE_URL). */
  hqBaseUrl: string
  rawBody: string
  /** `X-Slack-Signature`, as received. */
  signature: string
  /** `X-Slack-Request-Timestamp`, as received. */
  timestamp: string
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 8_000

export async function forwardSlackAction(options: ForwardOptions): Promise<ForwardedAction> {
  const send = options.fetch ?? fetch
  let response: Response
  try {
    response = await send(`${options.hqBaseUrl.replace(/\/+$/, "")}/v1/slack/actions`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-signature": options.signature,
        "x-slack-request-timestamp": options.timestamp,
      },
      body: options.rawBody,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
  } catch {
    return { status: 0, text: "hq could not be reached, so nothing changed. Try again." }
  }
  const reply = (await response.json().catch(() => ({}))) as { text?: unknown }
  return {
    status: response.status,
    text:
      typeof reply.text === "string" && reply.text !== ""
        ? reply.text
        : `hq answered ${response.status}.`,
  }
}
