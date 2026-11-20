import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { serve } from "@hono/node-server"
import { createAuth, parseStripePlans } from "@proof/auth"
import { createDb } from "@proof/db"
import { env } from "@proof/env"
import { reportError, setErrorReporter } from "@proof/errors"
import { createLogger } from "@proof/logger"
import { parseStatusProviders } from "@proof/observability"
import { createFileStore, type FileStore } from "@proof/storage"

import { analyticsFromEnv, captureAuthEvent, captureSignUp } from "./analytics"
import { createApp } from "./app"
import { recordAuthEvent } from "./data/audit"
import { createDevMailSink } from "./dev-mail"
import { fileSweep } from "./file-sweep"
import { createFlagService } from "./flags"
import { createApiHooks } from "./hooks"
import { createMeter } from "./meter"
import { createApiNotifier } from "./notifications"
import { createOperations } from "./operations"
import { PRODUCT } from "./product"
import { startSupportSweep } from "./support-sweep"

const logger = createLogger({ name: "api" })
// The agent skill (skills/proof), served at /skill.md. Read from the repo (or the image) at boot, so a
// missing file stops startup instead of serving nothing.
const skill = readFileSync(
  fileURLToPath(new URL("../../../skills/proof/SKILL.md", import.meta.url)),
  "utf8",
)
// Every reported error (5xx and unexposed ones, from REST, MCP tools, the hooks and analytics) is
// logged here, once. To add an error tracker (Sentry and the like), call it here too and keep the log.
setErrorReporter((error, context) => {
  logger.error({ err: error, ...context }, error.message)
})
// Under `pnpm dev`, portless serves the app at PORTLESS_URL; OAuth issuer and docs links must match it.
const baseURL = (env.PORTLESS_URL ?? env.BETTER_AUTH_URL).replace(/\/$/, "")

const db = createDb(env.DATABASE_URL)
// Product analytics (docs/analytics.md): operation calls, auth events and the web app's page views.
const analytics = analyticsFromEnv(env, logger)
// Dev and e2e only (env refuses it in production): auth emails are kept in memory for GET /api/dev/mail.
const devMail = env.DEV_MAIL_SINK ? createDevMailSink() : undefined
if (devMail) logger.warn("DEV_MAIL_SINK is on: auth emails are not sent, they are kept in memory")
// Support (docs/support.md): the operator organization's members are its staff. Thread mail goes
// the auth emails' way (the dev sink under DEV_MAIL_SINK); inbound mail is Wraps'.
const supportEmail = env.SUPPORT_REPLY_DOMAIN
  ? {
      from: env.SUPPORT_EMAIL_FROM ?? env.EMAIL_FROM,
      replyDomain: env.SUPPORT_REPLY_DOMAIN,
      // The web app's origin: apps/api serves it in production; pnpm dev and e2e run it elsewhere.
      appUrl: env.WEB_ORIGINS[0] ?? baseURL,
      replyDelay: env.SUPPORT_REPLY_DELAY_MS,
    }
  : undefined
// Where uploads go (docs/storage.md). @proof/env has checked the chosen driver's variables are set.
function fileStore(): FileStore | undefined {
  switch (env.STORAGE_DRIVER) {
    case undefined:
      return undefined
    case "local":
      if (env.NODE_ENV === "production") {
        logger.warn("STORAGE_DRIVER=local in production: uploads live on this server's disk only")
      }
      return createFileStore({
        driver: "local",
        dir: env.STORAGE_LOCAL_DIR,
        publicUrl: env.STORAGE_PUBLIC_URL ?? `${baseURL}/files`,
      })
    case "s3":
      return createFileStore({
        driver: "s3",
        bucket: env.STORAGE_BUCKET ?? "",
        region: env.S3_REGION ?? "",
        accessKeyId: env.S3_ACCESS_KEY_ID ?? "",
        secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? "",
        sessionToken: env.S3_SESSION_TOKEN,
        endpoint: env.S3_ENDPOINT,
        publicUrl: env.STORAGE_PUBLIC_URL,
      })
    case "r2":
      return createFileStore({
        driver: "r2",
        accountId: env.R2_ACCOUNT_ID ?? "",
        bucket: env.STORAGE_BUCKET ?? "",
        accessKeyId: env.R2_ACCESS_KEY_ID ?? "",
        secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? "",
        publicUrl: env.STORAGE_PUBLIC_URL ?? "",
      })
    case "vercel-blob":
      return createFileStore({ driver: "vercel-blob", token: env.BLOB_READ_WRITE_TOKEN ?? "" })
  }
}
// Built before auth: deleting an organization or person sweeps their files (file-sweep.ts).
const files = fileStore()

