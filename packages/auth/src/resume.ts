// A sign-in by emailed link has no request of its own to carry the pending OAuth authorization (the
// link opens in a new request). So the authorization query the sign-in page sent is moved into the
// link's callbackURL: once the link signs the person in, it lands on the authorize endpoint again,
// which now has a session and goes on to consent. This runs after oauthProvider's before hook, which
// has already checked the query's signature (a forged one is refused with invalid_signature). A
// link that fails (expired, reused) goes back to the sign-in page, not to authorize.
import { createAuthMiddleware } from "better-auth/api"
import type { BetterAuthPlugin } from "better-auth"

/** Signature and bookkeeping parameters of a signed OAuth query: not part of the authorization. */
const SIGNING_PARAMS = new Set(["sig", "exp", "ba_param", "ba_iat", "ba_pl"])

export const resumeMagicLinkAuthorization = (opts: { authorizeUrl: string; signInUrl: string }) =>
  ({
    id: "proof-resume-magic-link",
    hooks: {
      before: [
        {
          matcher: (ctx: { path?: string; body?: unknown }) =>
            ctx.path === "/sign-in/magic-link" &&
            typeof (ctx.body as { oauth_query?: unknown } | undefined)?.oauth_query === "string",
          handler: createAuthMiddleware(async (ctx) => {
            const body = ctx.body as { oauth_query: string; [key: string]: unknown }
            const params = new URLSearchParams(body.oauth_query)
            const authorization = new URLSearchParams()
            for (const [key, value] of params) {
              if (!SIGNING_PARAMS.has(key)) authorization.append(key, value)
            }
            return {
              context: {
                body: {
                  ...body,
                  oauth_query: undefined,
                  callbackURL: `${opts.authorizeUrl}?${authorization}`,
                  errorCallbackURL: opts.signInUrl,
                },
              },
            }
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin
