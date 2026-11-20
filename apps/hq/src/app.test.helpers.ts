// Test-only: hq's real app on in-process Postgres (PGlite), with helpers to sign people up, mint API
// keys and call it over HTTP.
import { createAuth } from "@proof/auth"
import { user } from "@proof/db"
import { eq } from "drizzle-orm"

import { createHqApp } from "./app"
import { addFounder as addFounderRow } from "./data/founders"
import { slackSignature } from "./slack/verify"
import { createHqTestDb } from "./testing"

const BASE = "http://localhost:3100"
const SECRET = "a-test-secret-that-is-long-enough-123456" // gitleaks:allow
/** The Slack app's signing secret and the workspace hq accepts clicks from, in tests. */
export const TEST_SLACK_SECRET = "slack-signing-secret-for-tests-only" // gitleaks:allow
export const TEST_SLACK_TEAM = "T0TEST"

/** A Slack interactivity body: `payload=<url-encoded JSON>`, as Slack posts it. */
export const slackFormBody = (payload: unknown) =>
  `payload=${encodeURIComponent(JSON.stringify(payload))}`

/**
 * What an hq reply's JSON holds, as the tests read it: every operation's output, error and list
 * keys in one shape (a field a reply doesn't have is just not there).
 */
export interface Reply {
  error: { code: string; message: string }
  status: string
  proposalId: string
  requestId: string
  amountUsd: number
  expiresAt: string
  entryId: string
  version: number
  latestVersion: number
  id: string
  body: { text: string }
  entries: { id: string; slug: string; version: number }[]
  hits: { id: string; version: number; excerpt: string }[]
  versions: { version: number }[]
  proposals: {
    id: string
    slug: string
    status: string
    entryId: string | null
    decidedBy: string | null
    proposedBy: { type: string }
  }[]
}

export interface TestPerson {
  email: string
  cookie: string
  userId: string
  orgId: string
}

/**
 * An hq app on a test database, with the helpers the HTTP tests share: sign people up, mint API
 * keys, and call it. The clock is fixed unless `now` is given.
 */
export async function createHqHarness(
  opts: {
    /** Addresses that become founders (a `hq.founders` row) when they sign up through `signUp`. */
    founderEmails?: string[]
    now?: () => Date
    /** Sign-up is open in the harness (it signs its people up); a test of the closed default says so. */
    allowSignUp?: boolean
    /** The cap on what Slack clicks may grant in a UTC day in all; unset, hq's default ($50). */
    slackDailyGrantCapUsd?: number
  } = {},
) {
  const founderEmails = opts.founderEmails ?? []
  const test = await createHqTestDb()
  const auth = createAuth({
    db: test.db,
    secret: SECRET,
    baseURL: BASE,
    emailFrom: "Test <auth@example.com>",
    oauthResources: [BASE, `${BASE}/mcp`],
    // No mail is sent in tests; a send that fails must fail the test, not vanish.
    ses: { client: { send: async () => ({ MessageId: "test", $metadata: {} }) } },
    onEmailError: (error) => {
      throw error
    },
    passwordBreachCheck: false,
    rateLimit: false,
    allowSignUp: opts.allowSignUp ?? true,
  })
  const now = opts.now ?? (() => new Date("2026-11-17T12:00:00Z"))
  const app = createHqApp({
    db: test.db,
    auth,
    now,
    baseURL: BASE,
    slack: {
      signingSecret: TEST_SLACK_SECRET,
      teamId: TEST_SLACK_TEAM,
      dailyGrantCapUsd: opts.slackDailyGrantCapUsd,
    },
  })

  let slackSeq = 0
  /** Make a person a founder: a `hq.founders` row, as hq's boot sync writes it. */
  async function addFounder(person: Pick<TestPerson, "userId">, slackUserId?: string) {
    const slack = slackUserId ?? `UTEST${++slackSeq}`
    await addFounderRow(test.db, { userId: person.userId, slackUserId: slack, now: now() })
    return slack
  }

  /** Sign a person up (they get a personal organization they own). A listed address is a founder. */
  async function signUp(email: string, { verified = true } = {}): Promise<TestPerson> {
    const res = await auth.api.signUpEmail({
      body: { email, password: "correct-horse-battery", name: email },
      returnHeaders: true,
    })
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) })
    const orgId = session?.session.activeOrganizationId
    if (!orgId) throw new Error("signup did not activate a personal organization")
    const userId = res.response.user.id
    if (verified) await test.db.update(user).set({ emailVerified: true }).where(eq(user.id, userId))
    const person = { email, cookie, userId, orgId }
    if (founderEmails.includes(email.toLowerCase())) await addFounder(person)
    return person
  }

  /** An organization API key with exactly these permissions, as the person's. */
  async function keyFor(person: TestPerson, permissions: Record<string, string[]>) {
    return (
      await auth.api.createApiKey({
        body: { organizationId: person.orgId, userId: person.userId, permissions },
      })
    ).key
  }

  type Credential = { cookie: string } | { key: string }
  /** Call hq as a person (their cookie) or a key. */
  async function call(
    as: Credential,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Reply }> {
    const headers: Record<string, string> = { origin: BASE }
    if ("cookie" in as) headers.cookie = as.cookie
    else headers["x-api-key"] = as.key
    if (body !== undefined) headers["content-type"] = "application/json"
    const res = await app.request(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Reply }
  }

  /**
   * POST a Slack click to hq as the agent forwards it: the raw body and Slack's headers, signed
   * with the test secret unless `signature` says otherwise. Returns hq's status and text.
   */
  async function slackClick(input: {
    slackUserId: string
    actionId: string
    teamId?: string
    actionTs?: string
    /** Replace the signature (a bad one), or `null` to send none. */
    signature?: string | null
    /** Sign this instant instead of the harness clock. */
    signedAt?: Date
    /** Send these exact bytes instead of building a payload (signed over them all the same). */
    rawBody?: string
    /** Extra headers, such as an API key that must not matter. */
    headers?: Record<string, string>
  }): Promise<{ status: number; text: string; rawBody: string; timestamp: string }> {
    const rawBody =
      input.rawBody ??
      slackFormBody({
        type: "block_actions",
        team: { id: input.teamId ?? TEST_SLACK_TEAM },
        user: { id: input.slackUserId, team_id: input.teamId ?? TEST_SLACK_TEAM },
        trigger_id: `trigger-${++slackSeq}`,
        response_url: "http://127.0.0.1:9/response",
        actions: [
          {
            action_id: input.actionId,
            block_id: "b1",
            action_ts: input.actionTs ?? `${Math.floor(now().getTime() / 1000)}.${++slackSeq}`,
            value: input.actionId,
          },
        ],
      })
    const timestamp = String(Math.floor((input.signedAt ?? now()).getTime() / 1000))
    const signature =
      input.signature === undefined
        ? slackSignature(TEST_SLACK_SECRET, timestamp, rawBody)
        : input.signature
    const res = await app.request(`${BASE}/v1/slack/actions`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        ...(signature === null ? {} : { "x-slack-signature": signature }),
        ...input.headers,
      },
      body: rawBody,
    })
    return {
      status: res.status,
      text: ((await res.json()) as { text: string }).text,
      rawBody,
      timestamp,
    }
  }

  return { ...test, auth, app, now, addFounder, signUp, keyFor, call, slackClick }
}