const auth = createAuth({
  db,
  secret: env.BETTER_AUTH_SECRET,
  baseURL,
  emailFrom: env.EMAIL_FROM,
  wrapsApiKey: env.WRAPS_API_KEY,
  // The web app's origins when it is not this one (pnpm dev, e2e). Empty when apps/api serves it.
  webOrigins: env.WEB_ORIGINS,
  ses: devMail ? { client: devMail.client } : undefined,
  // Stripe runs only in test mode, and only with both keys (createAuth refuses a live key).
  stripe:
    env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET
      ? {
          secretKey: env.STRIPE_SECRET_KEY,
          webhookSecret: env.STRIPE_WEBHOOK_SECRET,
          plans: parseStripePlans(env.STRIPE_PLANS),
        }
      : undefined,
  oauthResources: [baseURL, `${baseURL}/mcp`],
  github:
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
      : undefined,
  google:
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
      : undefined,
  passwordBreachCheck: true,
  // Rate limits on sign-in, mail and one-time codes, by client IP (rate-limit.ts). e2e turns them off.
  rateLimit: env.AUTH_RATE_LIMIT === "on" ? {} : false,
  // Auth activity (sign-in, failed sign-in, sign-out, ...) lands in the audit trail (auth-events.ts).
  onAuthEvent: async (event) => {
    captureAuthEvent(analytics, event)
    await recordAuthEvent(db, event)
  },
  // A notification that could not be recorded never fails the request; it is reported here.
  onNotificationError: (error, type) => reportError(error, { notification: type }),
  onSignUp: (event) => captureSignUp(analytics, event),
  // Once an organization or person is deleted, their files go too (docs/storage.md).
  onDeleted: fileSweep(files, logger),
  // Plan entitlements (packages/auth/src/entitlements.ts): the operator organization's members
  // manage overrides; unclaimed organizations get the lower daily request limit.
  entitlements: {
    staffOrganizationId: env.OPERATOR_ORGANIZATION_ID,
    unclaimedRequestLimit: env.UNCLAIMED_ORG_DAILY_REQUEST_LIMIT,
  },
  support: {
    staffOrganizationId: env.OPERATOR_ORGANIZATION_ID,
    email: supportEmail,
    // @proof/env has checked each source comes with the reply domain, and only one is set.
    inbound: env.SUPPORT_INBOUND_SECRET
      ? { secret: env.SUPPORT_INBOUND_SECRET }
      : env.WRAPS_INBOUND_KEY && env.WRAPS_INBOUND_BUCKET
        ? {
            key: env.WRAPS_INBOUND_KEY,
            bucket: env.WRAPS_INBOUND_BUCKET,
            region: env.WRAPS_INBOUND_REGION,
          }
        : undefined,
  },
})
// Every BYO plugin's sweep (@byo-oss/core sweepAll), every minute: support's delayed reply mail,
// retries and closing solved tickets, and the notification emails that are delayed or retried.
const supportSweep = startSupportSweep(auth, { logger, intervalMs: env.SUPPORT_SWEEP_INTERVAL_MS })

// The daily request limit is the plan's (@proof/plans), through entitlements; unclaimed
// organizations get UNCLAIMED_ORG_DAILY_REQUEST_LIMIT (createAuth's `entitlements` option).
const meter = createMeter({ db, entitlements: auth.entitlements })

// One notifier for operations and the invoke hooks (usage.limit_reached).
const notifier = createApiNotifier({ auth, db })

// Feature flags (docs/feature-flags.md): one evaluator for OFREP and the operations, and the
// organization that manages the rollouts. Unset, nobody can change a rollout.
const flags = createFlagService({ db })
const operator = { organizationId: env.OPERATOR_ORGANIZATION_ID }
if (!operator.organizationId)
  logger.info(
    "OPERATOR_ORGANIZATION_ID is unset: flag rollouts are read-only, support has no agents",
  )

const app = createApp({
  devMail,
  auth,
  operations: createOperations({ auth, db, meter, notifier, files, operator, flags }),
  baseURL,
  name: PRODUCT.name,
  version: PRODUCT.version,
  description: PRODUCT.description,
  logger,
  hooks: createApiHooks({
    db,
    meter,
    secret: env.BETTER_AUTH_SECRET,
    notifier,
    operator,
    analytics,
  }),
  flags,
  analytics,
  trustProxy: env.TRUST_PROXY,
  webDistDir: env.WEB_DIST_DIR,
  skill,
  files,
  // Social sign-in fills user.image with the provider's avatar URL; pages show it.
  imageOrigins: [
    ...(env.GITHUB_CLIENT_ID ? ["https://avatars.githubusercontent.com"] : []),
    ...(env.GOOGLE_CLIENT_ID ? ["https://lh3.googleusercontent.com"] : []),
  ],
  // Parsed here so a malformed list stops startup instead of showing nothing.
  ...(env.STATUS_PROVIDERS && {
    status: { providers: parseStatusProviders(env.STATUS_PROVIDERS) },
  }),
  // The MCP registry entry (/.well-known/mcp/server.json), from product.ts.
  registry: PRODUCT.registry,
})

const port = env.PORT ?? (Number(new URL(baseURL).port) || 3000)
serve({ fetch: app.fetch, port }, (addr) => logger.info({ port: addr.port }, "api listening"))

// Before the process goes (a deploy's SIGTERM, or Ctrl-C): write the flag exposures counted since
// the last flush, send the analytics still queued, and let a notification or support sweep in flight
// finish.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void Promise.allSettled([flags.close(), analytics.shutdown(), supportSweep.stop()]).finally(
      () => process.exit(0),
    )
  })
}
