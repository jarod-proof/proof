import { z } from "zod"

import type { Digest, FactoryStatus, Policy, Proposal, SessionUser } from "../api/schemas"
import { digestFixture, factoryStatusFixture, policyFixture } from "./fixtures"

// A fake of hq for component tests. It answers with hq's real wire shapes and refusals; the
// contract test (apps/hq/src/web-contract.test.ts) holds it to the real app, status by status.

export interface Sent {
  method: string
  path: string
  search: string
  body: unknown
  credentials: RequestCredentials
}

export interface FakeHqState {
  /** Who the session cookie says is calling. `refused` is an hq that failed to boot (503). */
  caller: "founder" | "non-founder" | "signed-out" | "refused"
  user: SessionUser
  proposals: Proposal[]
  /**
   * Seeded apart from `proposals` (the default says 1 pending with none listed): a test that
   * wants the badge and the list to agree seeds both. A decision lowers this count by one.
   */
  factoryStatus: FactoryStatus
  digest: Digest
  policy: Policy
  /** Answer the next request with this instead (then it clears): a one-off 5xx, 429, 403 and so on. */
  nextError: { status: number; body: unknown } | null
  /** The password a sign-in must send. */
  password: string
  /** Who a successful sign-in becomes. */
  signInAs: "founder" | "non-founder"
  /** Sign-ins seen so far; hq limits them to 5 a minute, successes counted (never resets here). */
  signIns: number
}

export interface FakeHq {
  fetch: typeof fetch
  state: FakeHqState
  sent: Sent[]
}

/** The password the fake accepts (the contract test signs real accounts up with the same one). */
// baseline:allow-next-line no-hardcoded-secrets
export const FAKE_PASSWORD = "correct-horse-battery" // gitleaks:allow (a test value)
const TRUSTED_ORIGIN = "http://localhost:3100"
const SIGN_IN_LIMIT = 5
const DECIDED_AT = "2026-11-17T12:00:00.000Z"

// get_factory_status's reply, as hq builds it: exactly these keys, the three runners in RUNNERS
// order, and a box runner that never reports how a run ended. A fixture that drifts from it throws
// (a test bug), so the fake can never be looser than hq.
const iso = z.string().datetime({ offset: true })
const factoryStatusStrict = z.strictObject({
  now: iso,
  pendingProposals: z.number().int().min(0),
  runners: z
    .array(
      z.strictObject({
        runner: z.enum(["eve", "sandbox", "box"]),
        lastStartedAt: iso.nullable(),
        lastOutcome: z.enum(["succeeded", "failed", "stopped"]).nullable(),
      }),
    )
    .refine(
      (runners) => runners.map((r) => r.runner).join() === "eve,sandbox,box",
      "eve, sandbox and box, in that order",
    )
    .refine((runners) => runners[2]?.lastOutcome === null, "a box run never reports an outcome"),
  allowance: z.strictObject({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    spentUsd: z.number(),
    reservedUsd: z.number(),
    capUsd: z.number(),
    grantedUsd: z.number(),
    remainingUsd: z.number().min(0),
  }),
})

/**
 * A fixture the fake cannot answer with because hq never would. Thrown from createFakeHq, or from
 * fetch (where the client would read a rejected fetch as `unreachable`, so it is also recorded:
 * test/setup.ts fails the test that caused it).
 */
export class FakeHqError extends Error {}
export const fakeViolations: FakeHqError[] = []

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

const appError = (status: number, code: string, message: string, hint?: string): Response =>
  json(status, { error: { code, message, ...(hint ? { hint } : {}) } })

// better-auth's session and user rows carry more than the app reads; the contract test holds the
// fake to the real key set.
const authUser = (user: SessionUser) => ({
  ...user,
  emailVerified: true,
  image: null,
  createdAt: "2026-11-01T09:00:00.000Z",
  updatedAt: "2026-11-01T09:00:00.000Z",
  lastLoginMethod: "email",
  twoFactorEnabled: false,
  twoFactorEnabledAt: null,
  role: "user",
  banned: false,
  banReason: null,
  banExpires: null,
})
const sessionRow = (user: SessionUser) => ({
  id: "session-1",
  userId: user.id,
  token: "fake-token",
  expiresAt: "2026-12-17T12:00:00.000Z",
  createdAt: "2026-11-17T09:00:00.000Z",
  updatedAt: "2026-11-17T09:00:00.000Z",
  ipAddress: "",
  userAgent: "",
  impersonatedBy: null,
  activeOrganizationId: "org-1",
  loginMethod: "email",
  loginTwoFactor: false,
})

