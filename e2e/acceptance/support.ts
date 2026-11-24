import { createHmac } from "node:crypto"
import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Browser, Cookie } from "@e2e-dev/web"
import type { App, Locator, Screen } from "e2e"
import { expect } from "e2e"

import { uniqueId } from "../support/unique"

// Shared by the acceptance journeys (e2e/acceptance/*.e2e.ts): the Phase 1 completion check of a
// deployed org, run by hand against the org's real hq. Not a test file. Every value comes from the
// environment (`op run --env-file <vault env file> -- ...`); nothing here is a host or a secret.
// It reads process.env directly: the org's baseline excludes e2e/acceptance/** from the rule that
// sends env reads through @<org>/env, because this is test code and never runs with the app's env.
//
// THE SAFE RUN COMMAND, from the org's checkout (the journeys spend, grant and open pull requests
// on the real org, so never `pnpm e2e`, and never two targets):
//
//   FACTORY_ACCEPTANCE=1 HQ_BASE_URL=https://<hq host> E2E_BASE_URL=https://<hq host> \
//   ACCEPTANCE_GITHUB_REPO=<owner>/<repo> \
//   op run --env-file <the vault env file> -- \
//     pnpm exec e2e run --config e2e.dist.config.ts --target desktop --workers 1 e2e/acceptance
//
// `e2e.dist.config.ts` is the config that opens an already running app at E2E_BASE_URL, which must
// be the same URL as HQ_BASE_URL (the proposals journey drives hq's /admin pages in a browser).
// It declares two targets (desktop, phone): `--target desktop` keeps it to one. A journey run twice
// in one run (two targets, or a retry) is refused by `claimRun` below, before it writes anything.
//
// SIGN-INS. hq limits sign-ins to 5 per minute and counts the ones that succeed too (HTTP 429 with
// `x-retry-after`). One run of the nine journeys makes these, in any order:
//   founderClient()                       1  memoised for the worker (see there): brain, proposals,
//                                            slack, spend, app-approvals, app-digest and app-runner
//                                            all share it
//   app-shell (the app's sign-in form)    2  one wrong password, one right
//   proposals (browser, /admin/login)     1
//   app-approvals, app-digest, app-runner 0  each starts from the founder's session cookie in the
//                                            browser (openAppAsFounder), which founderClient holds
//   review                                0
// That is 4, under the limit of 5, so a run does not have to wait. Two runs less than a minute
// apart add up. If a browser did not accept the injected cookie, openAppAsFounder falls back to
// signInThroughApp in each of the three app journeys: up to 9 more submits (3 journeys, 3 tries
// each), usually 3, and the run is then slower. signInFounder and signInThroughApp wait out a 429
// for the time hq names; the proposals journey's /admin/login sign-in (Phase 1, unchanged) does
// NOT, so a run that exceeds the limit can still fail there, and which journey meets the 429 first
// is the runner's order, not fixed. The three app journeys never sign out: their cookie is the
// session founderClient keeps; only app-shell (which signs in for itself) signs out.
//
//   FACTORY_ACCEPTANCE=1   the switch: without it the journeys skip, so a plain `pnpm e2e` never
//                          touches a real org (they spend, grant and open pull requests)
//   HQ_BASE_URL            the org's hq, https://..., also the Origin a signed-in write must carry
//   HQ_AGENT_API_KEY       the agent's key for hq
//   FOUNDER_EMAIL, HQ_FOUNDER_PASSWORD   the founder account made by create-founder
//   SLACK_SIGNING_SECRET, HQ_SLACK_TEAM_ID, HQ_FOUNDERS   the slack journey
//   ACCEPTANCE_GITHUB_REPO  owner/name, the review journey (the gh CLI must be logged in)

/** Why the journeys skip, or false when they run. Evaluated when a file registers its test. */
export const acceptanceSkip: string | false =
  process.env.FACTORY_ACCEPTANCE === "1" && process.env.HQ_BASE_URL
    ? false
    : "acceptance runs only against a deployed org: set FACTORY_ACCEPTANCE=1 and HQ_BASE_URL"

