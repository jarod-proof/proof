// A stand-in for the Proof API for CLI tests: the OAuth endpoints the device grant uses, the
// real openapi.json, and a few operations. Requests are recorded so tests can assert on them.
import { readFileSync } from "node:fs"

export const BASE = "https://api.test"
const SPEC = JSON.parse(
  readFileSync(new URL("../../../apps/api/openapi.json", import.meta.url), "utf8"),
) as unknown

export interface Recorded {
  method: string
  path: string
  search: string
  headers: Headers
  body: string
}

export interface Reply {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

export interface FakeApi {
  fetch: (request: Request) => Promise<Response>
  calls: Recorded[]
  /** Replies to the device-grant polls, in order. After they run out, a token is issued. */
  tokenPolls: Reply[]
  /** When set, refresh-token grants get this reply instead of a new token. */
  refreshReply?: Reply
  /** When set, the register endpoint answers with this instead of client cli_1. */
  registerReply?: Reply
  /** When set, the device-code endpoint answers with this. */
  deviceReply?: Reply
  /** Replies to /v1/projects/... and other operations by path, when set. */
  routes: Record<string, Reply>
}

export const TOKENS = {
  access_token: "at_1",
  refresh_token: "rt_1",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "read write offline_access",
}

/** What a refresh-token grant rotates the two tokens to. */
const ROTATED = { access_token: "at_2", refresh_token: "rt_2" }

/** The tokens a refresh-token grant returns: the access token and a rotated refresh token. */
export const REFRESHED = { ...TOKENS, ...ROTATED }

export function fakeApi(): FakeApi {
  const api: FakeApi = {
    calls: [],
    tokenPolls: [],
    routes: {},
    fetch: async (request) => {
      const url = new URL(request.url)
      const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text()
      api.calls.push({
        method: request.method,
        path: url.pathname,
        search: url.search,
        headers: request.headers,
        body,
      })
      return reply(api, request.method, url.pathname, body)
    },
  }
  return api
}

function json(reply: Reply): Response {
  return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
    status: reply.status,
    headers: { "content-type": "application/json", ...reply.headers },
  })
}

function reply(api: FakeApi, method: string, path: string, body: string): Response {
  const override = api.routes[`${method} ${path}`]
  if (override) return json(override)
  if (path === "/api/auth/oauth2/register") {
    return json(api.registerReply ?? { status: 201, body: { client_id: "cli_1" } })
  }
  if (path === "/api/auth/device/code") {
    return json(
      api.deviceReply ?? {
        status: 200,
        body: {
          device_code: "dev_1",
          user_code: "ABCD-1234",
          verification_uri: `${BASE}/device`,
          expires_in: 600,
          interval: 1,
        },
      },
    )
  }
  if (path === "/api/auth/oauth2/token") {
    const form = new URLSearchParams(body)
    if (form.get("grant_type") === "refresh_token") {
      return json(
        api.refreshReply ?? {
          status: 200,
          body: REFRESHED,
        },
      )
    }
    const next = api.tokenPolls.shift()
    return json(next ?? { status: 200, body: TOKENS })
  }
  if (path === "/api/auth/oauth2/revoke") return json({ status: 200, body: {} })
  if (path === "/openapi.json") return json({ status: 200, body: SPEC })

  const route = api.routes[`${method} ${path}`]
  if (route) return json(route)
  if (path === "/v1/whoami") {
    return json({ status: 200, body: { organizationId: "org_1", via: "oauth" } })
  }
  if (path === "/v1/projects" && method === "GET") {
    return json({ status: 200, body: { projects: [{ id: "p_1" }], nextCursor: null } })
  }
  if (path === "/v1/projects" && method === "POST") {
    return json({ status: 201, body: { id: "p_2", name: JSON.parse(body).name } })
  }
  if (path.startsWith("/v1/projects/") && method === "DELETE") {
    return json({ status: 200, body: { deleted: true, id: path.split("/").pop() } })
  }
  if (path === "/v1/signup" && method === "POST") {
    return json({
      status: 200,
      body: { organizationId: "org_9", apiKey: "sk_fake", claimUrlSentTo: "a@b.test" },
    })
  }
  if (path === "/v1/audit-events") {
    return json({
      status: 403,
      body: { error: { code: "FORBIDDEN", message: "Needs admin.", hint: "Use an admin login." } },
    })
  }
  return json({
    status: 404,
    body: { error: { code: "NOT_FOUND", message: `No route ${method} ${path}` } },
  })
}
