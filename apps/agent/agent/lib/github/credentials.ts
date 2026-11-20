import { agentEnv } from "@proof/env/agent"
import type { GitHubChannelCredentials } from "eve/channels/github"
import { normalizePem } from "./app-token.js"
import { mintChannelToken } from "./lease.js"

/**
 * The GitHub App's credentials, from the org's own App and no broker: its id, its private key and
 * the webhook secret, read from the environment (the org's vault) at the moment of use.
 *
 * @remarks
 * Each is a function, never a value read at load: discovery and the build load this module with no
 * secrets, and a test sets its own. A missing or blank value throws naming the variable (never a
 * value) and fails closed. A blank webhook secret in particular must not become an empty HMAC key,
 * which anyone could sign with.
 *
 * `appId` and `privateKey` are passed so eve resolves them through these same fail-closed readers
 * rather than falling back to the environment itself. While `installationToken` is set eve never
 * mints a token from them: every installation token the channel acts with is the narrower one from
 * `mintChannelToken` (`lease.ts`): issues and pull requests on the factory repository, contents
 * read-only, not every permission the app holds.
 */
const required = (name: "GITHUB_APP_ID" | "GITHUB_APP_PRIVATE_KEY" | "GITHUB_WEBHOOK_SECRET") => {
  const value = agentEnv(name)
  // Whitespace counts as blank for the check only; what is returned is the value as given.
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is not set: the GitHub App's credentials are needed.`)
  }
  return value
}

/** The app id (`GITHUB_APP_ID`), trimmed: an id never has edge whitespace. */
export const githubAppId = (): string => required("GITHUB_APP_ID").trim()

/** The app's private key as a PEM, quotes and `\n` escapes undone (`GITHUB_APP_PRIVATE_KEY`). */
export const githubPrivateKey = (): string => normalizePem(required("GITHUB_APP_PRIVATE_KEY"))

/**
 * The secret GitHub signs webhooks with (`GITHUB_WEBHOOK_SECRET`), exactly as set: it is the HMAC
 * key, so edge whitespace is part of it, not stripped.
 */
export const githubWebhookSecret = (): string => required("GITHUB_WEBHOOK_SECRET")

/** What `githubChannel` is given: the app's identity, the webhook secret and the narrowed token. */
export const githubCredentials: GitHubChannelCredentials = {
  appId: githubAppId,
  installationToken: () => mintChannelToken(),
  privateKey: githubPrivateKey,
  webhookSecret: githubWebhookSecret,
}