/**
 * Claims a journey for this run, before it writes anything: throws when the same journey was
 * already claimed in this run. e2e 0.22 does not tell a test which target it runs on, but every
 * worker of one run has the same parent (the runner), so a marker file keyed by that parent and
 * the journey says "already ran". Two targets (or a retry) would otherwise run each journey twice
 * against one hq, and the spend journey's second copy could race the first at the cap. A marker
 * older than six hours is a leftover of an earlier run that had the same pid and is replaced.
 */
export function claimRun(journey: string): void {
  const dir = join(tmpdir(), "factory-acceptance")
  mkdirSync(dir, { recursive: true })
  const marker = join(dir, `${process.ppid}-${journey}`)
  try {
    if (Date.now() - statSync(marker).mtimeMs > 6 * 3_600_000) unlinkSync(marker)
  } catch {
    // No marker yet.
  }
  try {
    writeFileSync(marker, `${process.pid}\n`, { flag: "wx" })
  } catch {
    throw new Error(
      `the ${journey} journey already ran in this run: run the acceptance suite with ` +
        "--target desktop --workers 1 (one target), and without retries",
    )
  }
}

/** The value of a required environment variable; the error names it and never its value. */
export function need(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set (the acceptance run reads it from the vault)`)
  return value
}

/** hq's base URL without a trailing slash. */
export const hqBase = (): string => need("HQ_BASE_URL").replace(/\/+$/, "")

/** The hq app's base URL: `<hq>/app`, no trailing slash. */
export const appBase = (): string => `${hqBase()}/app`

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * Throws unless hq's URL is https (or http on this machine, for a local stack): the founder's
 * password and session must not cross a network in clear.
 */
export function assertSecureHq(): void {
  const url = new URL(hqBase())
  const local = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)
  if (url.protocol !== "https:" && !local) {
    throw new Error(`HQ_BASE_URL must be https (http only on localhost), not ${url.origin}`)
  }
}

/**
 * Throws unless the browser's app is the org's hq (E2E_BASE_URL on the same origin as
 * HQ_BASE_URL) and that origin is secure. Called before a session is handed to the browser and
 * before a password is typed; signInThroughApp also checks the page it is typing into.
 */
export function assertAppIsHq(app: App): void {
  if (!app.baseUrl || new URL(app.baseUrl).origin !== new URL(hqBase()).origin) {
    throw new Error("E2E_BASE_URL must be the org's hq (the same URL as HQ_BASE_URL)")
  }
  assertSecureHq()
}

/** Throws unless the page the browser shows is on hq's origin (a redirect elsewhere is caught). */
export async function assertPageIsOnHq(browser: Browser): Promise<URL> {
  const page = new URL(await browser.url())
  if (page.origin !== new URL(hqBase()).origin) {
    throw new Error(`the browser is on ${page.origin}, not on hq: refusing to go on`)
  }
  return page
}

/** A suffix for this run's data: `acceptance-<time and random>`, lowercase, slug-safe. */
export const runTag = (): string =>
  `acceptance-${uniqueId()
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()}`

/** One hq reply: the status and the JSON body (null when the body was not JSON). */
export interface Reply {
  status: number
  json: Record<string, unknown>
}

/** An error reply's code, or undefined. */
export const errorCode = (reply: Reply): string | undefined =>
  (reply.json.error as { code?: string } | undefined)?.code

async function send(
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Reply> {
  const res = await fetch(
    new URL(path, hqBase()),
    body === undefined
      ? { method, headers }
      : {
          method,
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  )
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    // Not JSON: the status carries the news.
  }
  return { status: res.status, json }
}

/** hq as the agent: the organization API key, which can propose and record but never decide. */
export function agentClient() {
  const key = need("HQ_AGENT_API_KEY")
  return {
    get: (path: string) => send("GET", path, { "x-api-key": key }),
    post: (path: string, body: unknown) => send("POST", path, { "x-api-key": key }, body),
    /** One MCP tools/call over Streamable HTTP (stateless, JSON replies). */
    mcp: async (tool: string, args: Record<string, unknown>) => {
      const res = await fetch(new URL("/mcp", hqBase()), {
        method: "POST",
        headers: {
          "x-api-key": key,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: tool, arguments: args },
        }),
      })
      const reply = (await res.json()) as {
        result?: {
          isError?: boolean
          structuredContent?: Record<string, unknown>
          content?: { type: string; text?: string }[]
        }
        error?: unknown
      }
      const result = reply.result
      const text = result?.content?.find((part) => part.type === "text")?.text
      const json = result?.structuredContent ?? (text ? JSON.parse(text) : {})
      return { status: res.status, isError: result?.isError === true || !!reply.error, json }
    },
    /** MCP tools/list: the tool names. */
    mcpTools: async (): Promise<string[]> => {
      const res = await fetch(new URL("/mcp", hqBase()), {
        method: "POST",
        headers: {
          "x-api-key": key,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
      const reply = (await res.json()) as { result?: { tools?: { name: string }[] } }
      return (reply.result?.tools ?? []).map((tool) => tool.name)
    },
  }
}

/** The cookie header a response's Set-Cookie headers make. */
export const cookieOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ")

/**
 * Signs the founder in by email and returns the session cookie. hq rate-limits sign-ins (HTTP 429
 * with `x-retry-after` seconds), and the journeys sign in several times in a row, so a 429 waits
 * the time it names and tries again, for up to a minute.
 */
async function signInFounder(): Promise<string[]> {
  assertSecureHq()
  const base = hqBase()
  const body = JSON.stringify({
    email: need("FOUNDER_EMAIL"),
    password: need("HQ_FOUNDER_PASSWORD"),
  })
  const giveUp = Date.now() + 60_000
  for (;;) {
    const res = await fetch(new URL("/api/auth/sign-in/email", base), {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(base).origin },
      body,
    })
    if (res.status === 200) return res.headers.getSetCookie()
    if (res.status !== 429 || Date.now() > giveUp) {
      throw new Error(`the founder could not sign in to hq: HTTP ${res.status}`)
    }
    const wait = Number(res.headers.get("x-retry-after") ?? res.headers.get("retry-after") ?? 5)
    await new Promise((resolve) => setTimeout(resolve, (Number.isFinite(wait) ? wait : 5) * 1000))
  }
}

const SAME_SITE: Record<string, "Strict" | "Lax" | "None"> = {
  strict: "Strict",
  lax: "Lax",
  none: "None",
}

/** One `Set-Cookie` header as a cookie for the browser, on hq's origin; null for one hq clears. */
function browserCookie(setCookie: string): Cookie | null {
  const [pair = "", ...attributes] = setCookie.split(";").map((part) => part.trim())
  const eq = pair.indexOf("=")
  if (eq < 1) return null
  const cookie: {
    name: string
    value: string
    url: string
    httpOnly?: boolean
    secure?: boolean
    sameSite?: "Strict" | "Lax" | "None"
    expires?: number
  } = { name: pair.slice(0, eq), value: pair.slice(eq + 1), url: hqBase() }
  for (const attribute of attributes) {
    const at = attribute.indexOf("=")
    const key = (at < 0 ? attribute : attribute.slice(0, at)).toLowerCase()
    const value = at < 0 ? "" : attribute.slice(at + 1)
    if (key === "httponly") cookie.httpOnly = true
    else if (key === "secure") cookie.secure = true
    else if (key === "samesite") {
      const same = SAME_SITE[value.toLowerCase()]
      if (same) cookie.sameSite = same
    } else if (key === "max-age") {
      const seconds = Number(value)
      if (!Number.isFinite(seconds) || seconds <= 0) return null
      cookie.expires = Math.floor(Date.now() / 1000) + seconds
    }
  }
  // A cookie named `__Secure-...` is refused by a browser unless it is marked Secure.
  if (cookie.name.startsWith("__Secure-") || cookie.name.startsWith("__Host-")) cookie.secure = true
  return cookie
}

/** What `founderClient()` gives: hq as the founder, and the same session for a browser. */
export interface FounderClient {
  /** The id hq records as `decidedBy` when this founder decides a proposal. */
  userId: string
  /** The session's cookies for `browser.setCookies`, whatever names hq's better-auth gave them. */
  cookies: Cookie[]
  get: (path: string) => Promise<Reply>
  post: (path: string, body: unknown) => Promise<Reply>
}

async function makeFounderClient(): Promise<FounderClient> {
  const setCookies = await signInFounder()
  const headers = {
    cookie: setCookies.map((c) => c.split(";")[0]).join("; "),
    origin: new URL(hqBase()).origin,
  }
  // Who hq says this session is: the id it records as `decidedBy` when this founder decides.
  const session = await send("GET", "/api/auth/get-session", headers)
  const userId = (session.json.user as { id?: string } | undefined)?.id
  if (!userId) throw new Error("hq's get-session did not name the signed-in founder")
  return {
    userId,
    cookies: setCookies.map(browserCookie).filter((cookie): cookie is Cookie => cookie !== null),
    get: (path: string) => send("GET", path, headers),
    post: (path: string, body: unknown) => send("POST", path, headers, body),
  }
}

const FOUNDER_MEMO = Symbol.for("factory.acceptance.founderClient")

/**
 * hq as the founder: a session from the email sign-in, sent with hq's own origin (a signed-in
 * write must come from a trusted origin, and hq trusts its configured base URL).
 *
 * Memoised, so a run signs in once however many journeys ask: hq limits sign-ins to 5 per minute
 * (see SIGN-INS above). The worker process runs every file of a `--workers 1` run, so the one
 * promise is kept on `globalThis` (it survives a module being loaded again) and is dropped when
 * the sign-in fails, so the next journey tries again rather than reusing a failure.
 */
export function founderClient(): Promise<FounderClient> {
  const memo = globalThis as { [FOUNDER_MEMO]?: Promise<FounderClient> }
  memo[FOUNDER_MEMO] ??= makeFounderClient().catch((error: unknown) => {
    delete memo[FOUNDER_MEMO]
    throw error
  })
  return memo[FOUNDER_MEMO]
}

/**
 * Types the founder's credentials into the app's sign-in form (already on screen) and waits until
 * the form is gone. Before every fill it checks that the page is hq's own `/app/sign-in` (not a
 * page a redirect led to). A 429 shows "Too many attempts. Try again in N seconds." in the form:
 * the wait for those N seconds is an `expect.poll` on the clock (its timeout is the wait), then the
 * form is submitted again, up to three times in all. A wrong password or any other error in the
 * form throws. The journey must run with `trace: "off"` and `video: "off"`: the password is typed.
 */
export async function signInThroughApp(screen: Screen, app: App, browser: Browser): Promise<void> {
  assertAppIsHq(app)
  const email = screen.getByLabel("Email")
  const alert = screen.getByRole("alert")
  const limited = alert.filter({ hasText: "Too many attempts" })
  // The form must be on screen first: a form that has not rendered yet also reads as "hidden".
  await expect(email).toBeVisible()
  for (let attempt = 0; attempt < 3; attempt++) {
    const page = await assertPageIsOnHq(browser)
    if (!page.pathname.startsWith("/app/sign-in")) {
      throw new Error(`refusing to type the password on ${page.pathname}: not hq's app sign-in`)
    }
    await email.fill(need("FOUNDER_EMAIL"))
    await screen.getByLabel("Password").fill(need("HQ_FOUNDER_PASSWORD"))
    await screen.getByRole("button", "Sign in").tap()
    // Signed in (the form is gone), or the form says why not.
    await expect
      .poll(async () => (await email.isHidden()) || (await alert.isVisible()), { timeout: 20_000 })
      .toBe(true)
    if (await email.isHidden()) return
    if (!(await limited.isVisible())) {
      throw new Error(`the sign-in form refused the founder: ${await alert.textContent()}`)
    }
    const shown = /(\d+) seconds?/.exec((await limited.textContent()) ?? "")
    const seconds = shown ? Number(shown[1]) : 5
    const until = Date.now() + seconds * 1000
    await expect
      .poll(() => Date.now() >= until, { timeout: seconds * 1000 + 5000, interval: 500 })
      .toBe(true)
  }
  throw new Error("the app's sign-in form kept answering 'Too many attempts'")
}

