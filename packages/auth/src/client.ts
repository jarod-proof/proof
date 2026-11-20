import {
  oauthDeviceAuthorizationClient,
  oauthProviderClient,
} from "@better-auth/oauth-provider/client"
import { passkeyClient } from "@better-auth/passkey/client"
import { ssoClient } from "@better-auth/sso/client"
import { stripeClient } from "@better-auth/stripe/client"
import { entitlementsClient } from "@byo-oss/entitlements/client"
import { inboxClient } from "@byo-oss/notifications/client"
import { supportClient } from "@byo-oss/support/client"
import { wrapsClient } from "@wraps.dev/better-auth/client"
import type { BetterAuthClientOptions, BetterAuthClientPlugin } from "better-auth/client"
import { createAuthClient } from "better-auth/client"
import {
  adminClient,
  lastLoginMethodClient,
  magicLinkClient,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins"
import { ac, roles } from "./access"
import type { SignInMethods } from "./sign-in-methods-shared"
import { TWO_FACTOR_PATH } from "./constants"

export { RESERVED_ORG_SLUGS, isReservedOrgSlug } from "./reserved-slugs"
// The server's catalog and the organization header, for the web app (which depends only on this entry).
export { roles, statements } from "./access"
export { personalSlug } from "./membership"
export type { SignInMethods, SocialProvider } from "./sign-in-methods-shared"
export {
  ACTIVE_SUBSCRIPTION_CODE,
  LAST_SIGN_IN_METHOD_CODE,
  OWNS_ORGANIZATION_CODE,
  PASSWORD_COMPROMISED_CODE,
  PASSWORD_COMPROMISED_MESSAGE,
  TWO_FACTOR_PATH,
} from "./constants"

/** The security page's summary (security-summary.ts): GET /api/auth/security/summary. */
const securitySummaryClient = () =>
  ({
    id: "proof-security-summary-client",
    getActions: ($fetch) => ({
      securitySummary: () =>
        $fetch<{
          passwordChangedAt: string | Date | null
          twoFactorEnabled: boolean
          twoFactorEnabledAt: string | Date | null
          backupCodesRemaining: number | null
        }>("/security/summary", { method: "GET" }),
    }),
  }) satisfies BetterAuthClientPlugin

/** The sign-in page's methods (sign-in-methods.ts): GET /api/auth/sign-in-methods, no session needed. */
const signInMethodsClient = () =>
  ({
    id: "proof-sign-in-methods-client",
    getActions: ($fetch) => ({
      signInMethods: () => $fetch<SignInMethods>("/sign-in-methods", { method: "GET" }),
    }),
  }) satisfies BetterAuthClientPlugin

/**
 * The browser client for this server's auth: sessions, passwords, organizations and the OAuth
 * provider's sign-in continuation (its fetch plugins carry the signed OAuth query), plus the
 * device-authorization endpoints, passkeys, two-factor, magic links and admin/impersonation.
 * A sign-in that needs a second factor reports `twoFactorRedirect`; the app goes to /two-factor.
 */
export const createClient = (
  baseURL?: string,
  fetchOptions?: BetterAuthClientOptions["fetchOptions"],
) =>
  createAuthClient({
    baseURL,
    fetchOptions,
    // ./access, not ./permissions: this ships to browsers (client.test.ts checks the imports).
    plugins: [
      wrapsClient(),
      organizationClient({ ac, roles }),
      oauthProviderClient(),
      oauthDeviceAuthorizationClient(),
      passkeyClient(),
      magicLinkClient(),
      lastLoginMethodClient(),
      adminClient(),
      ssoClient(),
      // Billing answers only when the server has Stripe configured (test mode); see index.ts.
      stripeClient({ subscription: true }),
      securitySummaryClient(),
      inboxClient(),
      // Customer support (support.ts): the widget's and the support queue's endpoints.
      supportClient(),
      // Plan entitlements (entitlements.ts): the organization's plan, and a refresh after checkout.
      entitlementsClient(),
      signInMethodsClient(),
      twoFactorClient({
        // The page keeps its query: a pending OAuth authorization rides on it into the code entry.
        onTwoFactorRedirect() {
          if (typeof window !== "undefined")
            window.location.href = `${TWO_FACTOR_PATH}${window.location.search}`
        },
      }),
    ],
  })
