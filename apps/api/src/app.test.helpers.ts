// Test-only: the real app on in-process Postgres (PGlite) with two organizations:
//   - "acme": owner (session), a viewer member (session), a full key and a read-only key; on the
//     Team plan unless a test says otherwise (`plan`)
//   - "other": a separate user's personal org, for cross-tenant checks
// acme is the operator organization (feature flag rollouts) unless a test says otherwise.
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { Analytics } from "@proof/analytics"
import type { AnyOperation } from "@proof/api"
import {
  type AuthEvent,
  type AuthOptions,
  type AuthRateLimitOptions,
  createAuth,
} from "@proof/auth"
import { createTestDb } from "@proof/db/testing"
import { memorySource } from "@proof/auth/testing"
import type { PlanId } from "@proof/plans"
import type { FlagCatalog } from "@proof/flags"
import { createLogger, type Logger } from "@proof/logger"
import { createMemoryStore, type FileStore } from "@proof/storage"
import { captureSignUp } from "./analytics"
import { type AppOptions, createApp } from "./app"
import { recordAuthEvent } from "./data/audit"
import { createDevMailSink } from "./dev-mail"
import { fileSweep } from "./file-sweep"
import { createFlagService } from "./flags"
import { createApiHooks } from "./hooks"
import { createMeter } from "./meter"
import { type ApiNotifier, createApiNotifier } from "./notifications"
import { createOperations } from "./operations"
import type { Operator } from "./tenant"

export const BASE = "http://localhost:3000"

/** The REST request for an operation's input: path params in the path, the rest as query or body. */
export function requestFor(op: AnyOperation, input: Record<string, unknown>) {
  let path = op.path
  const rest = { ...input }
  for (const [k, v] of Object.entries(input)) {
    if (path.includes(`:${k}`)) {
      path = path.replace(`:${k}`, encodeURIComponent(String(v)))
      delete rest[k]
    }
  }
  if (op.method === "GET" || op.method === "DELETE") {
    const qs = new URLSearchParams(Object.entries(rest).map(([k, v]) => [k, String(v)])).toString()
    return { path: qs ? `${path}?${qs}` : path, init: { method: op.method } }
  }
  return { path, init: { method: op.method, body: JSON.stringify(rest) } }
}
/** The test server secret: better-auth's, and the one idempotency records are sealed with. */
export const SECRET = "a-test-secret-that-is-long-enough-123456" // gitleaks:allow

/** An auth email the app sent, as the fake SES client received it. */
export interface SentEmail {
  to: string
  subject: string
  /** The first link to the app in the email (verification, reset), or "" when it has none. */
  link: string
  /** The first Reply-To address (support's support+<token>@...), when the email has one. */
  replyTo?: string
}

export interface TestAppOptions {
  /**
   * Daily request limits. Test users are unverified, so `unclaimed` is the one that applies (the
   * claimed one is the plan's, from the catalog).
   */
  limits?: { unclaimed?: number }
  /**
   * acme's plan. Default `team`, so suites can add members and agents freely; the entitlements
   * tests pass `free` to meet Free's limits. Every other organization is on Free.
   */
  plan?: PlanId
  /** Entitlements' staff organization (overrides). Unset, nobody can set an override. */
  staffOrganizationId?: string
  /** Trust X-Forwarded-For (as behind a proxy), for signup rate-limit tests. */
  trustProxy?: boolean
  /** A built web app to serve (see static.test.ts). */
  webDistDir?: string
  /** The agent skill text, served at /skill.md (the route is absent without it). */
  skill?: string
  /** Defaults to a silent logger; pass one with a destination to read the access log. */
  logger?: Logger
  /** Serve GET /status for these vendors (see app.ts). */
  status?: AppOptions["status"]
  /** The clock the run operations read (approval windows). Defaults to the real one. */
  now?: () => Date
  /** Check passwords against Have I Been Pwned. Off here (no network); auth-flows fakes the service. */
  breachCheck?: boolean
  /** Web origins other than BASE (the dev and e2e setup, WEB_ORIGINS): trusted for auth callbacks. */
  webOrigins?: string[]
  /** GitHub and Google sign-in, when a test wants those buttons. */
  github?: { clientId: string; clientSecret: string }
  google?: { clientId: string; clientSecret: string }
  /** Mount GET /api/dev/mail, with auth emails going to the dev mail sink instead of the fake SES. */
  devMail?: boolean
  /** The notifier the operations and hooks send through. Defaults to the real one; tests pass a failing one. */
  notifier?: ApiNotifier
  /** Where operation calls and web app events go (createAnalytics with a memory provider). */
  analytics?: Analytics
  /** Stripe test mode, with these plans (see auth's stripe option). Unset, billing is not mounted. */
  stripe?: { secretKey: string; webhookSecret: string; plans?: { name: string; priceId: string }[] }
  /** Auth rate limits. Off unless a test opts in (auth-flows: the limiter test), so flows don't 429. */
  rateLimit?: false | AuthRateLimitOptions
  /** Where auth events go. Defaults to the audit trail, as server.ts wires it. */
  onAuthEvent?: (event: AuthEvent) => void | Promise<void>
  /** The file store uploads go to. Defaults to one in memory served at BASE/files; false turns uploads off. */
  files?: FileStore | false
  /** Make acme the operator organization (the default), or leave the operator unset (false). */
  operator?: boolean
  /** The flags the app declares. Defaults to the product's catalog (packages/flags). */
  flagCatalog?: FlagCatalog
  /** Fetch for Client ID Metadata Documents. Defaults to the SSRF-safe transport; tests stub it. */
  clientMetadataFetch?: AuthOptions["clientMetadataFetch"]
  /** Support's staff organization, thread mail and inbound mail. Unset, nobody is an agent. */
  support?: AuthOptions["support"]
}

