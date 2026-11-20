import type { BetterAuthOptions } from "better-auth"

/**
 * The header better-auth reads the client address from. apps/api sets it from the address it trusts
 * (clientIp) and drops any copy a client sent, so a client cannot choose its own bucket.
 */
export const CLIENT_IP_HEADER = "x-proof-client-ip"

/** better-auth's `advanced.ipAddress`: one trusted header, which carries one address. */
export const authIpAddress = {
  ipAddressHeaders: [CLIENT_IP_HEADER],
} satisfies NonNullable<NonNullable<BetterAuthOptions["advanced"]>["ipAddress"]>

/** A rule's window is in seconds (better-auth's unit), `max` requests per window. */
export interface RateRule {
  window: number
  max: number
}

/** The global window (seconds) and max for auth endpoints without a rule of their own. */
export const GLOBAL_RATE_LIMIT = { window: 60, max: 120 } as const

export interface AuthRateLimitOptions {
  /** The window for every auth endpoint without a rule of its own (seconds). */
  window?: number
  /** Requests per window for every auth endpoint without a rule of its own. */
  max?: number
  /**
   * Overrides or adds per-path rules, keyed by the path under /api/auth. A rule of `false` exempts a
   * path from limiting. Exact keys and `*` wildcards are matched before the catch-all (CATCH_ALL_PATH).
   */
  rules?: Record<string, RateRule | false>
}

/**
 * Limits for the endpoints that check a credential, send mail or spend a one-time code. better-auth
 * keys each rule on client address and path, so the limit for one path does not share a count with
 * another. Paths are the 1.7.7 endpoints (rate-limit.test.ts checks the list).
 */
export const STRICT_RULES = {
  "/sign-in/email": { window: 60, max: 5 },
  "/sign-in/magic-link": { window: 300, max: 5 },
  // The magic-link plugin's own limit; listed so the catch-all below never loosens it.
  "/magic-link/verify": { window: 60, max: 5 },
  "/two-factor/verify-totp": { window: 60, max: 5 },
  "/two-factor/verify-backup-code": { window: 300, max: 5 },
  "/two-factor/send-otp": { window: 300, max: 3 },
  "/request-password-reset": { window: 300, max: 3 },
  "/reset-password": { window: 300, max: 5 },
  "/send-verification-email": { window: 300, max: 3 },
  "/sign-up/email": { window: 300, max: 5 },
  "/passkey/verify-authentication": { window: 60, max: 10 },
  "/sign-in/sso": { window: 60, max: 10 },
  "/change-email": { window: 300, max: 5 },
  "/change-password": { window: 300, max: 5 },
  // GETs that consume a token from an emailed link (better-auth's verify and reset-link pages).
  "/verify-email": { window: 300, max: 10 },
  "/reset-password/*": { window: 300, max: 5 },
  // better-auth's default for every /sign-in* path is 3 per 10 seconds. Social sign-in is a redirect
  // a person can repeat a few times, so it gets its own rule instead of that default.
  "/sign-in/social": { window: 60, max: 10 },
  // GETs that carry a single-use token in the query. GET /device (the short user code) keeps the
  // device plugin's own rule, 5 tries per code lifetime, which the catch-all leaves in place.
  "/passkey-signup/verify": { window: 300, max: 10 },
  "/delete-user/callback": { window: 300, max: 5 },
  // Social and SSO callbacks and SAML endpoints: one-time state or code in the query, and redirects.
  "/callback/*": { window: 60, max: 20 },
  "/sso/callback": { window: 60, max: 20 },
  "/sso/callback/*": { window: 60, max: 20 },
  "/sso/saml2/sp/acs/*": { window: 60, max: 20 },
  "/sso/saml2/sp/slo/*": { window: 60, max: 20 },
} satisfies Record<string, RateRule>

/**
 * Every path, as better-auth's wildcard key. better-auth takes the first key that matches in insertion
 * order, so this is listed after all the exact keys and only catches what they do not.
 */
export const CATCH_ALL_PATH = "/**"

/**
 * Read-only GETs (session reads, listings, discovery) are not limited: a counted GET writes a
 * `rateLimit` row, which would put a database write on every page load. The catch-all exempts a GET
 * only when better-auth's resolved rule is still the global default. A special or plugin rule for a
 * GET (for example /sign-in* or /device) is kept, so it still limits. Other methods keep the rule
 * resolved. Tokens and codes in a GET's query are in STRICT_RULES, not here.
 */
export const unlimitedReads =
  (window: number, max: number) =>
  (req: Request, rule: RateRule): false | RateRule =>
    req.method === "GET" && rule.window === window && rule.max === max ? false : rule

type RateLimitConfig = NonNullable<BetterAuthOptions["rateLimit"]>

/**
 * better-auth's `rateLimit` option. `false` turns the limiter off. Otherwise it is on, stored in the
 * `rateLimit` table (storage "database"), so every instance shares the counts.
 */
export function authRateLimit(opts?: false | AuthRateLimitOptions): RateLimitConfig {
  if (opts === false) return { enabled: false }
  const window = opts?.window ?? GLOBAL_RATE_LIMIT.window
  const max = opts?.max ?? GLOBAL_RATE_LIMIT.max
  return {
    enabled: true,
    storage: "database",
    window,
    max,
    // Exact and wildcard keys come first, then the catch-all. better-auth's own default for every
    // /sign-in* path (3 per 10s) would otherwise limit the sign-in page's read, so it is exempt here.
    customRules: {
      ...STRICT_RULES,
      "/sign-in-methods": false,
      ...opts?.rules,
      [CATCH_ALL_PATH]: unlimitedReads(window, max),
    },
  }
}
