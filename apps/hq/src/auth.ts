import { createAuth } from "@proof/auth"
import type { Database } from "@proof/db"

/** What hq's auth takes from its environment (`hqEnv`). */
export interface HqAuthConfig {
  secret: string
  baseURL: string
  emailFrom: string
  /** HQ_ALLOW_SIGNUP: closed unless turned on, so a stranger cannot self-register. */
  allowSignUp: boolean
}

/** hq's auth: the product's, in hq's own database, with sign-up closed unless the config opens it. */
export function createHqAuth(db: Database, config: HqAuthConfig) {
  return createAuth({
    db,
    secret: config.secret,
    baseURL: config.baseURL,
    emailFrom: config.emailFrom,
    oauthResources: [config.baseURL, `${config.baseURL}/mcp`],
    // The founders sign in from the web app's origin or an agent client; hq has no web app yet.
    webOrigins: [],
    rateLimit: {},
    allowSignUp: config.allowSignUp,
  })
}
