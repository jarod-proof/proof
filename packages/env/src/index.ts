import { createEnv } from "@t3-oss/env-core"
import { z } from "zod"

/** One origin in a list: http(s), a host, optional port, and no path, query or credentials. */
function isBareHttpOrigin(value: string): boolean {
  const trimmed = value.trim()
  try {
    const url = new URL(trimmed)
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      (url.pathname === "/" || url.pathname === "") &&
      url.search === "" &&
      url.hash === "" &&
      !trimmed.endsWith("/")
    )
  } catch {
    return false
  }
}

/**
 * Single source of truth for environment variables. Keep `.env.example` in sync.
 * Validation runs on first import; set SKIP_ENV_VALIDATION=1 (or true) for builds/tests that don't need it.
 */
export const env = createEnv({
  server: {
    DATABASE_URL: z.url(),
    /**
     * apps/hq (the org brain) only: its own database, which also takes starter's migrations (auth
     * tables); its own tables live in the `hq` schema. apps/hq refuses to start without it.
     */
    HQ_DATABASE_URL: z.url().optional(),
    /** apps/hq only: its public base URL (OAuth issuer, docs links). Unset, http://127.0.0.1:<port>. */
    HQ_BASE_URL: z.url().optional(),
    /**
     * apps/hq only: the founders, who alone decide proposals, edit entries and click Approve in
     * Slack. Comma-separated `<email>=<slack user id>` pairs (an email counts once its account has
     * verified the address; `id:<user id>=<slack user id>` names a user by id). hq writes them to
     * its `founders` table at boot and removes any row not listed, so this is the only way a
     * founder is added or removed; empty, nobody is a founder. Nothing in the API writes it.
     */
    HQ_FOUNDERS: z.string().optional(),
    /** apps/hq only: the Slack workspace (team id) whose clicks hq accepts. Unset, hq refuses every click. */
    HQ_SLACK_TEAM_ID: z.string().min(1).optional(),
    /**
     * apps/hq only: the most, in dollars, that Slack grant clicks may add to the allowance in one
     * UTC day, in total (a click that would pass it is refused and grants nothing). Unset, $50.
     * grant_spend by a signed-in founder is outside it.
     */
    HQ_SLACK_DAILY_GRANT_CAP_USD: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.coerce.number().positive().max(1000).optional(),
    ),
    /** The Slack app's signing secret: hq verifies the forwarded click over the exact bytes (apps/hq, apps/agent). */
    SLACK_SIGNING_SECRET: z.string().min(1).optional(),
    /**
     * apps/hq only: whether anyone may create an account on hq. Off by default: hq's people are the
     * founders, so a stranger cannot self-register. For the e2e and test stacks only (NODE_ENV
     * development or test, which seed their founder by signing up): a deployed hq refuses to boot
     * with it on, and makes its founders with `create-founder` on the server instead.
     */
    HQ_ALLOW_SIGNUP: z.stringbool().default(false),
    /**
     * Tests only (apps/hq's real-Postgres spend race, apps/hq/src/data/spend.test.ts, which reads
     * it directly): a database named `*_test` it may write to. Nothing in the app reads it.
     */
    HQ_TEST_DATABASE_URL: z.url().optional(),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    EMAIL_FROM: z.string().min(1),
    WRAPS_API_KEY: z.string().min(1).optional(),
    /** GitHub OAuth app. The "Continue with GitHub" option appears only when both are set. */
    GITHUB_CLIENT_ID: z.string().min(1).optional(),
    GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
    /** Google OAuth client. The "Continue with Google" option appears only when both are set. */
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    PORT: z.coerce.number().int().positive().optional(),
    /** Set by portless under `pnpm dev`: the app's https://<name>.localhost URL. */
    PORTLESS_URL: z.url().optional(),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
    // The claimed daily request limit is the plan's (`requests` in packages/plans/src/catalog.ts).
    /** Requests per organization per UTC day while the owner's email is unverified (provisional signups). */
    UNCLAIMED_ORG_DAILY_REQUEST_LIMIT: z.coerce.number().int().positive().default(500),
    /** Trust X-Forwarded-For for the client IP (signup limits). Only when a proxy overwrites that header. */
    TRUST_PROXY: z.stringbool().default(false),
    /**
     * Vendors whose own status pages `GET /status` reports (never pinged by /health). Comma-separated
     * `Name=https://status.example.com` (a Statuspage), `Name=statusio:<page id>` (status.io), or
     * `aws`, `aws@<region>`, `aws:<service>@<region>` (AWS Health). Unset: the broad default below,
     * to narrow to what the app actually uses.
     */
    STATUS_PROVIDERS: z
      .string()
      .min(1)
      .default(
        "aws,Cloudflare=https://www.cloudflarestatus.com,Vercel=https://www.vercel-status.com," +
          "Neon=statusio:6878fc85709daa75be6c7e3c,PlanetScale=https://www.planetscalestatus.com",
      ),
    /** Directory of the built web app (apps/app/dist). When set, apps/api serves its pages and assets. */
    WEB_DIST_DIR: z.string().min(1).optional(),
    /**
     * Origins the web app runs on when it is not apps/api's own origin (`pnpm dev`, or a separate vite
     * server). Comma-separated bare origins, e.g. `https://app.proof.localhost` under pnpm dev. Trusted for auth callbacks and
     * passkeys, nothing else. Leave empty in production, where apps/api serves the web app itself.
     */
    WEB_ORIGINS: z
      .string()
      .min(1)
      .optional()
      .refine((value) => value === undefined || value.split(",").every(isBareHttpOrigin), {
        message: "WEB_ORIGINS must be comma-separated http(s) origins, e.g. http://127.0.0.1:5173",
      })
      .transform((value) =>
        value === undefined ? [] : value.split(",").map((origin) => new URL(origin.trim()).origin),
      ),
    /** Dev only: the API that apps/app's vite dev server proxies /api, /v1, /mcp and /.well-known to. */
    API_URL: z.url().optional(),
    /**
     * Build only (apps/site): the marketing site's public origin, for canonical URLs and the RSS
     * feeds. Read by apps/site/astro.config.ts. Unset, http://localhost:4321.
     */
    SITE_URL: z.url().optional(),
    /**
     * Build only (apps/site): the web app the marketing site's "Sign in" and "Start free" link to.
     * Read by apps/site/astro.config.ts. Unset, the app under portless, else http://localhost:3000.
     */
    APP_URL: z.url().optional(),
    /** e2e only: the model credential the e2e tester (`pnpm e2e`) uses for its agent steps. */
    AI_GATEWAY_API_KEY: z.string().min(1).optional(),
    NODE_ENV: z.enum(["development", "test", "production"]).optional(),
    /**
     * Dev and e2e only: keep auth emails in memory instead of sending them, readable at
     * GET /api/dev/mail. Only with NODE_ENV development or test (checked below).
     */
    DEV_MAIL_SINK: z.stringbool().optional(),
    /**
     * Auth rate limits (sign-in, mail, one-time codes), by client IP. "off" is for dev and e2e only:
     * it is refused unless NODE_ENV is development or test (checked below), like DEV_MAIL_SINK.
     */
    AUTH_RATE_LIMIT: z.enum(["on", "off"]).default("on"),
    /** Stripe, test mode only: the key must be an sk_test_ key (checked below, with a clear message). */
    STRIPE_SECRET_KEY: z.string().min(1).optional(),
    /** The signing secret of the Stripe webhook endpoint (whsec_...). Needed with STRIPE_SECRET_KEY. */
    STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
    /**
     * The plans billing offers, as JSON: `[{"name":"pro","priceId":"price_..."}]`. Price ids come from
     * your Stripe test dashboard; none are made up here. Unset, no plans are offered.
     */
    STRIPE_PLANS: z.string().min(1).optional(),
    /**
     * The organization that runs the product (docs/feature-flags.md): only its members, keys and
     * agents may change feature flag rollouts. Unset, flags serve their rollouts but nobody can
     * change one.
     */
    OPERATOR_ORGANIZATION_ID: z.string().min(1).optional(),
    /**
     * Support thread mail (docs/support.md): agent replies are mailed to the requester with
     * Reply-To support+<token>@<this domain>. A domain, not an address. Unset, nothing is mailed.
     */
    SUPPORT_REPLY_DOMAIN: z
      .string()
      .min(1)
      .refine((value) => !value.includes("@"), {
        message: "SUPPORT_REPLY_DOMAIN is a domain, not an address, e.g. support.example.com",
      })
      .optional(),
    /** The sender of support mail, verified in SES. Unset, EMAIL_FROM. */
    SUPPORT_EMAIL_FROM: z.string().min(1).optional(),
    /**
     * How long after an agent's reply it is mailed, in ms; skipped if the requester saw it first.
     * Unset, support's default (2 minutes). The e2e stack sets 0.
     */
    SUPPORT_REPLY_DELAY_MS: z.coerce.number().int().nonnegative().optional(),
    /**
     * How often the API runs support's sweep (delayed and retried reply mail, closing solved
     * tickets), in ms. Default a minute. The e2e stack sweeps every second.
     */
    SUPPORT_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).default(60_000),
    /**
     * Inbound support mail from any relay that POSTs the raw message (message/rfc822) to
     * /api/auth/support/inbound with `Authorization: Bearer <this secret>`: Postmark, Mailgun, a
     * Cloudflare Email Worker (support's rawRelay). Needs SUPPORT_REPLY_DOMAIN. One inbound source:
     * not with WRAPS_INBOUND_KEY.
     */
    SUPPORT_INBOUND_SECRET: z
      .string()
      .min(16)
      // The relay sends it as `Bearer <secret>`, which support reads up to the first space.
      .regex(/^\S+$/, { message: "SUPPORT_INBOUND_SECRET can't contain spaces" })
      .optional(),
    /**
     * Wraps inbound mail for support: the X-Wraps-Inbound-Key the Wraps EventBridge destination
     * sends to /api/auth/support/inbound (`wraps email inbound status --reveal-secret`). With
     * WRAPS_INBOUND_BUCKET and SUPPORT_REPLY_DOMAIN. Unset, inbound mail is off.
     */
    WRAPS_INBOUND_KEY: z.string().min(1).optional(),
    /** The S3 bucket Wraps stores inbound raw mail in (`wraps email inbound status`). */
    WRAPS_INBOUND_BUCKET: z.string().min(1).optional(),
    /**
     * The region of that bucket. The raw mail is read with the AWS SDK's default credential chain
     * (the one SES sends with), which needs s3:GetObject and s3:ListBucket on the bucket.
     */
    WRAPS_INBOUND_REGION: z.string().min(1).default("us-east-1"),
    /**
     * The file store uploads (avatars, organization logos) go to: `local` (a directory this API
     * serves at /files), `s3`, `r2` (Cloudflare) or `vercel-blob`. Unset, uploads are off. Each one's
     * variables are below; the check after createEnv names any that are missing (docs/storage.md).
     */
    STORAGE_DRIVER: z.enum(["local", "s3", "r2", "vercel-blob"]).optional(),
    /** s3 and r2: the bucket. */
    STORAGE_BUCKET: z.string().min(1).optional(),
    /**
     * Where the stored files are read from: a CDN or custom domain in front of the bucket. Required for
     * r2 (its r2.dev URL or a custom domain). s3 defaults to the bucket's own URL, local to <API>/files.
     */
    STORAGE_PUBLIC_URL: z.url().optional(),
    /** local: the directory files are written to, relative to the API's working directory. */
    STORAGE_LOCAL_DIR: z.string().min(1).default(".storage"),
    S3_REGION: z.string().min(1).optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    /** Only with temporary credentials (an assumed role). */
    S3_SESSION_TOKEN: z.string().min(1).optional(),
    /** An S3-compatible endpoint instead of AWS (MinIO, LocalStack), addressed path-style. */
    S3_ENDPOINT: z.url().optional(),
    /** The Cloudflare account id (dashboard sidebar, or R2 > Overview). */
    R2_ACCOUNT_ID: z.string().min(1).optional(),
    /** An R2 API token's S3 credentials (R2 > Manage API tokens), with Object Read & Write. */
    R2_ACCESS_KEY_ID: z.string().min(1).optional(),
    R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    /** vercel-blob: the store's read-write token. Vercel sets it when the store is connected. */
    BLOB_READ_WRITE_TOKEN: z.string().min(1).optional(),
    /**
     * Where product analytics go: `log` (the API's log), `posthog`, or `none`. Unset, it is `log`
     * when NODE_ENV is development and `none` otherwise (docs/analytics.md).
     */
    ANALYTICS_PROVIDER: z.enum(["none", "log", "posthog"]).optional(),
    /** posthog: the project API key (`phc_...`). */
    POSTHOG_API_KEY: z.string().min(1).optional(),
    /** posthog: the ingestion host. Default https://us.i.posthog.com; EU is https://eu.i.posthog.com. */
    POSTHOG_HOST: z.url().optional(),
  },
  runtimeEnv: process.env,
  // Only an explicit yes: "false" or "0" must not turn validation off.
  skipValidation: ["1", "true"].includes(String(process.env.SKIP_ENV_VALIDATION).toLowerCase()),
  emptyStringAsUndefined: true,
})

