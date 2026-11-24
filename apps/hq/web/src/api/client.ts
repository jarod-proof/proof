import type { z } from "zod"

import { errorFromReply, HqError } from "./errors"
import {
  type AttemptKind,
  type AttemptView,
  attemptViewSchema,
  createdWorkItemSchema,
  type Decision,
  decisionSchema,
  type Digest,
  digestSchema,
  type FactoryStatus,
  factoryStatusSchema,
  mergeApprovalReplySchema,
  type Policy,
  policySchema,
  type Proposal,
  type ProposalStatus,
  proposalsPageSchema,
  type QuestionView,
  questionViewSchema,
  retryReplySchema,
  revertReplySchema,
  type SessionUser,
  sessionReplySchema,
  statusSchema,
  stateReplySchema,
  stoppedReplySchema,
  type WorkBoard,
  type WorkItemDetail,
  type WorkItemsPage,
  type WorkState,
  workBoardSchema,
  workItemDetailSchema,
  workItemsPageSchema,
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

  /** GET /v1/work/board. */
  getWorkBoard(): Promise<WorkBoard>
  /** GET /v1/work-items. */
  listWorkItems(input?: {
    state?: WorkState
    query?: string
    dedupeKey?: string
    cursor?: string
    limit?: number
  }): Promise<WorkItemsPage>
  /** GET /v1/work-items/:itemId; `itemId` is the uuid or `FAC-<n>`. */
  getWorkItem(input: { itemId: string }): Promise<WorkItemDetail>

  // The founder's decisions: person-only writes (a session and a trusted Origin). Each sends one
  // POST per call and the client never retries; the container decides when a click sends it.
  createWorkItem(input: {
    title: string
    body?: string
    repo: string
  }): Promise<{ itemId: string; displayId: string }>
  /** BAD_REQUEST (`bad-request`, with hq's own message) while hq starts attempts from the label. */
  requestAttempt(input: {
    itemId: string
    kind: AttemptKind
    instructions?: string
  }): Promise<AttemptView>
  answerQuestion(input: {
    questionId: string
    optionId: string
    note?: string
  }): Promise<QuestionView>
  approveMerge(input: {
    itemId: string
    headSha: string
    note?: string
  }): Promise<{ status: "approved"; headSha: string; pullRequestUrl: string }>
  stopWorkItem(input: { itemId: string; note?: string }): Promise<{ state: "stopped" }>
  reopenWorkItem(input: { itemId: string; note?: string }): Promise<{ state: WorkState }>
  retryWorkItem(input: { itemId: string; note: string }): Promise<{ attemptLimit: number }>
  requestRevert(input: { itemId: string; note?: string }): Promise<{ state: "reopened" }>
}

interface Call {
  method: "GET" | "POST"
  path: string
  query?: Record<string, string | number | undefined>
  body?: unknown
}

const itemPath = (itemId: string) => `/v1/work-items/${encodeURIComponent(itemId)}`

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
    getWorkBoard: () => get(workBoardSchema, { method: "GET", path: "/v1/work/board" }),
    listWorkItems: (input = {}) =>
      get(workItemsPageSchema, { method: "GET", path: "/v1/work-items", query: input }),
    getWorkItem: ({ itemId }) =>
      get(workItemDetailSchema, { method: "GET", path: itemPath(itemId) }),
    createWorkItem: (input) =>
      get(createdWorkItemSchema, { method: "POST", path: "/v1/work-items", body: input }),
    requestAttempt: ({ itemId, ...body }) =>
      get(attemptViewSchema, {
        method: "POST",
        path: `${itemPath(itemId)}/attempt-requests`,
        body,
      }),
    answerQuestion: ({ questionId, ...body }) =>
      get(questionViewSchema, {
        method: "POST",
        path: `/v1/questions/${encodeURIComponent(questionId)}/answer`,
        body,
      }),
    approveMerge: ({ itemId, ...body }) =>
      get(mergeApprovalReplySchema, {
        method: "POST",
        path: `${itemPath(itemId)}/merge-approval`,
        body,
      }),
    stopWorkItem: ({ itemId, ...body }) =>
      get(stoppedReplySchema, { method: "POST", path: `${itemPath(itemId)}/stop`, body }),
    reopenWorkItem: ({ itemId, ...body }) =>
      get(stateReplySchema, { method: "POST", path: `${itemPath(itemId)}/reopen`, body }),
    retryWorkItem: ({ itemId, ...body }) =>
      get(retryReplySchema, { method: "POST", path: `${itemPath(itemId)}/retry`, body }),
    requestRevert: ({ itemId, ...body }) =>
      get(revertReplySchema, { method: "POST", path: `${itemPath(itemId)}/revert-request`, body }),
  }
}