export async function createTestApp(
  extra: readonly AnyOperation[] = [],
  options: TestAppOptions = {},
) {
  const t = await createTestDb()
  // Stands in for SES. Reads the request loosely, so a change in how WrapsEmail shapes it doesn't
  // matter: only who it's for, the subject and the link.
  const outbox: SentEmail[] = []
  const ses = {
    send: async (command: { input: unknown }) => {
      const raw = JSON.stringify(command.input)
      const input = command.input as {
        Destination?: { ToAddresses?: string[] }
        ReplyToAddresses?: string[]
      }
      const subject = /"Subject":\{"Data":"([^"]*)"/.exec(raw)?.[1] ?? ""
      // The first link back to this app, so a logo or doctype URL in a template doesn't count.
      const links = raw.match(/https?:\/\/[^"\s<>\\]+/g) ?? []
      const link = (links.find((l) => l.startsWith(BASE)) ?? "").replaceAll("&amp;", "&")
      const replyTo = input.ReplyToAddresses?.[0]
      outbox.push({
        to: input.Destination?.ToAddresses?.[0] ?? "",
        subject,
        link,
        ...(replyTo && { replyTo }),
      })
      return { MessageId: `test-${outbox.length}`, $metadata: { requestId: "test" } }
    },
  }
  const devMail = options.devMail ? createDevMailSink() : undefined
  const { analytics } = options
  const logger = options.logger ?? createLogger({ level: "silent" })
  const plans = memorySource()
  // Built before auth, as in server.ts: deletions sweep their files through fileSweep.
  const files =
    options.files === false
      ? undefined
      : (options.files ?? createMemoryStore({ driver: "memory", publicUrl: `${BASE}/files` }))
  const auth = createAuth({
    db: t.db,
    secret: SECRET,
    baseURL: BASE,
    emailFrom: "Test <auth@example.com>",
    oauthResources: [BASE, `${BASE}/mcp`],
    clientMetadataFetch: options.clientMetadataFetch,
    ses: { client: devMail?.client ?? ses },
    stripe: options.stripe,
    // Senders swallow failures; a test must not pass because an email silently failed.
    onEmailError: (error) => {
      throw error
    },
    passwordBreachCheck: options.breachCheck ?? false,
    webOrigins: options.webOrigins,
    github: options.github,
    google: options.google,
    rateLimit: options.rateLimit ?? false,
    support: options.support,
    // Every organization is on Free until a test puts it on a plan (`onPlan`). With Stripe plans,
    // the stripe plugin's subscriptions are the source instead, as in production.
    entitlements: {
      source: options.stripe?.plans?.length ? undefined : plans,
      unclaimedRequestLimit: options.limits?.unclaimed ?? 500,
      staffOrganizationId: options.staffOrganizationId,
    },
    onSignUp: analytics && ((event) => captureSignUp(analytics, event)),
    onDeleted: fileSweep(files, logger),
    onAuthEvent:
      options.onAuthEvent ??
      (async (event) => {
        await recordAuthEvent(t.db, event)
      }),
  })
  const meter = createMeter({ db: t.db, entitlements: auth.entitlements })
  const notifier = options.notifier ?? createApiNotifier({ auth, db: t.db })
  // Named once acme exists, below: the operations read it at call time.
  const operator: Operator = { organizationId: undefined }
  const flags = createFlagService({
    db: t.db,
    catalog: options.flagCatalog,
    now: options.now,
    autoFlush: false,
  })
  const operations = [
    ...createOperations({
      auth,
      db: t.db,
      meter,
      now: options.now,
      notifier,
      files,
      operator,
      flags,
    }),
    ...extra,
  ]
  const app = createApp({
    hooks: createApiHooks({ db: t.db, meter, secret: SECRET, notifier, operator, analytics }),
    flags,
    analytics,
    trustProxy: options.trustProxy ?? false,
    webDistDir: options.webDistDir,
    skill: options.skill,
    status: options.status,
    devMail,
    auth,
    operations,
    files,
    baseURL: BASE,
    name: "Test API",
    version: "1.0.0",
    description: "A test API.",
    logger,
  })
  const req = (path: string, init: RequestInit = {}) => app.request(`${BASE}${path}`, init)

  let n = 0
  async function signUp(name: string) {
    n++
    const email = `user${n}@example.com`
    const res = await auth.api.signUpEmail({
      body: { email, password: "correct-horse-battery", name },
      returnHeaders: true,
    })
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
    const orgId = session?.session.activeOrganizationId
    if (!orgId) throw new Error("signup did not activate a personal organization")
    return { userId: res.response.user.id, email, cookie, orgId }
  }

  const owner = await signUp("Owner")
  // (With Stripe plans acme is on Free unless a test seeds a subscription for it.)
  await plans.set(owner.orgId, { planKey: options.plan ?? "team", status: "active" })
  if (options.operator !== false) operator.organizationId = owner.orgId
  const viewer = await signUp("Viewer")
  await auth.api.addMember({
    body: { organizationId: owner.orgId, userId: viewer.userId, role: "viewer" },
  })
  await auth.api.setActiveOrganization({
    headers: new Headers({ cookie: viewer.cookie }),
    body: { organizationId: owner.orgId },
  })
  const other = await signUp("Other")

  const orgKey = async (
    organizationId: string,
    userId: string,
    permissions: Record<string, string[]>,
  ) => (await auth.api.createApiKey({ body: { organizationId, userId, permissions } })).key
  const fullKey = await orgKey(owner.orgId, owner.userId, {
    project: ["create", "read", "update", "delete"],
    apiKey: ["read"],
  })
  const readKey = await orgKey(owner.orgId, owner.userId, { project: ["read"] })
  const otherKey = await orgKey(other.orgId, other.userId, {
    project: ["create", "read", "delete"],
  })

  /** Headers for a credential: an API key (`sk_…`) or a session cookie. */
  const as = (credential: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (credential.startsWith("sk_")) headers.set("x-api-key", credential)
    else {
      headers.set("cookie", credential)
      // Browsers send Origin; better-auth rejects cookie requests without a trusted one.
      headers.set("origin", BASE)
    }
    if (!headers.has("content-type")) headers.set("content-type", "application/json")
    return { ...init, headers }
  }

  /** An MCP client on /mcp using a credential (API key, cookie) or explicit headers. */
  const mcpClient = async (credential: string | Record<string, string>) => {
    const client = new Client({ name: "test", version: "1.0.0" })
    const sign = (init: RequestInit = {}) => {
      if (typeof credential === "string") return as(credential, init)
      const headers = new Headers(init.headers)
      for (const [k, v] of Object.entries(credential)) headers.set(k, v)
      return { ...init, headers }
    }
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        fetch: async (url, init) => app.request(String(url), sign(init)),
      }),
    )
    return client
  }

  /** Put an organization on a plan, as an active subscription would. */
  const onPlan = (organizationId: string, plan: PlanId) => {
    // With Stripe plans the source is the subscription table: seed a `subscription` row instead.
    if (options.stripe?.plans?.length) throw new Error("onPlan: this test app bills through Stripe")
    return plans.set(organizationId, { planKey: plan, status: "active" })
  }

  return {
    app,
    auth,
    onPlan,
    plans,
    operations,
    files,
    req,
    as,
    mcpClient,
    signUp,
    owner,
    viewer,
    other,
    fullKey,
    readKey,
    otherKey,
    outbox,
    devMail,
    flags,
    operator,
    db: t.db,
    close: async () => {
      await flags.close()
      await t.close()
    },
  }
}
