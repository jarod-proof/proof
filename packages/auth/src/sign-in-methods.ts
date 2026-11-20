// Which sign-in methods this server offers, so the sign-in page shows only those. Public: it answers
// before anyone signs in, and reveals only which methods are configured, never their keys.
import type { BetterAuthPlugin } from "better-auth"
import { createAuthEndpoint } from "better-auth/api"
import type { SignInMethods, SocialProvider } from "./sign-in-methods-shared"

export type { SignInMethods, SocialProvider } from "./sign-in-methods-shared"

/** The slice of the auth options that decides which methods are on. */
export interface SignInMethodOptions {
  github?: { clientId: string; clientSecret: string }
  google?: { clientId: string; clientSecret: string }
  stripe?: { plans?: readonly unknown[] }
}

/**
 * The methods createAuth mounts, from its options. Password, magic link, passkey and SSO are always
 * mounted (createAuth in index.ts); a social provider is offered only when both of its values were
 * passed, the same test createAuth applies before it registers the provider. Stripe counts only with
 * at least one plan: without plans createAuth turns subscriptions off, so the web keeps its fixture.
 */
export function signInMethodsOf(opts: SignInMethodOptions): SignInMethods {
  const social: SocialProvider[] = []
  if (opts.github?.clientId && opts.github.clientSecret) social.push("github")
  if (opts.google?.clientId && opts.google.clientSecret) social.push("google")
  return {
    password: true,
    magicLink: true,
    passkey: true,
    social,
    sso: true,
    stripe: (opts.stripe?.plans?.length ?? 0) > 0,
  }
}

export const signInMethodsPlugin = (methods: SignInMethods) =>
  ({
    id: "proof-sign-in-methods",
    endpoints: {
      signInMethods: createAuthEndpoint("/sign-in-methods", { method: "GET" }, async (ctx) =>
        ctx.json(methods),
      ),
    },
  }) satisfies BetterAuthPlugin