/**
 * Opens a page of the app (`path` is inside it, such as "/approvals") signed in as the founder
 * without typing the password: the session founderClient() made is put in the browser as cookies.
 * It waits for the app's navigation. If the form is what shows (the browser did not take the
 * cookie), it falls back to the app's own sign-in form. Never click Sign out in a journey that
 * used this: that ends the session every other journey shares.
 */
export async function openAppAsFounder(
  app: App,
  browser: Browser,
  screen: Screen,
  path: string,
): Promise<void> {
  assertAppIsHq(app)
  const founder = await founderClient()
  await browser.setCookies(founder.cookies)
  await app.open(`/app${path}`)
  await assertPageIsOnHq(browser)
  // Either the app drew its navigation (signed in) or its sign-in form. A locator `or` is not used:
  // e2e 0.22 cannot combine a label query with a role query.
  const email = screen.getByLabel("Email")
  const nav = screen.getByRole("navigation", "Primary")
  await expect
    .poll(async () => (await nav.isVisible()) || (await email.isVisible()), { timeout: 20_000 })
    .toBe(true)
  await assertPageIsOnHq(browser)
  if (await email.isVisible()) await signInThroughApp(screen, app, browser)
}

/**
 * Runs `look` (what the page shows) between two reads of hq and says whether hq held still.
 * Journeys compare a screen with hq's own numbers; on a live org a run can finish or a proposal
 * can arrive between the page's fetch and the journey's, so they use this with
 * `expectPageToAgreeWithHq`.
 */
