import { defaultSlackAuth, defineSlackRenderer, type SlackChannelConfig } from "eve/channels/slack"
import { log } from "../log.js"
import { sessionSpendStore } from "../spend/state.js"
import { handleCardClick } from "./interaction.js"
import { allowedSlackAuth, founderAnswerAuth } from "./policy.js"
import { postCapRefusal } from "./refusal.js"
import { createSlackWebhookVerifier } from "./webhook-verifier.js"

/**
 * The Slack channel's configuration, kept apart from `agent/channels/slack.ts` so its handlers are
 * tested directly.
 *
 * - Mentions and DMs start a turn only for a person from a listed workspace and never for a bot.
 * - `onAnswers` admits only a listed founder, for every approval and question, so someone who may
 *   start a turn cannot approve what it asks for. A rejected answer leaves the request open. It
 *   combines with each tool's own response policy (see `founderAnswerAuth`): a founder approves
 *   only the writes they asked for, except a bigger model, which any founder may approve.
 * - `capRefusal` posts the refusal text when `agent/hooks/spend.ts` cancels a turn.
 */
export const capRefusal = defineSlackRenderer({
  events: {
    async "turn.settled"(event, ctx, next) {
      await next()
      try {
        await postCapRefusal(event, ctx.channel.thread, sessionSpendStore)
      } catch (error) {
        log.warn("slack: could not post the cap refusal", error)
      }
    },
  },
})

export const slackConfig = {
  botName: "Org agent",
  // Our own verifier, because hq must verify the same raw bytes: it checks the signature as eve's
  // would (and refuses everything else), and keeps a card click's body for `onInteraction`.
  credentials: { webhookVerifier: createSlackWebhookVerifier() },
  // A click on one of hq's cards (a proposal, a spend grant) is forwarded to hq, which decides it
  // as the founder the Slack user maps to. eve routes only non-HITL actions here.
  async onInteraction(action) {
    try {
      await handleCardClick(action)
    } catch (error) {
      log.warn("slack: could not forward a card click", error)
    }
  },
  onAppMention(ctx, message) {
    if (message.author?.isBot !== false) {
      return null
    }
    const auth = allowedSlackAuth(defaultSlackAuth(message, ctx))
    return auth === null ? null : { auth }
  },
  onDirectMessage(ctx, message) {
    if (message.author?.isBot !== false) {
      return null
    }
    const auth = allowedSlackAuth(defaultSlackAuth(message, ctx))
    return auth === null ? null : { auth }
  },
  onAnswers(ctx) {
    const auth = founderAnswerAuth(ctx.defaultAuth)
    return auth === null ? null : { auth }
  },
  renderers: [capRefusal],
} satisfies SlackChannelConfig
