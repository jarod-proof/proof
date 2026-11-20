import { agentEnv } from "@proof/env/agent"
import { fetchAppSlug } from "./app-token.js"
import { githubAppId, githubPrivateKey } from "./credentials.js"

/**
 * Name used where a resolution failure must not stop the work, like the
 * sandbox commit identity. Matches the template's default persona.
 */
export const FALLBACK_BOT_NAME = "Foreman"

/**
 * Upper bound on a resolved bot name before it is interpolated into a
 * regular expression; GitHub App slugs are far shorter in practice.
 */
const MAX_BOT_NAME_LENGTH = 80

/** What GitHub gives an App slug: lower-case letters, digits and hyphens, never upper case. */
const SLUG = /^[a-z0-9][a-z0-9-]*$/

let resolvedFromApp: string | undefined

/**
 * The name the factory answers to in `@mentions`, resolved without setup.
 *
 * @remarks
 * Resolution order:
 * 1. `FACTORY_BOT_NAME`, then `GITHUB_APP_SLUG`, for explicit overrides.
 * 2. The GitHub App's own slug, from `GET /app` under the app's JWT
 *    (`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`), so the mention
 *    automatically follows whatever the deployer named their app. Cached for
 *    the life of the instance.
 *
 * A failure throws and is never cached. That contract is what the channel's
 * lazy `botName` resolution relies on: eve calls this on first use inside
 * request handling, caches a fulfilled name, and retries a rejection on the
 * next event, so a transient outage can't pin a wrong name. Callers that need an answer no matter what catch and
 * use {@link FALLBACK_BOT_NAME}.
 *
 * A hardcoded name is wrong here because the app's slug is chosen by whoever
 * registers it, and a guessed handle can belong to a real GitHub user.
 *
 * @throws When the app's credentials are not set, GitHub is unreachable or
 * refuses, or the answer carries no usable slug.
 */
export async function resolveBotName(): Promise<string> {
  const override = agentEnv("FACTORY_BOT_NAME") ?? agentEnv("GITHUB_APP_SLUG")
  if (override) {
    return override
  }
  if (resolvedFromApp !== undefined) {
    return resolvedFromApp
  }
  const slug = await fetchAppSlug({ appId: githubAppId(), privateKeyPem: githubPrivateKey() })
  if (slug.length > MAX_BOT_NAME_LENGTH || !SLUG.test(slug)) {
    throw new Error("GitHub's answer carries no usable GitHub App slug.")
  }
  resolvedFromApp = slug
  return slug
}

/** Forgets the cached slug. For tests. */
export function resetBotNameCache(): void {
  resolvedFromApp = undefined
}

/**
 * Builds the mention matcher for a resolved bot name: `@<name>` on a word
 * boundary, the same shape the channel's built-in comment gate uses.
 *
 * @remarks
 * The name is escaped for literal matching before interpolation, and
 * {@link resolveBotName} bounds its length, so GitHub-supplied data can
 * never change the pattern's meaning.
 */
export function mentionPattern(botName: string): RegExp {
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`@${escaped}(?=$|[^A-Za-z0-9_-])`, "iu")
}