export async function readAround<H, S>(
  read: () => Promise<H>,
  look: () => Promise<S>,
): Promise<{ hq: H; seen: S; held: boolean }> {
  const before = await read()
  const seen = await look()
  const after = await read()
  return { hq: before, seen, held: JSON.stringify(before) === JSON.stringify(after) }
}

/**
 * Retries `check` until it returns "" (the page and hq agree), for up to 90 seconds. A check that
 * returns text means they differ (or hq moved while it read): the page is reloaded, so it asks hq
 * again, and `check` runs again. The last difference is the failure message.
 */
export async function expectPageToAgreeWithHq(
  browser: Browser,
  ready: Locator,
  check: () => Promise<string>,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const difference = await check()
        if (difference === "") return ""
        await browser.reload()
        await expect(ready).toBeVisible()
        return difference
      },
      { timeout: 90_000, interval: 1000 },
    )
    .toBe("")
}

/** The proposal a list reply holds, by id. */
export interface ProposalView {
  id: string
  status: string
  decidedBy: string | null
  proposedBy: { type: string; id: string }
  title: string
}

/** One proposal's current state, looked up in the newest page of the list. */
export async function proposalById(
  client: { get: (path: string) => Promise<Reply> },
  id: string,
): Promise<ProposalView | undefined> {
  const list = await client.get("/v1/proposals?limit=100")
  return (list.json.proposals as ProposalView[]).find((p) => p.id === id)
}

