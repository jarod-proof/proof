// Facts the Security page shows that better-auth doesn't expose in one place: when the password last
// changed, when two-factor was switched on, and how many backup codes are left. The backup codes are
// stored encrypted, so the count is taken by decrypting them here; the codes themselves never leave.
import type { BetterAuthPlugin } from "better-auth"
import { createAuthEndpoint, sessionMiddleware } from "better-auth/api"
import { symmetricDecrypt } from "better-auth/crypto"

export const securitySummary = createAuthEndpoint(
  "/security/summary",
  { method: "GET", use: [sessionMiddleware] },
  async (ctx) => {
    const userId = ctx.context.session.user.id
    const user = await ctx.context.internalAdapter.findUserById(userId)
    // The two-factor fields are the app's and the plugin's user columns, not in better-auth's user type.
    const twoFactorEnabled =
      user !== null && "twoFactorEnabled" in user && user.twoFactorEnabled === true
    const twoFactorEnabledAt =
      user !== null && "twoFactorEnabledAt" in user && user.twoFactorEnabledAt instanceof Date
        ? user.twoFactorEnabledAt
        : null
    const accounts = await ctx.context.internalAdapter.findAccounts(userId)
    // The password is the credential account. Its updatedAt moves when the password is set or changed.
    const credential = accounts.find((a) => a.providerId === "credential")

    let backupCodesRemaining: number | null = null
    if (twoFactorEnabled) {
      const row = await ctx.context.adapter.findOne<{ backupCodes: string }>({
        model: "twoFactor",
        where: [{ field: "userId", value: userId }],
      })
      if (row) {
        try {
          const codes = await symmetricDecrypt({
            key: ctx.context.secretConfig,
            data: row.backupCodes,
          })
          const parsed: unknown = JSON.parse(codes)
          backupCodesRemaining = Array.isArray(parsed) ? parsed.length : null
        } catch {
          backupCodesRemaining = null
        }
      }
    }

    return ctx.json({
      passwordChangedAt: credential ? credential.updatedAt : null,
      twoFactorEnabled,
      twoFactorEnabledAt,
      backupCodesRemaining,
    })
  },
)

export const securitySummaryPlugin = () =>
  ({
    id: "proof-security-summary",
    endpoints: { securitySummary },
  }) satisfies BetterAuthPlugin
