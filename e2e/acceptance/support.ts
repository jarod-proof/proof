import { createHmac } from "node:crypto"
import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { uniqueId } from "../support/unique"
import { acceptanceSkip, need } from "./acceptance.config"

export { acceptanceSkip, need }

// Shared by the acceptance journeys (e2e/acceptance/*.e2e.ts): the Phase 1 completion check of a
// deployed org, run by hand against the org's real hq. Not a test file. Every value comes from the
// environment (`op run --env-file <vault env file> -- ...`); nothing here is a host or a secret.
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
//   FACTORY_ACCEPTANCE=1   the switch: without it the journeys skip, so a plain `pnpm e2e` never
//                          touches a real org (they spend, grant and open pull requests)
//   HQ_BASE_URL            the org's hq, https://..., also the Origin a signed-in write must carry
//   HQ_AGENT_API_KEY       the agent's key for hq
//   FOUNDER_EMAIL, HQ_FOUNDER_PASSWORD   the founder account made by create-founder
//   SLACK_SIGNING_SECRET, HQ_SLACK_TEAM_ID, HQ_FOUNDERS   the slack journey
//   ACCEPTANCE_GITHUB_REPO  owner/name, the review journey (the gh CLI must be logged in)

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

/** hq's base URL without a trailing slash. */
export const hqBase = (): string => need("HQ_BASE_URL").replace(/\/+$/, "")

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
async function signInFounder(): Promise<string> {
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
    if (res.status === 200) return cookieOf(res)
    if (res.status !== 429 || Date.now() > giveUp) {
      throw new Error(`the founder could not sign in to hq: HTTP ${res.status}`)
    }
    const wait = Number(res.headers.get("x-retry-after") ?? res.headers.get("retry-after") ?? 5)
    await new Promise((resolve) => setTimeout(resolve, (Number.isFinite(wait) ? wait : 5) * 1000))
  }
}

/**
 * hq as the founder: a session from the email sign-in, sent with hq's own origin (a signed-in
 * write must come from a trusted origin, and hq trusts its configured base URL).
 */
export async function founderClient() {
  const headers = { cookie: await signInFounder(), origin: new URL(hqBase()).origin }
  // Who hq says this session is: the id it records as `decidedBy` when this founder decides.
  const session = await send("GET", "/api/auth/get-session", headers)
  const userId = (session.json.user as { id?: string } | undefined)?.id
  if (!userId) throw new Error("hq's get-session did not name the signed-in founder")
  return {
    userId,
    get: (path: string) => send("GET", path, headers),
    post: (path: string, body: unknown) => send("POST", path, headers, body),
  }
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