/** The founders hq lists: Slack user ids, from HQ_FOUNDERS (`<who>=<slack user id>,...`). */
export function founderSlackUsers(): string[] {
  return need("HQ_FOUNDERS")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => entry.slice(entry.lastIndexOf("=") + 1).trim())
}

/**
 * Slack's signed POST for a button click, sent to hq's own /v1/slack/actions (what the agent
 * forwards): the real signing secret and workspace of the org, a made-up or real Slack user.
 */
export async function slackClick(
  user: string,
  actionId: string,
  options: { badSignature?: boolean; staleBySeconds?: number } = {},
): Promise<{ status: number; text: string }> {
  const team = need("HQ_SLACK_TEAM_ID")
  const rawBody = `payload=${encodeURIComponent(
    JSON.stringify({
      type: "block_actions",
      team: { id: team },
      user: { id: user, team_id: team, name: "acceptance" },
      channel: { id: "C0ACCEPT" },
      message: { ts: "1700000000.000100", thread_ts: "1700000000.000100" },
      trigger_id: `trigger-${crypto.randomUUID()}`,
      actions: [
        { action_id: actionId, block_id: "b", value: actionId, action_ts: `${Date.now() / 1000}` },
      ],
    }),
  )}`
  const timestamp = String(Math.floor(Date.now() / 1000) - (options.staleBySeconds ?? 0))
  const signature = options.badSignature
    ? `v0=${"0".repeat(64)}`
    : `v0=${createHmac("sha256", need("SLACK_SIGNING_SECRET")).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`
  const res = await fetch(new URL("/v1/slack/actions", hqBase()), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": signature,
    },
    body: rawBody,
  })
  const json = (await res.json().catch(() => ({}))) as { text?: string }
  return { status: res.status, text: json.text ?? "" }
}
