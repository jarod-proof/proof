import { agentEnv } from "@proof/env/agent"
import { offlineMode } from "../offline/mode.js"
import { CARD_ACTION_PREFIX, type ClickCapture, clickCapture } from "./capture.js"
import { type ForwardedAction, forwardSlackAction } from "./forward-action.js"

/**
 * What the Slack channel does with a click on one of hq's cards (`onInteraction`): take the bytes
 * its verifier kept for that click, forward them to hq, and show the answer to the person who
 * clicked. The agent decides nothing here.
 */

/** The part of eve's parsed action this reads. */
export interface CardClick {
  actionId: string
  triggerId?: string
  responseUrl?: string
  user: { id: string }
}

export interface CardClickDeps {
  capture?: ClickCapture
  forward?: typeof forwardSlackAction
  /** hq's base URL; default HQ_BASE_URL. */
  hqBaseUrl?: () => string | undefined
  /** Shows the answer in Slack; default posts to the click's `response_url`. */
  respond?: (click: CardClick, reply: Reply) => Promise<void>
}

/** What a person is told: replacing the card when the click was decided, privately otherwise. */
export interface Reply {
  text: string
  /** True: replace the card (decided). False: only the clicker sees it (refused, nothing changed). */
  replaceCard: boolean
}

/** Whether a Slack `response_url` may be posted to: Slack's own host (loopback only when offline). */
export function isResponseUrlAllowed(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol === "https:" && url.hostname === "hooks.slack.com") return true
  return (
    offlineMode() && url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)
  )
}

/** Post a reply to a click's `response_url`. Best effort: the decision is already made. */
export async function respondViaResponseUrl(click: CardClick, reply: Reply): Promise<void> {
  if (!click.responseUrl || !isResponseUrlAllowed(click.responseUrl)) return
  try {
    await fetch(click.responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        reply.replaceCard
          ? { replace_original: true, text: reply.text }
          : { response_type: "ephemeral", replace_original: false, text: reply.text },
      ),
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    // The founder just does not see the note; hq already holds the outcome.
  }
}

/** Handle one click. Returns what was forwarded to hq, or null when nothing was. */
export async function handleCardClick(
  click: CardClick,
  deps: CardClickDeps = {},
): Promise<ForwardedAction | null> {
  // Not one of hq's buttons (eve routes only the non-HITL ones here): not ours to answer.
  if (!click.actionId.startsWith(CARD_ACTION_PREFIX)) return null
  const respond = deps.respond ?? respondViaResponseUrl
  const captured = (deps.capture ?? clickCapture).take(click)
  if (!captured) {
    // No verified bytes for this click (expired, replayed, or not what eve parsed): refuse it.
    await respond(click, {
      replaceCard: false,
      text: "I couldn't verify that click, so nothing changed. Please click again.",
    })
    return null
  }
  const hqBaseUrl = (deps.hqBaseUrl ?? (() => agentEnv("HQ_BASE_URL")))()
  if (!hqBaseUrl) {
    await respond(click, { replaceCard: false, text: "hq is not configured, so nothing changed." })
    return null
  }
  const answer = await (deps.forward ?? forwardSlackAction)({ hqBaseUrl, ...captured })
  await respond(click, { text: answer.text, replaceCard: answer.status === 200 })
  return answer
}
