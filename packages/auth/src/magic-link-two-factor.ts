// A sign-in by emailed link proves the mailbox, not the second factor. better-auth's magic-link verify
// signs the person straight in, so a user with two-factor on would skip the code. This hook runs after
// the verify endpoint and, for such a user, does what the password sign-in does: it deletes the session
// the link just created and opens the same challenge (the `two_factor` cookie and the verification rows
// that /two-factor/verify-totp and /two-factor/verify-backup-code consume). The browser then goes to the
// app's /two-factor page with the link's callbackURL, so the code entry resumes where the link was headed.
// Trusted-device cookies are not honoured here: a link always asks for the code.
import { randomBytes } from "node:crypto"
import type { BetterAuthPlugin } from "better-auth"
import { createAuthMiddleware } from "better-auth/api"
import { deleteSessionCookie } from "better-auth/cookies"
import { TWO_FACTOR_PATH } from "./constants"
import { CHALLENGE_METHOD_PREFIX } from "./login-method"

/** How long the code entry stays open, as better-auth's two-factor plugin sets it by default. */
const CHALLENGE_SECONDS = 600

export const twoFactorMagicLink = (opts: { baseURL: string }) =>
  ({
    id: "proof-magic-link-two-factor",
    hooks: {
      after: [
        {
          matcher: (ctx: { path?: string }) => ctx.path === "/magic-link/verify",
          handler: createAuthMiddleware(async (ctx) => {
            const session = ctx.context.newSession
            if (!session || !(session.user as { twoFactorEnabled?: boolean }).twoFactorEnabled)
              return

            // The session the link created must not survive the challenge.
            deleteSessionCookie(ctx, true)
            await ctx.context.internalAdapter.deleteSession(session.session.token)
            ctx.context.setNewSession(null)

            const expiresAt = new Date(Date.now() + CHALLENGE_SECONDS * 1000)
            const identifier = `2fa-${randomBytes(20).toString("base64url")}`
            await ctx.context.internalAdapter.createVerificationValue({
              value: session.user.id,
              identifier,
              expiresAt,
            })
            await ctx.context.internalAdapter.createVerificationValue({
              value: "0",
              identifier: `2fa-attempts-${identifier}`,
              expiresAt,
            })
            // The code entry that follows is a sign-in by link: record that for the session it creates.
            await ctx.context.internalAdapter.createVerificationValue({
              value: "magic-link",
              identifier: `${CHALLENGE_METHOD_PREFIX}${identifier}`,
              expiresAt,
            })
            const cookie = ctx.context.createAuthCookie("two_factor", { maxAge: CHALLENGE_SECONDS })
            await ctx.setSignedCookie(
              cookie.name,
              identifier,
              ctx.context.secret,
              cookie.attributes,
            )

            // The sign-in always sends a callbackURL ("/" by default), and the link carries it on.
            const query = ctx.query as { callbackURL?: unknown } | undefined
            const callbackURL = typeof query?.callbackURL === "string" ? query.callbackURL : "/"
            throw ctx.redirect(
              `${opts.baseURL}${TWO_FACTOR_PATH}?${new URLSearchParams({ callbackURL: decodeURIComponent(callbackURL) })}`,
            )
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin
