import type { z } from "zod"

import { errorFromReply, HqError } from "./errors"
import {
  type Decision,
  decisionSchema,
  type Digest,
  digestSchema,
  type FactoryStatus,
  factoryStatusSchema,
  type Policy,
  policySchema,
  type Proposal,
  type ProposalStatus,
  proposalsPageSchema,
  type SessionUser,
  sessionReplySchema,
  statusSchema,
} from "./schemas"

export interface HqClient {
  /** GET /v1/status: the gate's probe. */
  status(): Promise<{ ok: true; version: string }>
  /** GET /api/auth/get-session: the signed-in user, or null with no session. */
  session(): Promise<SessionUser | null>
  signIn(input: { email: string; password: string }): Promise<void>
  signOut(): Promise<void>
  listProposals(input?: {
    status?: ProposalStatus
    cursor?: string
    limit?: number
  }): Promise<{ proposals: Proposal[]; nextCursor: string | null }>
  decideProposal(input: {
    proposalId: string
    decision: "approve" | "reject"
    note?: string
  }): Promise<Decision>
  getFactoryStatus(): Promise<FactoryStatus>
  getDigest(input?: { since?: string }): Promise<Digest>
  getPolicy(): Promise<Policy>
}

interface Call {
  method: "GET" | "POST"
  path: string
  query?: Record<string, string | number | undefined>
  body?: unknown
}

/** A client of hq's REST API and sign-in. `baseUrl: ""` is same-origin, as the app runs. */
export function createHqClient(opts: { baseUrl?: string; fetch?: typeof fetch } = {}): HqClient {
  const baseUrl = opts.baseUrl ?? ""
  // Called as a method of `window` would be illegal when stored bare: wrap it.
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init))

  async function send(call: Call): Promise<unknown> {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(call.query ?? {})) {
      if (value !== undefined) search.set(key, String(value))
    }
    const url = `${baseUrl}${call.path}${search.size > 0 ? `?${search}` : ""}`
    const init: RequestInit = { method: call.method, credentials: "same-origin" }
    if (call.method !== "GET") {
      init.headers = { "content-type": "application/json" }
      init.body = JSON.stringify(call.body ?? {})
    }

    let res: Response
    try {
      res = await doFetch(url, init)
    } catch {
      throw new HqError({ kind: "unreachable", status: 0, message: "hq could not be reached" })
    }

    let body: unknown
    try {
      body = await res.json()
    } catch {
      body = undefined
    }
    if (!res.ok) throw errorFromReply(res.status, res.headers, body)
    if (body === undefined) {
      throw new HqError({ kind: "server", status: res.status, message: "hq sent a non-JSON reply" })
    }
    return body
  }

  async function get<S extends z.ZodType>(schema: S, call: Call): Promise<z.infer<S>> {
    const body = await send(call)
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      throw new HqError({
        kind: "server",
        status: 200,
        message: `hq sent a reply this app does not understand (${call.path})`,
      })
    }
    return parsed.data
  }

  return {
    status: () => get(statusSchema, { method: "GET", path: "/v1/status" }),
    session: async () =>
      (await get(sessionReplySchema, { method: "GET", path: "/api/auth/get-session" }))?.user ??
      null,
    signIn: async (input) => {
      await send({ method: "POST", path: "/api/auth/sign-in/email", body: input })
    },
    signOut: async () => {
      await send({ method: "POST", path: "/api/auth/sign-out" })
    },
    listProposals: (input = {}) =>
      get(proposalsPageSchema, { method: "GET", path: "/v1/proposals", query: input }),
    decideProposal: ({ proposalId, decision, note }) =>
      get(decisionSchema, {
        method: "POST",
        path: `/v1/proposals/${encodeURIComponent(proposalId)}/decision`,
        body: { decision, ...(note === undefined ? {} : { note }) },
      }),
    getFactoryStatus: () => get(factoryStatusSchema, { method: "GET", path: "/v1/factory/status" }),
    getDigest: (input = {}) =>
      get(digestSchema, { method: "GET", path: "/v1/digest", query: input }),
    getPolicy: () => get(policySchema, { method: "GET", path: "/v1/policy" }),
  }
}