/** Parse a JSON text; `undefined` when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The URL string of whatever was passed to fetch. */
export function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url
}

export function createFakeHq(initial: Partial<FakeHqState> = {}): FakeHq {
  const state: FakeHqState = {
    caller: "founder",
    user: { id: "user-1", email: "founder@example.com", name: "Founder" },
    proposals: [],
    factoryStatus: factoryStatusFixture(),
    digest: digestFixture(),
    policy: policyFixture(),
    nextError: null,
    password: FAKE_PASSWORD,
    signInAs: "founder",
    signIns: 0,
    ...initial,
  }
  const sent: Sent[] = []

  function strictFactoryStatus(record: boolean): FactoryStatus {
    const parsed = factoryStatusStrict.safeParse(state.factoryStatus)
    if (parsed.success) return parsed.data
    const error = new FakeHqError(`factoryStatus is not what hq returns: ${parsed.error.message}`)
    if (record) fakeViolations.push(error)
    throw error
  }
  strictFactoryStatus(false)

  /**
   * An Origin from another site. An absent one passes on purpose: the fake stands in for the
   * browser plus hq, and a browser adds the Origin of a same-origin POST itself (the client never
   * sets it). Real hq refuses a session write with no Origin at all.
   */
  const foreignOrigin = (headers: Headers) => {
    const origin = headers.get("origin")
    return origin !== null && origin !== TRUSTED_ORIGIN
  }

  function auth(path: string, method: string, headers: Headers, rawBody: string): Response {
    if (path === "/api/auth/get-session" && method === "GET") {
      if (state.caller === "signed-out") return json(200, null)
      return json(200, { session: sessionRow(state.user), user: authUser(state.user) })
    }
    if (
      method !== "POST" ||
      (path !== "/api/auth/sign-in/email" && path !== "/api/auth/sign-out")
    ) {
      return appError(404, "NOT_FOUND", "Not found")
    }
    if (foreignOrigin(headers))
      return json(403, { code: "INVALID_ORIGIN", message: "Invalid origin" })
    // A string body sent with no content-type gets text/plain from the Request itself (as in a
    // browser), so a sign-out that forgets the header is 415, like hq's.
    const contentType =
      headers.get("content-type") ?? (rawBody === "" ? null : "text/plain;charset=UTF-8")
    if (contentType !== null && !contentType.includes("application/json")) {
      const allowed =
        path === "/api/auth/sign-out"
          ? "application/json"
          : "application/x-www-form-urlencoded, application/json"
      return json(415, {
        message: `Content-Type "${contentType}" is not allowed. Allowed types: ${allowed}`,
        code: "UNSUPPORTED_MEDIA_TYPE",
      })
    }
    const body = parseJson(rawBody)
    if (rawBody !== "" && body === undefined) {
      return json(400, { message: "Invalid JSON in request body", code: "BAD_REQUEST" })
    }
    if (path === "/api/auth/sign-out") {
      state.caller = "signed-out"
      return json(200, { success: true }, { "set-cookie": "session=; Max-Age=0; Path=/" })
    }
    state.signIns += 1
    if (state.signIns > SIGN_IN_LIMIT) {
      return json(
        429,
        { message: "Too many requests. Please try again later." },
        { "x-retry-after": "60" },
      )
    }
    const ok = isRecord(body) && body.email === state.user.email && body.password === state.password
    if (!ok)
      return json(401, { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" })
    state.caller = state.signInAs
    return json(
      200,
      { redirect: false, token: "fake-token", user: authUser(state.user) },
      { "set-cookie": "session=fake; Path=/; HttpOnly" },
    )
  }

  function listProposals(search: URLSearchParams): Response {
    const status = search.get("status")
    const limit = Number(search.get("limit") ?? 50)
    const offset = Number(atob(search.get("cursor") ?? btoa("0")))
    const all = state.proposals
      .filter((p) => status === null || p.status === status)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    const proposals = all.slice(offset, offset + limit)
    const next = offset + limit
    return json(200, { proposals, nextCursor: next < all.length ? btoa(String(next)) : null })
  }

  function decide(proposalId: string, body: Record<string, unknown>): Response {
    // Input is parsed before the handler looks anything up (decide_proposal's zod input).
    const note = body.note
    const noteOk = note === undefined || (typeof note === "string" && note.trim().length <= 2000)
    if ((body.decision !== "approve" && body.decision !== "reject") || !noteOk) {
      return appError(400, "BAD_REQUEST", "Invalid input")
    }
    const proposal = state.proposals.find((p) => p.id === proposalId)
    if (!proposal) return appError(404, "NOT_FOUND", "Proposal not found")
    if (proposal.status !== "pending") {
      return appError(
        409,
        "CONFLICT",
        `The proposal was already ${proposal.status}`,
        "A decided proposal is final. Propose again to change the entry.",
      )
    }
    const approve = body.decision === "approve"
    // The count get_factory_status reports follows the pending proposals.
    state.factoryStatus = {
      ...state.factoryStatus,
      pendingProposals: Math.max(0, state.factoryStatus.pendingProposals - 1),
    }
    proposal.status = approve ? "approved" : "rejected"
    proposal.decidedBy = state.user.id
    proposal.decidedAt = DECIDED_AT
    proposal.decisionNote = typeof body.note === "string" ? body.note : null
    if (!approve) return json(200, { status: "rejected" })
    const version = (proposal.baseVersion ?? 0) + 1
    proposal.entryId ??= `entry-${proposal.id}`
    return json(200, { status: "approved", entryId: proposal.entryId, version })
  }

  /** get_digest's input: an ISO `since` that is not after the digest's own `until`. */
  function digestReply(search: URLSearchParams): Response {
    const since = search.get("since")
    if (since !== null) {
      // The validator hq's get_digest input uses, so the fake can never be looser than hq.
      if (!z.string().datetime({ offset: true }).safeParse(since).success) {
        return appError(400, "BAD_REQUEST", "Invalid input")
      }
      const time = Date.parse(since)
      if (time > Date.parse(state.digest.until)) {
        return appError(400, "BAD_REQUEST", "since is in the future")
      }
    }
    return json(200, state.digest)
  }

  function v1(
    path: string,
    method: string,
    search: URLSearchParams,
    headers: Headers,
    bodyText: string,
  ): Response {
    const decision = /^\/v1\/proposals\/([^/]+)\/decision$/.exec(path)
    const reads: Record<string, () => Response> = {
      "/v1/status": () => json(200, { ok: true, version: "0.0.0" }),
      "/v1/proposals": () => listProposals(search),
      "/v1/factory/status": () => json(200, strictFactoryStatus(true)),
      "/v1/digest": () => digestReply(search),
      "/v1/policy": () => json(200, state.policy),
    }
    const read = method === "GET" ? reads[path] : undefined
    const isDecision = method === "POST" && decision !== null
    // An unknown path or method is a 404 before anything asks who is calling.
    if (!read && !isDecision) return appError(404, "NOT_FOUND", "Not found")

    if (state.caller === "signed-out") {
      return appError(401, "UNAUTHORIZED", "Send an API key or OAuth access token")
    }
    // hq rejects a non-founder in authenticate, before the origin check and the body.
    if (state.caller === "non-founder") {
      return appError(
        403,
        "FORBIDDEN",
        "This brain is for the organization's founders",
        "Your account is not on this org's founder list.",
      )
    }
    if (method !== "GET" && foreignOrigin(headers)) {
      return appError(
        403,
        "FORBIDDEN",
        "A signed-in write must come from a trusted origin",
        "Agents and scripts authenticate with an API key or OAuth access token.",
      )
    }
    let body: unknown = {}
    if (method !== "GET") {
      body = bodyText.trim() === "" ? {} : parseJson(bodyText)
      if (body === undefined) return appError(400, "BAD_REQUEST", "Body must be JSON")
      if (!isRecord(body)) return appError(400, "BAD_REQUEST", "Body must be a JSON object")
    }
    if (read) return read()
    return decide(decodeURIComponent(decision?.[1] ?? ""), body as Record<string, unknown>)
  }

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(urlOf(input), TRUSTED_ORIGIN)
    const method = (init?.method ?? "GET").toUpperCase()
    const headers = new Headers(init?.headers)
    const bodyText = typeof init?.body === "string" ? init.body : ""
    sent.push({
      method,
      path: url.pathname,
      search: url.search,
      body: bodyText === "" ? undefined : parseJson(bodyText),
      credentials: init?.credentials ?? "same-origin",
    })

    if (state.caller === "refused")
      return new Response('{"error":"service unavailable"}', {
        status: 503,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      })
    if (state.nextError) {
      const { status, body } = state.nextError
      state.nextError = null
      return json(status, body)
    }
    if (url.pathname.startsWith("/api/auth/")) {
      return auth(url.pathname, method, headers, bodyText)
    }
    return v1(url.pathname, method, url.searchParams, headers, bodyText)
  }

  return { fetch: fakeFetch as typeof fetch, state, sent }
}