// A mail sink holds real addresses and tokens in memory, so it runs only where NODE_ENV says it is
// development or test. Anything else (production, or unset) is refused: failing open would leak mail.
if (env.DEV_MAIL_SINK && env.NODE_ENV !== "development" && env.NODE_ENV !== "test") {
  throw new Error(
    "DEV_MAIL_SINK is for development and e2e only. Set NODE_ENV to development or test, or unset DEV_MAIL_SINK.",
  )
}

// Turning the auth rate limits off is only for dev and e2e, where a suite signs in more than the limit
// allows. Anything else (production, or NODE_ENV unset) keeps them on: failing open would drop the limits.
if (env.AUTH_RATE_LIMIT === "off" && env.NODE_ENV !== "development" && env.NODE_ENV !== "test") {
  throw new Error(
    "AUTH_RATE_LIMIT=off is for development and e2e only. Set NODE_ENV to development or test, or unset AUTH_RATE_LIMIT.",
  )
}

// Billing runs in Stripe test mode only: a live key is refused here, before anything is charged.
if (env.STRIPE_SECRET_KEY && !env.STRIPE_SECRET_KEY.startsWith("sk_test_")) {
  throw new Error(
    "STRIPE_SECRET_KEY must be a Stripe test-mode key (sk_test_...). Live keys are refused by this app.",
  )
}

/** What each file store needs, besides STORAGE_DRIVER itself. */
const STORAGE_NEEDS = {
  local: [],
  s3: ["STORAGE_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"],
  r2: [
    "STORAGE_BUCKET",
    "STORAGE_PUBLIC_URL",
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ],
  "vercel-blob": ["BLOB_READ_WRITE_TOKEN"],
} as const satisfies Record<NonNullable<typeof env.STORAGE_DRIVER>, readonly (keyof typeof env)[]>

// A file store with half its settings would fail on the first upload; say what is missing at startup.
if (env.STORAGE_DRIVER) {
  const missing = STORAGE_NEEDS[env.STORAGE_DRIVER].filter((name) => env[name] === undefined)
  if (missing.length > 0) {
    throw new Error(
      `STORAGE_DRIVER=${env.STORAGE_DRIVER} needs ${missing.join(", ")}. Set them, or unset STORAGE_DRIVER to turn uploads off (docs/storage.md).`,
    )
  }
}

// Inbound support mail needs the key, the bucket and the reply domain it threads replies on; a
// partial setup would drop every message, so say what is missing at startup. A relay's secret is
// the other inbound source: one or the other.
if (env.SUPPORT_INBOUND_SECRET !== undefined) {
  if (env.WRAPS_INBOUND_KEY !== undefined || env.WRAPS_INBOUND_BUCKET !== undefined) {
    throw new Error(
      "Inbound support mail takes one source: SUPPORT_INBOUND_SECRET (a relay) or WRAPS_INBOUND_KEY and WRAPS_INBOUND_BUCKET (Wraps), not both (docs/support.md).",
    )
  }
  if (env.SUPPORT_REPLY_DOMAIN === undefined) {
    throw new Error(
      "Inbound support mail needs SUPPORT_REPLY_DOMAIN. Set it, or unset SUPPORT_INBOUND_SECRET to turn it off (docs/support.md).",
    )
  }
}
if (env.WRAPS_INBOUND_KEY !== undefined || env.WRAPS_INBOUND_BUCKET !== undefined) {
  const missing = (
    ["WRAPS_INBOUND_KEY", "WRAPS_INBOUND_BUCKET", "SUPPORT_REPLY_DOMAIN"] as const
  ).filter((name) => env[name] === undefined)
  if (missing.length > 0) {
    throw new Error(
      `Inbound support mail needs ${missing.join(", ")}. Set them, or unset WRAPS_INBOUND_KEY and WRAPS_INBOUND_BUCKET to turn it off (docs/support.md).`,
    )
  }
}

// Like the file store: a provider without its key would drop every event; say so at startup.
if (env.ANALYTICS_PROVIDER === "posthog" && env.POSTHOG_API_KEY === undefined) {
  throw new Error(
    "ANALYTICS_PROVIDER=posthog needs POSTHOG_API_KEY. Set it, or unset ANALYTICS_PROVIDER to turn analytics off (docs/analytics.md).",
  )
}
