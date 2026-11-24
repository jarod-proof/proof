// The fake of hq the component tests use (web/src/test/fake-hq.ts) must be as strict as hq: each
// case below runs against the REAL app and against the fake, and both replies are parsed with the
// same zod schemas the client uses and compared on status, error code and the keys of the body.
import { sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { z } from "zod"

import { seedWork } from "../scripts/seed-work.mjs"
import { createHqClient, type HqClient } from "../web/src/api/client"
import { errorFromReply, type HqError, type HqErrorKind } from "../web/src/api/errors"
import {
  attemptViewSchema,
  authErrorSchema,
  createdWorkItemSchema,
  decisionSchema,
  digestSchema,
  errorEnvelopeSchema,
  factoryStatusSchema,
  mergeApprovalReplySchema,
  policySchema,
  proposalsPageSchema,
  questionViewSchema,
  refusedBodySchema,
  retryReplySchema,
  revertReplySchema,
  sessionReplySchema,
  stateReplySchema,
  statusSchema,
  stoppedReplySchema,
  workBoardSchema,
  workItemDetailSchema,
  workItemsPageSchema,
} from "../web/src/api/schemas"
import {
  createFakeHq,
  digestStrict,
  type FakeHq,
  type FakeHqState,
  fakeViolations,
} from "../web/src/test/fake-hq"
import {
  digestFixture,
  digestPipelineFixture,
  emptyDigestPipeline,
  factoryStatusFixture,
  needsYouFixture,
  policyFixture,
  proposalFixture,
  workBoardFixture,
  workItemsFixture,
} from "../web/src/test/fixtures"
import { createHqHarness } from "./app.test.helpers"
import { resetWork } from "./data/work.test.helpers"
import { proposals, runs, spend } from "./db/schema"
import { createLazyHq } from "./lazy-hq"

const BASE = "http://localhost:3100"
const PASSWORD = "correct-horse-battery" // gitleaks:allow
type Caller = FakeHqState["caller"]

/** What a browser does to an hq request: the session cookie, and an Origin on a write. */
function harnessFetch(
  app: { request: (url: string, init?: RequestInit) => Response | Promise<Response> },
  cookie: string,
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers)
    if (cookie && !headers.has("cookie")) headers.set("cookie", cookie)
    if (!headers.has("origin")) headers.set("origin", BASE)
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    return app.request(url, { ...init, headers })
  }
}

interface Step {
  method: "GET" | "POST"
  path: (ctx: { proposalId: string }) => string
  /** A JSON body, or `null` to send none at all. */
  body?: unknown
  headers?: Record<string, string>
  /** The schema the client parses a 2xx reply with. */
  schema?: z.ZodType
  /** The status and error code both targets must answer. */
  status: number
  code: string | null
  /** The kind the client makes of the reply; real and fake must agree on it either way. */
  kind?: HqErrorKind
  /** Send no content-type header at all. */
  noContentType?: boolean
}

interface Scenario {
  name: string
  as: Caller
  steps: Step[]
}

const decide = (decision: "approve" | "reject", extra: Partial<Step> = {}): Step => ({
  method: "POST",
  path: ({ proposalId }) => `/v1/proposals/${proposalId}/decision`,
  body: { decision },
  schema: decisionSchema,
  status: 200,
  code: null,
  ...extra,
})

const scenarios: Scenario[] = [
  {
    name: "signed-out GET /v1/status",
    as: "signed-out",
    steps: [{ method: "GET", path: () => "/v1/status", status: 401, code: "UNAUTHORIZED" }],
  },
  {
    name: "non-founder GET /v1/status",
    as: "non-founder",
    steps: [{ method: "GET", path: () => "/v1/status", status: 403, code: "FORBIDDEN" }],
  },
  {
    name: "founder GET /v1/status",
    as: "founder",
    steps: [
      { method: "GET", path: () => "/v1/status", schema: statusSchema, status: 200, code: null },
    ],
  },
  {
    name: "founder list_proposals",
    as: "founder",
    steps: [
      {
        method: "GET",
        path: () => "/v1/proposals?status=pending",
        schema: proposalsPageSchema,
        status: 200,
        code: null,
      },
    ],
  },
  {
    name: "signed-out list_proposals",
    as: "signed-out",
    steps: [{ method: "GET", path: () => "/v1/proposals", status: 401, code: "UNAUTHORIZED" }],
  },
  {
    name: "non-founder list_proposals",
    as: "non-founder",
    steps: [{ method: "GET", path: () => "/v1/proposals", status: 403, code: "FORBIDDEN" }],
  },
  {
    name: "decide_proposal approve, then again",
    as: "founder",
    steps: [
      decide("approve"),
      decide("approve", { status: 409, code: "CONFLICT", schema: undefined }),
    ],
  },
  { name: "decide_proposal reject", as: "founder", steps: [decide("reject")] },
  {
    name: "decide_proposal on an unknown proposal",
    as: "founder",
    steps: [
      decide("approve", {
        path: () => "/v1/proposals/does-not-exist/decision",
        status: 404,
        code: "NOT_FOUND",
        schema: undefined,
      }),
    ],
  },
  {
    name: "decide_proposal as a non-founder",
    as: "non-founder",
    steps: [decide("approve", { status: 403, code: "FORBIDDEN", schema: undefined })],
  },
  {
    name: "decide_proposal signed out",
    as: "signed-out",
    steps: [decide("approve", { status: 401, code: "UNAUTHORIZED", schema: undefined })],
  },
  {
    name: "a write with a foreign Origin",
    as: "founder",
    steps: [
      decide("approve", {
        headers: { origin: "https://evil.example" },
        status: 403,
        code: "FORBIDDEN",
        schema: undefined,
      }),
    ],
  },
  {
    name: "a write whose body is not JSON",
    as: "founder",
    steps: [
      decide("approve", { body: "not json", status: 400, code: "BAD_REQUEST", schema: undefined }),
    ],
  },
  {
    name: "a non-founder write with a foreign Origin is the founder 403, not the origin one",
    as: "non-founder",
    steps: [
      decide("approve", {
        headers: { origin: "https://evil.example" },
        status: 403,
        code: "FORBIDDEN",
        kind: "forbidden",
        schema: undefined,
      }),
    ],
  },
  {
    name: "a non-founder write with a body that is not JSON is 403 before the body is read",
    as: "non-founder",
    steps: [
      decide("approve", {
        body: "not json",
        status: 403,
        code: "FORBIDDEN",
        kind: "forbidden",
        schema: undefined,
      }),
    ],
  },
  {
    name: "a founder write with a foreign Origin is untrusted-origin",
    as: "founder",
    steps: [
      decide("approve", {
        headers: { origin: "https://evil.example" },
        status: 403,
        code: "FORBIDDEN",
        kind: "untrusted-origin",
        schema: undefined,
      }),
    ],
  },
  {
    name: "decide_proposal with no decision is 400",
    as: "founder",
    steps: [decide("approve", { body: {}, status: 400, code: "BAD_REQUEST", schema: undefined })],
  },
  {
    name: "decide_proposal with an unknown decision is 400, before the proposal is looked up",
    as: "founder",
    steps: [
      decide("approve", {
        body: { decision: "maybe" },
        status: 400,
        code: "BAD_REQUEST",
        schema: undefined,
      }),
      decide("approve", {
        path: () => "/v1/proposals/does-not-exist/decision",
        body: { decision: "approved" },
        status: 400,
        code: "BAD_REQUEST",
        schema: undefined,
      }),
      decide("approve", {
        body: { decision: "approve", note: "x".repeat(2001) },
        status: 400,
        code: "BAD_REQUEST",
        schema: undefined,
      }),
      decide("approve", {
        body: { decision: "approve", note: 5 },
        status: 400,
        code: "BAD_REQUEST",
        schema: undefined,
      }),
      // none of the above decided it
      decide("reject"),
    ],
  },
  {
    name: "an unknown path",
    as: "founder",
    steps: [{ method: "GET", path: () => "/v1/nope", status: 404, code: "NOT_FOUND" }],
  },
  {
    name: "get-session with no cookie is 200 null",
    as: "signed-out",
    steps: [
      {
        method: "GET",
        path: () => "/api/auth/get-session",
        schema: sessionReplySchema,
        status: 200,
        code: null,
      },
    ],
  },
  {
    name: "get-session as a founder",
    as: "founder",
    steps: [
      {
        method: "GET",
        path: () => "/api/auth/get-session",
        schema: sessionReplySchema,
        status: 200,
        code: null,
      },
    ],
  },
  {
    name: "sign-out needs JSON",
    as: "founder",
    steps: [
      {
        method: "POST",
        path: () => "/api/auth/sign-out",
        body: "x",
        headers: { "content-type": "text/plain" },
        status: 415,
        code: "UNSUPPORTED_MEDIA_TYPE",
      },
    ],
  },
  {
    name: "sign-out with no content-type",
    as: "founder",
    steps: [
      {
        method: "POST",
        path: () => "/api/auth/sign-out",
        body: "{}",
        noContentType: true,
        status: 415,
        code: "UNSUPPORTED_MEDIA_TYPE",
      },
    ],
  },
  {
    name: "sign-out with a body that is not JSON",
    as: "founder",
    steps: [
      {
        method: "POST",
        path: () => "/api/auth/sign-out",
        body: "x",
        status: 400,
        code: "BAD_REQUEST",
      },
    ],
  },
  {
    name: "sign-out from a foreign Origin is INVALID_ORIGIN",
    as: "founder",
    steps: [
      {
        method: "POST",
        path: () => "/api/auth/sign-out",
        body: {},
        headers: { origin: "https://evil.example" },
        status: 403,
        code: "INVALID_ORIGIN",
      },
    ],
  },
  {
    name: "sign-out signs out",
    as: "founder",
    steps: [
      { method: "POST", path: () => "/api/auth/sign-out", body: {}, status: 200, code: null },
    ],
  },
  {
    name: "sign-in with a wrong password",
    as: "signed-out",
    steps: [
      {
        method: "POST",
        path: () => "/api/auth/sign-in/email",
        body: { email: "founder@example.com", password: "wrong-password-here" },
        status: 401,
        code: "INVALID_EMAIL_OR_PASSWORD",
      },
    ],
  },
  {
    name: "sign-in with the right password",
    as: "signed-out",
    steps: [
      {
        method: "POST",
        path: () => "/api/auth/sign-in/email",
        body: { email: "founder@example.com", password: PASSWORD },
        status: 200,
        code: null,
      },
    ],
  },
]

/** The status, error code and body keys of a reply: what the contract compares. */
async function observe(res: Response) {
  const text = await res.text()
  let body: unknown = null
  // `undefined`, not null, is what errorFromReply reads as "not JSON".
  let json: unknown
  try {
    body = JSON.parse(text)
    json = body
  } catch {
    body = null
  }
  return { status: res.status, body, json, text, headers: res.headers }
}

function errorCodeOf(body: unknown): string | null {
  const envelope = errorEnvelopeSchema.safeParse(body)
  if (envelope.success) return envelope.data.error.code
  const auth = authErrorSchema.safeParse(body)
  return auth.success ? (auth.data.code ?? null) : null
}

/** Every object key path of a JSON value, arrays flattened; null and scalars end a path. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => keyPaths(item, `${prefix}[]`))
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, child]) => [
    `${prefix}.${key}`,
    ...keyPaths(child, `${prefix}.${key}`),
  ])
}
const keySet = (value: unknown) => [...new Set(keyPaths(value))].sort()

interface Run {
  statuses: number[]
  codes: (string | null)[]
  kinds: (HqErrorKind | null)[]
  keys: string[][]
  parsed: boolean[]
}

async function runSteps(steps: Step[], send: typeof fetch, proposalId: string): Promise<Run> {
  const run: Run = { statuses: [], codes: [], kinds: [], keys: [], parsed: [] }
  for (const step of steps) {
    const init: RequestInit = { method: step.method, headers: { ...step.headers } }
    if (step.method === "POST" && step.body !== null) {
      const headers = init.headers as Record<string, string>
      if (!step.noContentType) headers["content-type"] ??= "application/json"
      init.body = typeof step.body === "string" ? step.body : JSON.stringify(step.body ?? {})
    }
    const seen = await observe(await send(`${BASE}${step.path({ proposalId })}`, init))
    run.statuses.push(seen.status)
    run.codes.push(errorCodeOf(seen.body))
    run.kinds.push(
      seen.status >= 400 ? errorFromReply(seen.status, seen.headers, seen.json).kind : null,
    )
    run.keys.push(keySet(seen.body))
    run.parsed.push(
      seen.status === 200 && step.schema ? step.schema.safeParse(seen.body).success : true,
    )
  }
  return run
}

describe("the fake of hq is as strict as hq", () => {
  let hq: Awaited<ReturnType<typeof createHqHarness>>
  const cookies = {} as Record<Caller, string>

  beforeAll(async () => {
    hq = await createHqHarness({ founderEmails: ["founder@example.com"] })
    cookies.founder = (await hq.signUp("founder@example.com")).cookie
    cookies["non-founder"] = (await hq.signUp("someone@example.com")).cookie
    cookies["signed-out"] = ""
    cookies.refused = ""
  })
  afterAll(async () => {
    await hq.close()
  })

  /** A session of its own, so a sign-out in one case does not end the next case's. */
  async function freshCookie(email: string): Promise<string> {
    const res = await hq.app.request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: BASE, "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    })
    expect(res.status).toBe(200)
    return res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0] ?? "")
      .filter((c) => !c.endsWith("="))
      .join("; ")
  }

  async function realProposal(): Promise<string> {
    const made = await hq.call({ cookie: cookies.founder }, "POST", "/v1/proposals", {
      kind: "fact",
      slug: `pricing-${Math.random().toString(36).slice(2, 8)}`,
      title: "Pricing",
      body: { text: "Free, then $20 per seat." },
      reason: "Stated in the founders call",
    })
    expect(made.status).toBe(200)
    return made.body.proposalId
  }

  it.each(scenarios)("$name", async ({ as, steps }) => {
    const proposalId = await realProposal()
    const cookie =
      as === "founder" || as === "non-founder"
        ? await freshCookie(as === "founder" ? "founder@example.com" : "someone@example.com")
        : ""
    const real = await runSteps(steps, harnessFetch(hq.app, cookie), proposalId)

    const fake = createFakeHq({ caller: as, proposals: [proposalFixture({ id: "proposal-1" })] })
    const faked = await runSteps(steps, fake.fetch, "proposal-1")

    const expected = {
      statuses: steps.map((s) => s.status),
      codes: steps.map((s) => s.code),
    }
    expect({ statuses: real.statuses, codes: real.codes }).toEqual(expected)
    expect({ statuses: faked.statuses, codes: faked.codes }).toEqual(expected)
    expect(real.parsed.every(Boolean)).toBe(true)
    expect(faked.parsed.every(Boolean)).toBe(true)
    expect(faked.keys).toEqual(real.keys)
    // The client tells a trusted-origin 403 from a founder 403 by message alone: compare kinds.
    expect(faked.kinds).toEqual(real.kinds)
    steps.forEach((step, i) => {
      if (step.kind) expect(real.kinds[i]).toBe(step.kind)
    })
  })

  it("a refused boot is 503 with a string error on every path, in the real lazy hq and the fake", async () => {
    const refusedApp = createLazyHq(
      async () => {
        throw new Error("boom")
      },
      { error: () => {} },
    )
    const fake = createFakeHq({ caller: "refused" })
    for (const path of ["/v1/status", "/api/auth/get-session", "/v1/proposals", "/v1/digest"]) {
      for (const send of [harnessFetch(refusedApp, ""), fake.fetch]) {
        const seen = await observe(await send(`${BASE}${path}`))
        expect(seen.status).toBe(503)
        expect(refusedBodySchema.safeParse(seen.body).success).toBe(true)
        expect(seen.text).toBe('{"error":"service unavailable"}')
        expect(errorCodeOf(seen.body)).toBeNull()
      }
    }
  })

  describe("the client reads both the same way", () => {
    const kindOf = async (call: Promise<unknown>): Promise<HqErrorKind | "ok"> =>
      call.then(
        () => "ok" as const,
        (error: { kind: HqErrorKind }) => error.kind,
      )

    async function clients(
      as: Caller,
    ): Promise<{ real: HqClient; fake: HqClient; fakeHq: FakeHq }> {
      const fakeHq = createFakeHq({
        caller: as,
        proposals: [proposalFixture({ id: "proposal-1" })],
      })
      return {
        real: createHqClient({ baseUrl: BASE, fetch: harnessFetch(hq.app, cookies[as]) }),
        fake: createHqClient({ baseUrl: BASE, fetch: fakeHq.fetch }),
        fakeHq,
      }
    }

    it("maps 401, 403 and 409 to the same kinds", async () => {
      const out = await clients("signed-out")
      expect(await kindOf(out.real.status())).toBe("unauthorized")
      expect(await kindOf(out.fake.status())).toBe("unauthorized")
      const non = await clients("non-founder")
      expect(await kindOf(non.real.status())).toBe("forbidden")
      expect(await kindOf(non.fake.status())).toBe("forbidden")

      const founder = await clients("founder")
      const proposalId = await realProposal()
      expect(await kindOf(founder.real.decideProposal({ proposalId, decision: "reject" }))).toBe(
        "ok",
      )
      expect(await kindOf(founder.real.decideProposal({ proposalId, decision: "reject" }))).toBe(
        "conflict",
      )
      expect(
        await kindOf(founder.fake.decideProposal({ proposalId: "proposal-1", decision: "reject" })),
      ).toBe("ok")
      expect(
        await kindOf(founder.fake.decideProposal({ proposalId: "proposal-1", decision: "reject" })),
      ).toBe("conflict")
    })

    it("a foreign Origin on a write is untrusted-origin, session() is null signed out", async () => {
      const foreign = harnessFetch(hq.app, cookies.founder)
      const send: typeof fetch = (input, init) =>
        foreign(input, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            origin: "https://evil.example",
          },
        })
      const real = createHqClient({ baseUrl: BASE, fetch: send })
      expect(await kindOf(real.decideProposal({ proposalId: "x", decision: "approve" }))).toBe(
        "untrusted-origin",
      )
      expect(await kindOf(real.signOut())).toBe("untrusted-origin")

      const out = await clients("signed-out")
      expect(await out.real.session()).toBeNull()
      expect(await out.fake.session()).toBeNull()
      const founder = await clients("founder")
      expect((await founder.real.session())?.email).toBe("founder@example.com")
      expect((await founder.fake.session())?.email).toBe(founder.fakeHq.state.user.email)
    })
  })
})

// hq's sign-in limiter is off in the harness (`rateLimit: false`), so these are the fake's own
// behaviours, pinned from a probe of the deployed hq: 5 sign-ins a minute, successes counted.
describe("the fake's sign-in rate limit (probed, not contract-tested)", () => {
  it("answers 429 with x-retry-after 60 and better-auth's body on the sixth sign-in", async () => {
    const fake = createFakeHq({ caller: "signed-out" })
    const signIn = () =>
      fake.fetch(`${BASE}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: fake.state.user.email, password: fake.state.password }),
      })
    for (let i = 0; i < 5; i++) expect((await signIn()).status).toBe(200)
    const limited = await signIn()
    expect(limited.status).toBe(429)
    expect(limited.headers.get("x-retry-after")).toBe("60")
    expect(await limited.json()).toEqual({ message: "Too many requests. Please try again later." })
  })
})

describe("get_policy: the fake answers as real hq does", () => {
  let hq: Awaited<ReturnType<typeof createHqHarness>>
  const cookies = {} as Record<Caller, string>
  beforeAll(async () => {
    hq = await createHqHarness({ founderEmails: ["founder@example.com"] })
    cookies.founder = (await hq.signUp("founder@example.com")).cookie
    cookies["non-founder"] = (await hq.signUp("someone@example.com")).cookie
    cookies["signed-out"] = ""
  })
  afterAll(async () => {
    await hq.close()
  })

  const policyStep = (status: number, code: string | null): Step => ({
    method: "GET",
    path: () => "/v1/policy",
    schema: status === 200 ? policySchema : undefined,
    status,
    code,
  })
  const policyCases: { as: Caller; status: number; code: string | null }[] = [
    { as: "founder", status: 200, code: null },
    { as: "non-founder", status: 403, code: "FORBIDDEN" },
    { as: "signed-out", status: 401, code: "UNAUTHORIZED" },
  ]

  it.each(policyCases)("$as GET /v1/policy is $status", async ({ as, status, code }) => {
    const real = await runSteps([policyStep(status, code)], harnessFetch(hq.app, cookies[as]), "")
    const fake = await runSteps([policyStep(status, code)], createFakeHq({ caller: as }).fetch, "")
    expect({ statuses: real.statuses, codes: real.codes }).toEqual({
      statuses: [status],
      codes: [code],
    })
    expect({ statuses: fake.statuses, codes: fake.codes }).toEqual({
      statuses: [status],
      codes: [code],
    })
    expect(real.parsed.every(Boolean)).toBe(true)
    expect(fake.parsed.every(Boolean)).toBe(true)
    expect(fake.keys).toEqual(real.keys)
    expect(fake.kinds).toEqual(real.kinds)
  })

  it("the fake's policy VALUES equal what real hq replies, not only the keys", async () => {
    const realReply = await harnessFetch(hq.app, cookies.founder)(`${BASE}/v1/policy`)
    const fakeReply = await createFakeHq().fetch(`${BASE}/v1/policy`)
    expect([realReply.status, fakeReply.status]).toEqual([200, 200])
    const real = policySchema.parse(await realReply.json())
    const fake = policySchema.parse(await fakeReply.json())
    expect(fake).toEqual(real)
    // The fixture is the single source the screens' tests read: it equals the real reply too.
    expect(policyFixture()).toEqual(real)
  })

  it("the client reads getPolicy the same way, and it is read-only on the wire", async () => {
    const kindOf = async (call: Promise<unknown>): Promise<HqErrorKind | "ok"> =>
      call.then(
        () => "ok" as const,
        (error: { kind: HqErrorKind }) => error.kind,
      )
    const expected: Record<Caller, HqErrorKind | "ok"> = {
      founder: "ok",
      "non-founder": "forbidden",
      "signed-out": "unauthorized",
      refused: "refused",
    }
    for (const as of ["founder", "non-founder", "signed-out"] as const) {
      const fake = createFakeHq({ caller: as })
      const real = createHqClient({ baseUrl: BASE, fetch: harnessFetch(hq.app, cookies[as]) })
      const faked = createHqClient({ baseUrl: BASE, fetch: fake.fetch })
      expect(await kindOf(real.getPolicy()), as).toBe(expected[as])
      expect(await kindOf(faked.getPolicy()), as).toBe(expected[as])
      expect(fake.sent.every((s) => s.method === "GET")).toBe(true)
    }
    // Only GET is a route: a write to /v1/policy is a 404 in both.
    const post = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    const real = await harnessFetch(hq.app, cookies.founder)(`${BASE}/v1/policy`, post)
    const fake = await createFakeHq().fetch(`${BASE}/v1/policy`, post)
    expect([real.status, fake.status]).toEqual([404, 404])
  })
})

// get_digest: the real operation over seeded rows and the fake over a fixture of the same shape,
// compared on status, error code, body keys and the client's error kind.
describe("the fake answers get_digest as hq does", () => {
  let hq: Awaited<ReturnType<typeof createHqHarness>>
  const cookies = {} as Record<Caller, string>
  const get = (path: string, status: number, code: string | null, schema?: z.ZodType): Step => ({
    method: "GET",
    path: () => path,
    schema,
    status,
    code,
  })
  const digestScenarios: Scenario[] = [
    {
      name: "founder get_digest",
      as: "founder",
      steps: [get("/v1/digest", 200, null, digestSchema)],
    },
    {
      name: "founder get_digest with a since inside the window",
      as: "founder",
      steps: [get("/v1/digest?since=2026-11-17T06:00:00Z", 200, null, digestSchema)],
    },
    {
      name: "get_digest with a since that is not a time is 400",
      as: "founder",
      steps: [get("/v1/digest?since=yesterday", 400, "BAD_REQUEST")],
    },
    {
      name: "get_digest with a since at hour 24 is 400",
      as: "founder",
      steps: [get("/v1/digest?since=2026-11-16T24:00:00Z", 400, "BAD_REQUEST")],
    },
    {
      name: "get_digest with a since on an impossible day is 400",
      as: "founder",
      steps: [get("/v1/digest?since=2026-02-30T00:00:00Z", 400, "BAD_REQUEST")],
    },
    {
      name: "get_digest with a since in the future is 400",
      as: "founder",
      steps: [get("/v1/digest?since=2999-01-01T00:00:00Z", 400, "BAD_REQUEST")],
    },
    {
      name: "signed-out get_digest",
      as: "signed-out",
      steps: [get("/v1/digest", 401, "UNAUTHORIZED")],
    },
    {
      name: "non-founder get_digest",
      as: "non-founder",
      steps: [get("/v1/digest", 403, "FORBIDDEN")],
    },
  ]

  beforeAll(async () => {
    hq = await createHqHarness({ founderEmails: ["founder@example.com"] })
    cookies.founder = (await hq.signUp("founder@example.com")).cookie
    cookies["non-founder"] = (await hq.signUp("someone@example.com")).cookie
    cookies["signed-out"] = ""
    // One finished run with spend and one pending proposal: every key digestFixture carries.
    await hq.db.insert(runs).values({
      id: "run-1",
      task: "Triage the inbox",
      trigger: "test",
      runner: "eve",
      startedAt: new Date("2026-11-17T08:00:00Z"),
      endedAt: new Date("2026-11-17T08:30:00Z"),
      outcome: "succeeded",
    })
    await hq.db.insert(spend).values({
      id: "spend-1",
      runId: "run-1",
      day: "2026-11-17",
      source: "eve",
      amountUsd: "0.4000",
      model: "haiku",
      estimated: false,
      createdAt: new Date("2026-11-17T08:10:00Z"),
    })
    await hq.db.insert(proposals).values({
      id: "proposal-1",
      kind: "fact",
      slug: "pricing",
      title: "Pricing",
      body: { text: "Free, then $20 per seat." },
      reason: "Stated in the founders call",
      status: "pending",
      proposedByType: "agent",
      proposedById: "agent-1",
      createdAt: new Date("2026-11-17T09:00:00Z"),
    })
  })
  afterAll(async () => {
    await hq.close()
  })

  it.each(digestScenarios)("$name", async ({ as, steps }) => {
    const real = await runSteps(steps, harnessFetch(hq.app, cookies[as]), "")
    const fake = createFakeHq({ caller: as })
    const faked = await runSteps(steps, fake.fetch, "")
    const expected = {
      statuses: steps.map((s) => s.status),
      codes: steps.map((s) => s.code),
    }
    expect({ statuses: real.statuses, codes: real.codes }).toEqual(expected)
    expect({ statuses: faked.statuses, codes: faked.codes }).toEqual(expected)
    expect(real.parsed.every(Boolean)).toBe(true)
    expect(faked.parsed.every(Boolean)).toBe(true)
    expect(faked.keys).toEqual(real.keys)
    expect(faked.kinds).toEqual(real.kinds)
  })

  it("the fake's whole-digest schema parses the real digest with a run, spend and a pending proposal", async () => {
    const res = await harnessFetch(hq.app, cookies.founder)(`${BASE}/v1/digest`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: unknown[]; decisions: unknown[]; spend: unknown }
    // the Phase 3 part is populated, so every nested key of it is checked, not only the empty lists
    expect(body.events.length).toBeGreaterThan(0)
    expect(body.decisions.length).toBeGreaterThan(0)
    expect(digestStrict.safeParse(body).success).toBe(true)
  })
})

// get_factory_status: the real operation over rows that make factoryStatusFixture, and the fake
// over the fixture, compared on status, error code, body keys and the client's error kind.
describe("the fake answers get_factory_status as hq does", () => {
  let hq: Awaited<ReturnType<typeof createHqHarness>>
  const cookies = {} as Record<Caller, string>
  const statusStep = (status: number, code: string | null): Step => ({
    method: "GET",
    path: () => "/v1/factory/status",
    schema: status === 200 ? factoryStatusSchema : undefined,
    status,
    code,
  })
  const cases: { as: Caller; status: number; code: string | null }[] = [
    { as: "founder", status: 200, code: null },
    { as: "non-founder", status: 403, code: "FORBIDDEN" },
    { as: "signed-out", status: 401, code: "UNAUTHORIZED" },
  ]

  beforeAll(async () => {
    hq = await createHqHarness({ founderEmails: ["founder@example.com"] })
    cookies.founder = (await hq.signUp("founder@example.com")).cookie
    cookies["non-founder"] = (await hq.signUp("someone@example.com")).cookie
    cookies["signed-out"] = ""
    // Rows that make factoryStatusFixture: one run on Eve that succeeded, $3.80 of Eve spend and
    // one pending proposal at the harness clock (2026-11-17T12:00:00Z).
    await hq.db.insert(runs).values({
      id: "run-1",
      task: "Triage the inbox",
      trigger: "test",
      runner: "eve",
      startedAt: new Date("2026-11-17T08:00:00Z"),
      endedAt: new Date("2026-11-17T08:30:00Z"),
      outcome: "succeeded",
    })
    await hq.db.insert(spend).values({
      id: "spend-1",
      runId: "run-1",
      day: "2026-11-17",
      source: "eve",
      amountUsd: "3.8000",
      model: "haiku",
      estimated: false,
      createdAt: new Date("2026-11-17T08:10:00Z"),
    })
    await hq.db.insert(proposals).values({
      id: "proposal-1",
      kind: "fact",
      slug: "pricing",
      title: "Pricing",
      body: { text: "Free, then $20 per seat." },
      reason: "Stated in the founders call",
      status: "pending",
      proposedByType: "agent",
      proposedById: "agent-1",
      createdAt: new Date("2026-11-17T09:00:00Z"),
    })
  })
  afterAll(async () => {
    await hq.close()
  })

  it.each(cases)("$as GET /v1/factory/status is $status", async ({ as, status, code }) => {
    const steps = [statusStep(status, code)]
    const real = await runSteps(steps, harnessFetch(hq.app, cookies[as]), "")
    const fake = await runSteps(steps, createFakeHq({ caller: as }).fetch, "")
    const expected = { statuses: [status], codes: [code] }
    expect({ statuses: real.statuses, codes: real.codes }).toEqual(expected)
    expect({ statuses: fake.statuses, codes: fake.codes }).toEqual(expected)
    expect(real.parsed.every(Boolean)).toBe(true)
    expect(fake.parsed.every(Boolean)).toBe(true)
    expect(fake.keys).toEqual(real.keys)
    expect(fake.kinds).toEqual(real.kinds)
  })

  it("the fixture is what real hq returns, value for value", async () => {
    const res = await harnessFetch(hq.app, cookies.founder)(`${BASE}/v1/factory/status`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(factoryStatusFixture())
  })

  it("a decision lowers pendingProposals by one in both", async () => {
    const decideReal = await harnessFetch(hq.app, cookies.founder)(
      `${BASE}/v1/proposals/proposal-1/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "reject" }),
      },
    )
    expect(decideReal.status).toBe(200)
    const real = (await (
      await harnessFetch(hq.app, cookies.founder)(`${BASE}/v1/factory/status`)
    ).json()) as { pendingProposals: number }

    const fake = createFakeHq({ proposals: [proposalFixture({ id: "proposal-1" })] })
    const client = createHqClient({ baseUrl: BASE, fetch: fake.fetch })
    await client.decideProposal({ proposalId: "proposal-1", decision: "reject" })
    const faked = await client.getFactoryStatus()
    expect(real.pendingProposals).toBe(0)
    expect(faked.pendingProposals).toBe(real.pendingProposals)
  })

  it("the client reads getFactoryStatus the same way, and it is read-only on the wire", async () => {
    const kindOf = async (call: Promise<unknown>): Promise<HqErrorKind | "ok"> =>
      call.then(
        () => "ok" as const,
        (error: { kind: HqErrorKind }) => error.kind,
      )
    const expected: Record<string, HqErrorKind | "ok"> = {
      founder: "ok",
      "non-founder": "forbidden",
      "signed-out": "unauthorized",
    }
    for (const as of ["founder", "non-founder", "signed-out"] as const) {
      const fake = createFakeHq({ caller: as })
      const real = createHqClient({ baseUrl: BASE, fetch: harnessFetch(hq.app, cookies[as]) })
      const faked = createHqClient({ baseUrl: BASE, fetch: fake.fetch })
      expect(await kindOf(real.getFactoryStatus()), as).toBe(expected[as])
      expect(await kindOf(faked.getFactoryStatus()), as).toBe(expected[as])
      expect(fake.sent.every((s) => s.method === "GET")).toBe(true)
    }
    // Only GET is a route: a write to /v1/factory/status is a 404 in both.
    const post = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
    const real = await harnessFetch(hq.app, cookies.founder)(`${BASE}/v1/factory/status`, post)
    const fake = await createFakeHq().fetch(`${BASE}/v1/factory/status`, post)
    expect([real.status, fake.status]).toEqual([404, 404])
  })

  it("a refused boot is 503 with a string error, in the real lazy hq and the fake", async () => {
    const refusedApp = createLazyHq(
      async () => {
        throw new Error("boom")
      },
      { error: () => {} },
    )
    const fake = createFakeHq({ caller: "refused" })
    for (const send of [harnessFetch(refusedApp, ""), fake.fetch]) {
      const seen = await observe(await send(`${BASE}/v1/factory/status`))
      expect(seen.status).toBe(503)
      expect(seen.text).toBe('{"error":"service unavailable"}')
      expect(errorFromReply(seen.status, seen.headers, seen.json).kind).toBe("refused")
    }
  })

  it("the fake refuses to answer with a status hq would never send", async () => {
    const good = factoryStatusFixture()
    const bad = [
      { ...good, extra: 1 },
      { ...good, runners: good.runners.slice(0, 2) },
      { ...good, runners: [...good.runners].reverse() },
      {
        ...good,
        runners: good.runners.map((r) =>
          r.runner === "box" ? { ...r, lastOutcome: "failed" as const } : r,
        ),
      },
      { ...good, allowance: { ...good.allowance, remainingUsd: -1 } },
    ]
    for (const factoryStatus of bad) {
      const fake = createFakeHq()
      fake.state.factoryStatus = factoryStatus as typeof good
      await expect(fake.fetch(`${BASE}/v1/factory/status`)).rejects.toThrow()
    }
    // Provoked on purpose: the setup's afterEach would otherwise fail this test.
    fakeViolations.length = 0
  })
})

// ---------------------------------------------------------------------------------------------
// The work pipeline (Phase 4). The real side is hq's app on PGlite with the board scripts/seed-work
// makes; the fake starts each case from the REAL replies (the board and every item), so the same
// request must answer the same status, error code, body keys, error kind and VALUES in both, and
// leave the same board, item and status counts behind. The agent's own routes (record_signal ...)
// are not in the fake on purpose: the app has no client method for them.
// ---------------------------------------------------------------------------------------------

const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

/**
 * A reply as a comparison reads it: every uuid is named by when it first appears, every time is
 * `<time>` (the real hq ticks a millisecond between the events of one request; the fake does not).
 */
function normalized(value: unknown): unknown {
  const names = new Map<string, string>()
  const name = (uuid: string) => {
    const key = uuid.toLowerCase()
    if (!names.has(key)) names.set(key, `<uuid ${names.size}>`)
    return names.get(key) as string
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      // a time anywhere in a string stays a time; a uuid inside a string (`manual:<uuid>`) is named
      return ISO_TIME.test(v) ? "<time>" : v.replace(UUID_ANYWHERE, name)
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v !== null && typeof v === "object") {
      // keys in one order, so a name does not depend on how a database ordered a jsonb object
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, walk(x)]),
      )
    }
    return v
  }
  return walk(value)
}

/**
 * A list of items in one order: hq lists newest first by (createdAt, id) and a seed creates every
 * item at one instant, so the order among them is the order of random ids. By number then.
 */
function listsByNumber(body: unknown): unknown {
  const items = (body as { items?: { number: number }[] } | null)?.items
  if (!Array.isArray(items)) return body
  return { ...(body as object), items: [...items].sort((a, b) => b.number - a.number) }
}

/** A key path without what depends on the data: an event's free-form `detail`. */
const structural = (paths: string[]) => paths.filter((p) => !/\.detail\./.test(p))

type Mode = "label" | "claim"
type Ids = Record<
  | "triage"
  | "asking"
  | "exhausted"
  | "review"
  | "verifying"
  | "done"
  | "building"
  | "planned"
  | "question"
  | "question2"
  | "sha",
  string
>

interface WorkStep {
  method: "GET" | "POST"
  path: (ids: Ids) => string
  body?: unknown
  headers?: Record<string, string>
  /** `null`: send no body. */
  status: number | ((mode: Mode) => number)
  code: string | null | ((mode: Mode) => string | null)
  kind?: HqErrorKind
}
interface WorkCase {
  name: string
  as: Caller
  steps: WorkStep[]
  /** Items whose detail the case changes: compared after, with the board and the status. */
  touches?: (keyof Ids)[]
  /** Change the real hq before the fake is made from it (the fake has no agent routes). */
  setup?: (ctx: {
    ids: Ids
    /** An agent's question on an item, asked through hq's own `ask_question`; its id. */
    ask: (itemId: string) => Promise<string>
  }) => Promise<void>
}

const item =
  (key: keyof Ids, tail = "") =>
  (ids: Ids) =>
    `/v1/work-items/${ids[key]}${tail}`
/** Claim mode answers `status`/`code`; label mode refuses request_attempt (400) or, say, answers 200. */
const claimOnly = (
  status: number,
  code: string | null,
  labelStatus = 400,
  labelCode: string | null = "BAD_REQUEST",
): Pick<WorkStep, "status" | "code"> => ({
  status: (mode) => (mode === "label" ? labelStatus : status),
  code: (mode) => (mode === "label" ? labelCode : code),
})

const ok: Pick<WorkStep, "status" | "code"> = { status: 200, code: null }
const conflict: Pick<WorkStep, "status" | "code"> = { status: 409, code: "CONFLICT" }
const badRequest: Pick<WorkStep, "status" | "code"> = { status: 400, code: "BAD_REQUEST" }
const notFound: Pick<WorkStep, "status" | "code"> = { status: 404, code: "NOT_FOUND" }

const workCases: WorkCase[] = [
  {
    name: "get_work_board, list_work_items and get_work_item as a founder",
    as: "founder",
    steps: [
      { method: "GET", path: () => "/v1/work/board", ...ok },
      { method: "GET", path: () => "/v1/work-items", ...ok },
      { method: "GET", path: () => "/v1/work-items?state=triage&limit=5", ...ok },
      { method: "GET", path: () => "/v1/work-items?state=review&limit=1", ...ok },
      { method: "GET", path: () => "/v1/work-items?query=export", ...ok },
      { method: "GET", path: () => "/v1/work-items?pullRequestNumber=106&repo=acme/web", ...ok },
      { method: "GET", path: item("review"), ...ok },
      { method: "GET", path: () => "/v1/work-items/FAC-6", ...ok },
      { method: "GET", path: item("verifying"), ...ok },
    ],
  },
  {
    name: "the reads refuse a bad reference, a bad filter and an unknown item",
    as: "founder",
    steps: [
      { method: "GET", path: () => "/v1/work-items/nope", ...badRequest },
      { method: "GET", path: () => "/v1/work-items/FAC-0", ...badRequest },
      { method: "GET", path: () => "/v1/work-items/FAC-999", ...notFound },
      {
        method: "GET",
        path: () => "/v1/work-items/11111111-1111-4111-8111-111111111111",
        ...notFound,
      },
      { method: "GET", path: () => "/v1/work-items?state=paused", ...badRequest },
      { method: "GET", path: () => "/v1/work-items?limit=0", ...badRequest },
      { method: "GET", path: () => "/v1/work-items?limit=101", ...badRequest },
      { method: "GET", path: () => "/v1/work-items?cursor=not-a-cursor", ...badRequest },
    ],
  },
  ...(["signed-out", "non-founder"] as const).map((as): WorkCase => {
    const refused =
      as === "signed-out"
        ? { status: 401, code: "UNAUTHORIZED" }
        : { status: 403, code: "FORBIDDEN" }
    const kind = as === "signed-out" ? "unauthorized" : "forbidden"
    return {
      name: `every work route as a ${as} caller`,
      as,
      steps: (
        [
          { method: "GET", path: () => "/v1/work/board" },
          { method: "GET", path: () => "/v1/work-items" },
          { method: "GET", path: item("review") },
          { method: "POST", path: () => "/v1/work-items", body: { title: "x", repo: "acme/web" } },
          {
            method: "POST",
            path: item("triage", "/attempt-requests"),
            body: { kind: "investigate" },
          },
          {
            method: "POST",
            path: (ids) => `/v1/questions/${ids.question}/answer`,
            body: { optionId: "up" },
          },
          { method: "POST", path: item("review", "/merge-approval"), body: { headSha: "aaaaaaa" } },
          { method: "POST", path: item("triage", "/stop"), body: {} },
          { method: "POST", path: item("done", "/reopen"), body: {} },
          { method: "POST", path: item("exhausted", "/retry"), body: { note: "again" } },
          { method: "POST", path: item("done", "/revert-request"), body: {} },
        ] satisfies Pick<WorkStep, "method" | "path" | "body">[]
      ).map((step) => ({
        ...step,
        ...refused,
        kind,
      })),
    }
  }),
  {
    name: "a founder write with a foreign Origin is untrusted-origin, before the body is read",
    as: "founder",
    steps: [
      {
        method: "POST",
        path: item("triage", "/stop"),
        body: "not json",
        headers: { origin: "https://evil.example" },
        status: 403,
        code: "FORBIDDEN",
        kind: "untrusted-origin",
      },
      {
        method: "POST",
        path: item("review", "/merge-approval"),
        body: { headSha: "aaaaaaa" },
        headers: { origin: "https://evil.example" },
        status: 403,
        code: "FORBIDDEN",
        kind: "untrusted-origin",
      },
    ],
  },
  {
    name: "a non-founder write with a foreign Origin is the founder 403, not the origin one",
    as: "non-founder",
    steps: [
      {
        method: "POST",
        path: item("triage", "/stop"),
        body: {},
        headers: { origin: "https://evil.example" },
        status: 403,
        code: "FORBIDDEN",
        kind: "forbidden",
      },
    ],
  },
  {
    name: "a founder write whose body is not JSON, or not an object, is 400",
    as: "founder",
    steps: [
      { method: "POST", path: item("triage", "/stop"), body: "not json", ...badRequest },
      { method: "POST", path: item("triage", "/stop"), body: "[1]", ...badRequest },
      { method: "POST", path: () => "/v1/work-items", body: "not json", ...badRequest },
    ],
  },
  {
    name: "the write routes refuse a bad input before they look the item up",
    as: "founder",
    steps: [
      {
        method: "POST",
        path: () => "/v1/work-items/FAC-999/stop",
        body: { note: 5 },
        ...badRequest,
      },
      { method: "POST", path: () => "/v1/work-items/nope/stop", body: {}, ...badRequest },
      { method: "POST", path: item("review", "/merge-approval"), body: {}, ...badRequest },
      {
        method: "POST",
        path: item("review", "/merge-approval"),
        body: { headSha: "xyz" },
        ...badRequest,
      },
      {
        method: "POST",
        path: item("review", "/merge-approval"),
        body: { headSha: "a".repeat(65) },
        ...badRequest,
      },
      {
        method: "POST",
        path: () => "/v1/work-items/FAC-999/merge-approval",
        body: { headSha: "abc" },
        ...badRequest,
      },
      { method: "POST", path: item("exhausted", "/retry"), body: {}, ...badRequest },
      { method: "POST", path: item("exhausted", "/retry"), body: { note: "" }, ...badRequest },
      { method: "POST", path: item("exhausted", "/retry"), body: { note: "   " }, ...badRequest },
      {
        method: "POST",
        path: item("triage", "/stop"),
        body: { note: "x".repeat(2001) },
        ...badRequest,
      },
      {
        method: "POST",
        path: item("triage", "/attempt-requests"),
        body: { kind: "build" },
        ...badRequest,
      },
      {
        method: "POST",
        path: () => "/v1/questions/not-a-uuid/answer",
        body: { optionId: "up" },
        ...badRequest,
      },
      {
        method: "POST",
        path: (ids) => `/v1/questions/${ids.question}/answer`,
        body: {},
        ...badRequest,
      },
      {
        method: "POST",
        path: () => "/v1/work-items",
        body: { title: "", repo: "acme/web" },
        ...badRequest,
      },
      {
        method: "POST",
        path: () => "/v1/work-items",
        body: { title: "x", repo: "not a repo" },
        ...badRequest,
      },
      { method: "POST", path: () => "/v1/work-items", body: { title: "x" }, ...badRequest },
      {
        method: "POST",
        path: () => "/v1/work-items",
        body: { title: "   ", repo: "acme/web" },
        ...badRequest,
      },
      {
        method: "POST",
        path: () => "/v1/work-items",
        body: { title: "x", repo: "acme/web", body: "y".repeat(20_001) },
        ...badRequest,
      },
    ],
  },
  {
    name: "unknown items and questions are 404 on every write",
    as: "founder",
    steps: [
      { method: "POST", path: () => "/v1/work-items/FAC-999/stop", body: {}, ...notFound },
      { method: "POST", path: () => "/v1/work-items/FAC-999/reopen", body: {}, ...notFound },
      {
        method: "POST",
        path: () => "/v1/work-items/FAC-999/retry",
        body: { note: "x" },
        ...notFound,
      },
      {
        method: "POST",
        path: () => "/v1/work-items/FAC-999/revert-request",
        body: {},
        ...notFound,
      },
      {
        method: "POST",
        path: () => "/v1/work-items/FAC-999/merge-approval",
        body: { headSha: "abcdef0" },
        ...notFound,
      },
      {
        method: "POST",
        path: () => "/v1/questions/11111111-1111-4111-8111-111111111111/answer",
        body: { optionId: "up" },
        ...notFound,
      },
      {
        // label mode refuses (400) before it looks the item up, claim mode says 404
        method: "POST",
        path: () => "/v1/work-items/FAC-999/attempt-requests",
        body: { kind: "fix" },
        status: (mode) => (mode === "label" ? 400 : 404),
        code: (mode) => (mode === "label" ? "BAD_REQUEST" : "NOT_FOUND"),
      },
    ],
  },
  {
    name: "approve_merge: 200, then the same approval again is 409, and an old head is 409 too",
    as: "founder",
    touches: ["review"],
    steps: [
      {
        method: "POST",
        path: item("review", "/merge-approval"),
        body: { headSha: "0123abc" },
        ...conflict,
      },
      {
        method: "POST",
        path: item("review", "/merge-approval"),
        body: { headSha: "SHA", note: "ship it" },
        ...ok,
      },
      {
        method: "POST",
        path: item("review", "/merge-approval"),
        body: { headSha: "SHA" },
        ...conflict,
      },
      {
        method: "POST",
        path: item("review", "/merge-approval"),
        body: { headSha: "0123abc" },
        ...conflict,
      },
      {
        method: "POST",
        path: item("verifying", "/merge-approval"),
        body: { headSha: "0123abc" },
        ...conflict,
      },
    ],
  },
  {
    name: "approve_merge lower-cases the head it is sent",
    as: "founder",
    touches: ["review"],
    steps: [
      {
        method: "POST",
        path: item("review", "/merge-approval"),
        body: { headSha: "UPPER" },
        ...ok,
      },
    ],
  },
  {
    name: "answer_question: 200, then 409; an option that is not one is 400",
    as: "founder",
    touches: ["asking"],
    steps: [
      {
        method: "POST",
        path: (ids) => `/v1/questions/${ids.question}/answer`,
        body: { optionId: "zzz" },
        ...badRequest,
      },
      {
        method: "POST",
        path: (ids) => `/v1/questions/${ids.question}/answer`,
        body: { optionId: "even", note: "match the ledger" },
        ...ok,
      },
      {
        method: "POST",
        path: (ids) => `/v1/questions/${ids.question}/answer`,
        body: { optionId: "up" },
        ...conflict,
      },
    ],
  },
  {
    name: "stop_work_item: 200, then 409 for a stopped one, and for a done one",
    as: "founder",
    touches: ["triage", "done"],
    steps: [
      { method: "POST", path: item("triage", "/stop"), body: { note: "not now" }, ...ok },
      { method: "POST", path: item("triage", "/stop"), body: {}, ...conflict },
      { method: "POST", path: item("done", "/stop"), body: {}, ...conflict },
    ],
  },
  {
    name: "stop_work_item on an item with a pending approval and an open question voids and withdraws",
    as: "founder",
    touches: ["review", "asking"],
    steps: [
      { method: "POST", path: item("review", "/stop"), body: {}, ...ok },
      { method: "POST", path: item("asking", "/stop"), body: {}, ...ok },
    ],
  },
  {
    name: "reopen_work_item: a stopped item goes back to triage, a done or verifying one to reopened, others 409",
    as: "founder",
    touches: ["triage", "done", "verifying"],
    steps: [
      { method: "POST", path: item("triage", "/reopen"), body: {}, ...conflict },
      { method: "POST", path: item("triage", "/stop"), body: {}, ...ok },
      { method: "POST", path: item("triage", "/reopen"), body: { note: "again" }, ...ok },
      { method: "POST", path: item("done", "/reopen"), body: {}, ...ok },
      { method: "POST", path: item("done", "/reopen"), body: {}, ...conflict },
      { method: "POST", path: item("verifying", "/reopen"), body: {}, ...ok },
      { method: "POST", path: item("review", "/reopen"), body: {}, ...conflict },
    ],
  },
  {
    name: "a stopped item reopened into triage starts a fresh cycle: its contract, window, pull request and fix attempts are the new cycle's",
    as: "founder",
    touches: ["exhausted", "review", "verifying", "asking", "building"],
    steps: (["exhausted", "review", "verifying", "asking", "building"] as const).flatMap((key) => [
      { method: "POST" as const, path: item(key, "/stop"), body: { note: "pause it" }, ...ok },
      { method: "POST" as const, path: item(key, "/reopen"), body: { note: "back" }, ...ok },
    ]),
  },
  {
    name: "the founder writes refuse a foreign Origin, all eight, before the body is read",
    as: "founder",
    steps: (
      [
        () => "/v1/work-items",
        item("triage", "/attempt-requests"),
        (ids: Ids) => `/v1/questions/${ids.question}/answer`,
        item("review", "/merge-approval"),
        item("triage", "/stop"),
        item("done", "/reopen"),
        item("exhausted", "/retry"),
        item("done", "/revert-request"),
      ] satisfies ((ids: Ids) => string)[]
    ).map(
      (path): WorkStep => ({
        method: "POST",
        path,
        body: "not json",
        headers: { origin: "https://evil.example" },
        status: 403,
        code: "FORBIDDEN",
        kind: "untrusted-origin",
      }),
    ),
  },
  {
    name: "reopen and revert refuse a bad input before they look the item up",
    as: "founder",
    steps: [
      {
        method: "POST",
        path: () => "/v1/work-items/FAC-999/reopen",
        body: { note: 5 },
        ...badRequest,
      },
      { method: "POST", path: () => "/v1/work-items/nope/reopen", body: {}, ...badRequest },
      {
        method: "POST",
        path: item("done", "/reopen"),
        body: { note: "x".repeat(2001) },
        ...badRequest,
      },
      {
        method: "POST",
        path: () => "/v1/work-items/FAC-999/revert-request",
        body: { note: 5 },
        ...badRequest,
      },
      { method: "POST", path: () => "/v1/work-items/nope/revert-request", body: {}, ...badRequest },
      {
        method: "POST",
        path: item("done", "/revert-request"),
        body: { note: "x".repeat(2001) },
        ...badRequest,
      },
      {
        method: "POST",
        path: () => "/v1/work-items/FAC-999/reopen",
        body: "not json",
        ...badRequest,
      },
      {
        method: "POST",
        path: () => "/v1/work-items/FAC-999/revert-request",
        body: "[1]",
        ...badRequest,
      },
    ],
  },
  {
    name: "approve_merge on an item that also has an open question: the question still counts in the status",
    as: "founder",
    touches: ["review"],
    setup: async ({ ids, ask }) => {
      ids.question2 = await ask(ids.review)
    },
    steps: [
      { method: "POST", path: item("review", "/merge-approval"), body: { headSha: "SHA" }, ...ok },
    ],
  },
  {
    name: "retry_work_item: 200 for an exhausted item, then 409; an item with attempts left is 409",
    as: "founder",
    touches: ["exhausted"],
    steps: [
      { method: "POST", path: item("triage", "/retry"), body: { note: "x" }, ...conflict },
      { method: "POST", path: item("exhausted", "/retry"), body: { note: "one more try" }, ...ok },
      {
        method: "POST",
        path: item("exhausted", "/retry"),
        body: { note: "and another" },
        ...conflict,
      },
    ],
  },
  {
    name: "request_revert: a merged item reopens, then 409; an unmerged one is 409",
    as: "founder",
    touches: ["done", "review"],
    steps: [
      { method: "POST", path: item("review", "/revert-request"), body: {}, ...conflict },
      {
        method: "POST",
        path: item("done", "/revert-request"),
        body: { note: "it broke checkout" },
        ...ok,
      },
      { method: "POST", path: item("done", "/revert-request"), body: {}, ...conflict },
    ],
  },
  {
    name: "request_attempt: refused in label mode with the label instruction, one attempt in claim mode, then 409",
    as: "founder",
    touches: ["triage"],
    steps: [
      {
        method: "POST",
        path: item("triage", "/attempt-requests"),
        body: { kind: "investigate", instructions: "start with the cart" },
        status: (mode) => (mode === "label" ? 400 : 200),
        code: (mode) => (mode === "label" ? "BAD_REQUEST" : null),
      },
      {
        method: "POST",
        path: item("triage", "/attempt-requests"),
        body: { kind: "investigate" },
        status: (mode) => (mode === "label" ? 400 : 409),
        code: (mode) => (mode === "label" ? "BAD_REQUEST" : "CONFLICT"),
      },
    ],
  },
  {
    name: "request_attempt refuses by hq's own start rules: the state, one active attempt, the fix budget",
    as: "founder",
    touches: ["triage", "done", "building", "exhausted", "planned"],
    steps: [
      // a fix cannot start from triage, nothing starts from done, a running attempt blocks the item
      {
        method: "POST",
        path: item("triage", "/attempt-requests"),
        body: { kind: "fix" },
        ...claimOnly(409, "CONFLICT"),
      },
      {
        method: "POST",
        path: item("done", "/attempt-requests"),
        body: { kind: "investigate" },
        ...claimOnly(409, "CONFLICT"),
      },
      {
        method: "POST",
        path: item("building", "/attempt-requests"),
        body: { kind: "fix" },
        ...claimOnly(409, "CONFLICT"),
      },
      {
        method: "POST",
        path: item("building", "/attempt-requests"),
        body: { kind: "investigate" },
        ...claimOnly(409, "CONFLICT"),
      },
      // the exhausted item has no fix left (its state allows one), a planned item takes either kind
      {
        method: "POST",
        path: item("exhausted", "/attempt-requests"),
        body: { kind: "fix" },
        ...claimOnly(409, "CONFLICT"),
      },
      {
        method: "POST",
        path: item("planned", "/attempt-requests"),
        body: { kind: "investigate" },
        ...claimOnly(200, null),
      },
    ],
  },
  {
    name: "answer_question where an attempt is already running keeps the answer and replies with hq's refusal (claim dispatch)",
    as: "founder",
    touches: ["building"],
    setup: async ({ ids, ask }) => {
      ids.question2 = await ask(ids.building)
    },
    steps: [
      {
        method: "POST",
        path: (ids) => `/v1/questions/${ids.question2}/answer`,
        body: { optionId: "b", note: "the second one" },
        ...claimOnly(409, "CONFLICT", 200, null),
      },
      {
        method: "POST",
        path: (ids) => `/v1/questions/${ids.question2}/answer`,
        body: { optionId: "a" },
        ...conflict,
      },
    ],
  },
  {
    name: "create_work_item: a manual item in triage, with and without a body",
    as: "founder",
    touches: [],
    steps: [
      {
        method: "POST",
        path: () => "/v1/work-items",
        body: {
          title: "Dark mode is unreadable",
          repo: "acme/api",
          body: "The   contrast\nis too low on the settings page.",
        },
        ...ok,
      },
      {
        method: "POST",
        path: () => "/v1/work-items",
        body: { title: "No body", repo: "acme/web" },
        ...ok,
      },
    ],
  },
]

/** A step's status and code for this mode. */
const resolve = <T>(value: T | ((mode: Mode) => T), mode: Mode): T =>
  typeof value === "function" ? (value as (mode: Mode) => T)(mode) : value

describe.each(["label", "claim"] as const)(
  "the fake answers the work routes as hq does (%s dispatch)",
  (mode) => {
    let hq: Awaited<ReturnType<typeof createHqHarness>>
    const cookies = {} as Record<Caller, string>
    let founderId = ""
    let ids: Ids

    const readJson = async (path: string): Promise<unknown> => {
      const res = await harnessFetch(hq.app, cookies.founder)(`${BASE}${path}`)
      expect(res.status, path).toBe(200)
      return res.json()
    }

    beforeAll(async () => {
      hq = await createHqHarness({ founderEmails: ["founder@example.com"], dispatchMode: mode })
      const founder = await hq.signUp("founder@example.com")
      founderId = founder.userId
      cookies.founder = founder.cookie
      cookies["non-founder"] = (await hq.signUp("someone@example.com")).cookie
      cookies["signed-out"] = ""
    })
    afterAll(async () => {
      await hq.close()
    })
    // Every case starts from a freshly seeded pipeline: the cases change it.
    beforeEach(async () => {
      await resetWork(hq.db)
      const seeded = await seedWork({
        baseUrl: BASE,
        cookie: cookies.founder,
        fetch: harnessFetch(hq.app, cookies.founder),
      })
      const board = workBoardSchema.parse(await readJson("/v1/work/board"))
      const all = board.columns.flatMap((c) => c.items)
      const byDisplay = (displayId: string | undefined) => {
        const found = all.find((i) => i.displayId === displayId)
        if (!found) throw new Error(`seed left no ${displayId}`)
        return found.id
      }
      const review = workItemDetailSchema.parse(
        await readJson(`/v1/work-items/${byDisplay(seeded.ids.pendingMerge)}`),
      )
      ids = {
        triage: byDisplay(seeded.ids.triage),
        asking: byDisplay(seeded.ids.asking),
        exhausted: byDisplay(seeded.ids.exhausted),
        review: review.id,
        verifying: byDisplay(seeded.ids.verifyingLate),
        done: byDisplay(seeded.ids.done),
        building: byDisplay(seeded.ids.building),
        planned: byDisplay(seeded.ids.planned),
        question2: "",
        question:
          board.needsYou.find((n) => n.kind === "agent_question")?.question?.questionId ?? "",
        sha: review.pullRequest?.headSha ?? "",
      }
    })

    /** A fake that starts exactly where the real hq is now, who it signs in as included. */
    async function fakeFromReal(as: Caller): Promise<FakeHq> {
      const board = workBoardSchema.parse(await readJson("/v1/work/board"))
      const listed = workItemsPageSchema.parse(await readJson("/v1/work-items?limit=100"))
      const items = Object.fromEntries(
        await Promise.all(
          listed.items.map(async (i) => [
            i.id,
            workItemDetailSchema.parse(await readJson(`/v1/work-items/${i.id}`)),
          ]),
        ),
      )
      const status = (await readJson("/v1/factory/status")) as FakeHqState["factoryStatus"]
      return createFakeHq({
        caller: as,
        user: { id: founderId, email: "founder@example.com", name: "founder@example.com" },
        workBoard: board,
        workItems: items,
        factoryStatus: status,
      })
    }

    const substitute = (text: string) =>
      text.replaceAll("SHA", ids.sha).replaceAll("UPPER", ids.sha.toUpperCase())

    /** The schema the client parses a 200 reply of this request with. */
    const replySchemaFor = (method: string, path: string): z.ZodType | null => {
      const url = path.split("?")[0] ?? path
      if (method === "GET") {
        if (url === "/v1/work/board") return workBoardSchema
        if (url === "/v1/work-items") return workItemsPageSchema
        return /^\/v1\/work-items\/[^/]+$/.test(url) ? workItemDetailSchema : null
      }
      if (url === "/v1/work-items") return createdWorkItemSchema
      if (url.endsWith("/attempt-requests")) return attemptViewSchema
      if (url.endsWith("/answer")) return questionViewSchema
      if (url.endsWith("/merge-approval")) return mergeApprovalReplySchema
      if (url.endsWith("/stop")) return stoppedReplySchema
      if (url.endsWith("/reopen")) return stateReplySchema
      if (url.endsWith("/retry")) return retryReplySchema
      if (url.endsWith("/revert-request")) return revertReplySchema
      return null
    }

    async function run(steps: WorkStep[], send: typeof fetch) {
      const out: {
        status: number
        code: string | null
        kind: HqErrorKind | null
        keys: string[]
        body: unknown
        schemaOk: boolean
      }[] = []
      for (const step of steps) {
        const init: RequestInit = { method: step.method, headers: { ...step.headers } }
        if (step.method === "POST" && step.body !== undefined) {
          ;(init.headers as Record<string, string>)["content-type"] ??= "application/json"
          init.body = substitute(
            typeof step.body === "string" ? step.body : JSON.stringify(step.body),
          )
        }
        const path = step.path(ids)
        const seen = await observe(await send(`${BASE}${path}`, init))
        const schema = seen.status === 200 ? replySchemaFor(step.method, path) : null
        if (seen.status === 200 && !schema) throw new Error(`no reply schema for ${path}`)
        out.push({
          status: seen.status,
          code: errorCodeOf(seen.body),
          kind:
            seen.status >= 400 ? errorFromReply(seen.status, seen.headers, seen.json).kind : null,
          keys: structural(keySet(seen.body)),
          body: normalized(listsByNumber(seen.body)),
          schemaOk: schema ? schema.safeParse(seen.body).success : true,
        })
      }
      return out
    }

    /** An event as a comparison reads it: everything but its own id and its time. */
    const eventView = (e: Record<string, unknown>) => {
      const { id: _id, at: _at, ...rest } = e
      return rest
    }
    /** Events in one order (hq's ticks of a millisecond order them, the fake's do not). */
    const sortedEvents = (events: Record<string, unknown>[]) => {
      const mask = (e: Record<string, unknown>) =>
        JSON.stringify(eventView(e)).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, "<uuid>")
      return events.map(eventView).sort((a, b) => mask(a).localeCompare(mask(b)))
    }

    /**
     * What a case leaves behind, as one comparison reads it: the board, the status, each touched
     * item and the NEW events of each (every event the case wrote, by kind, states, actor, reason,
     * note, detail and cycle), and the items the case created, whole.
     */
    async function afterwards(
      read: (path: string) => Promise<unknown>,
      touches: (keyof Ids)[],
      before: { items: Set<string>; events: Set<string> },
    ) {
      type Detail = { id: string; number: number; events: Record<string, unknown>[] }
      const item = async (key: keyof Ids) => {
        const { events, ...rest } = (await read(`/v1/work-items/${ids[key]}`)) as Detail
        return {
          detail: normalized(rest),
          events: normalized(sortedEvents(events.filter((e) => !before.events.has(String(e.id))))),
        }
      }
      const touched = await Promise.all(touches.map(async (k) => [k, await item(k)] as const))
      const listed = (await read("/v1/work-items?limit=100")) as { items: Detail[] }
      const made = await Promise.all(
        listed.items
          .filter((i) => !before.items.has(i.id))
          .sort((a, b) => a.number - b.number)
          .map(async (i) => {
            const { events, ...rest } = (await read(`/v1/work-items/${i.id}`)) as Detail
            return normalized({ ...rest, events: sortedEvents(events) })
          }),
      )
      return {
        board: normalized(await read("/v1/work/board")),
        status: normalized(await read("/v1/factory/status")),
        items: Object.fromEntries(touched.map(([k, v]) => [k, v.detail])),
        events: Object.fromEntries(touched.map(([k, v]) => [k, v.events])),
        created: made,
      }
    }

    it.each(workCases)("$name", async (testCase) => {
      const { as, steps, touches = [] } = testCase
      await testCase.setup?.({
        ids,
        ask: async (itemId) => {
          const res = await harnessFetch(hq.app, cookies.founder)(
            `${BASE}/v1/work-items/${itemId}/questions`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                prompt: "Which of the two?",
                options: [
                  { id: "a", label: "The first" },
                  { id: "b", label: "The second" },
                ],
              }),
            },
          )
          expect(res.status).toBe(200)
          return ((await res.json()) as { id: string }).id
        },
      })
      const fake = await fakeFromReal(as)
      const before = {
        items: new Set(Object.keys(fake.state.workItems)),
        events: new Set(
          Object.values(fake.state.workItems).flatMap((i) => i.events.map((e) => e.id)),
        ),
      }
      const send = harnessFetch(hq.app, cookies[as])
      const real = await run(steps, send)
      const faked = await run(steps, fake.fetch)

      expect(real.map((r) => [r.status, r.code])).toEqual(
        steps.map((s) => [resolve(s.status, mode), resolve(s.code, mode)]),
      )
      expect(faked.map((r) => [r.status, r.code])).toEqual(real.map((r) => [r.status, r.code]))
      expect(faked.map((r) => r.keys)).toEqual(real.map((r) => r.keys))
      expect(faked.map((r) => r.kind)).toEqual(real.map((r) => r.kind))
      // every 200 reply parses with the schema the client reads it with, in both
      expect(real.every((r) => r.schemaOk)).toBe(true)
      expect(faked.every((r) => r.schemaOk)).toBe(true)
      // VALUES, not only keys: every reply, ids and times named
      expect(faked.map((r) => r.body)).toEqual(real.map((r) => r.body))
      steps.forEach((step, i) => {
        if (step.kind) expect(real[i]?.kind).toBe(step.kind)
      })

      if (as !== "founder") return
      const readFake = async (path: string) => {
        const res = await fake.fetch(`${BASE}${path}`)
        expect(res.status, path).toBe(200)
        return res.json()
      }
      const left = await afterwards(readFake, touches, before)
      const right = await afterwards(readJson, touches, before)
      expect(left.board).toEqual(right.board)
      expect(left.status).toEqual(right.status)
      expect(left.items).toEqual(right.items)
      expect(left.events).toEqual(right.events)
      expect(left.created).toEqual(right.created)
      expect(fakeViolations).toEqual([])
    })

    it("the client reads both the same way: values, error kinds, statuses, codes and hq's own messages", async () => {
      const fake = await fakeFromReal("founder")
      const real = createHqClient({
        baseUrl: BASE,
        fetch: harnessFetch(hq.app, cookies.founder),
      })
      const faked = createHqClient({ baseUrl: BASE, fetch: fake.fetch })
      const calls = (c: HqClient): (() => Promise<unknown>)[] => [
        () => c.approveMerge({ itemId: ids.review, headSha: ids.sha, note: "ship it" }),
        () => c.approveMerge({ itemId: ids.review, headSha: ids.sha }),
        () => c.stopWorkItem({ itemId: ids.triage }),
        () => c.reopenWorkItem({ itemId: ids.triage }),
        () => c.retryWorkItem({ itemId: ids.exhausted, note: "once more" }),
        () => c.requestRevert({ itemId: ids.done, note: "broke it" }),
        () => c.answerQuestion({ questionId: ids.question, optionId: "up" }),
        () => c.requestAttempt({ itemId: ids.planned, kind: "investigate" }),
        () => c.createWorkItem({ title: "From the client", repo: "acme/web" }),
        () => c.getWorkItem({ itemId: "FAC-999" }),
        () => c.getWorkItem({ itemId: ids.review }),
        () => c.getWorkBoard(),
      ]
      const outcomes = async (c: HqClient) => {
        const out: unknown[] = []
        for (const call of calls(c)) {
          out.push(
            await call().then(
              // an item's events are ordered by hq's ticks of one millisecond: compared elsewhere
              (value) => ({ value: normalized(value && { ...value, events: undefined }) }),
              (error: HqError) => ({
                kind: error.kind,
                status: error.status,
                code: error.code,
                message: error.message,
              }),
            ),
          )
        }
        return out
      }
      const fromReal = await outcomes(real)
      const fromFake = await outcomes(faked)
      expect(fromFake).toEqual(fromReal)
      // the second approve is a conflict and an unknown item is not-found, in both
      expect(fromReal[1]).toMatchObject({ kind: "conflict", code: "CONFLICT" })
      expect(fromReal[9]).toMatchObject({ kind: "not-found" })
      // label dispatch refuses a request with hq's own words, claim dispatch makes the attempt
      expect(fromReal[7]).toEqual(
        mode === "label"
          ? {
              kind: "bad-request",
              status: 400,
              code: "BAD_REQUEST",
              message: "This factory starts attempts from the agent:build label",
            }
          : { value: expect.objectContaining({ status: "requested", kind: "investigate" }) },
      )
    })

    it("the fake's events are a subset of the real ones: nothing is invented", async () => {
      const fake = await fakeFromReal("founder")
      const send = harnessFetch(hq.app, cookies.founder)
      const call = (path: string, body: unknown) =>
        send(`${BASE}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      const before = async (read: (p: string) => Promise<unknown>) =>
        ((await read(`/v1/work-items/${ids.review}`)) as { events: { id: string }[] }).events.map(
          (e) => e.id,
        )
      const readFake = async (path: string) => (await fake.fetch(`${BASE}${path}`)).json()
      const had = { real: await before(readJson), fake: await before(readFake) }
      const body = { headSha: ids.sha, note: "ship it" }
      await call(`/v1/work-items/${ids.review}/merge-approval`, body)
      await fake.fetch(`${BASE}/v1/work-items/${ids.review}/merge-approval`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      type Ev = {
        id: string
        kind: string
        summary: string
        reason: string | null
        note: string | null
      }
      const fresh = async (read: (p: string) => Promise<unknown>, old: string[]) =>
        ((await read(`/v1/work-items/${ids.review}`)) as { events: Ev[] }).events
          .filter((e) => !old.includes(e.id))
          .map((e) => ({ kind: e.kind, summary: e.summary, reason: e.reason, note: e.note }))
      const realNew = await fresh(readJson, had.real)
      const fakeNew = await fresh(readFake, had.fake)
      expect(fakeNew.length).toBeGreaterThan(0)
      for (const e of fakeNew) expect(realNew).toContainEqual(e)
    })
  },
)

describe("the work fixtures are what hq returns", () => {
  let hq: Awaited<ReturnType<typeof createHqHarness>>
  let cookie = ""
  const read = async (path: string): Promise<unknown> => {
    const res = await harnessFetch(hq.app, cookie)(`${BASE}${path}`)
    expect(res.status, path).toBe(200)
    return res.json()
  }
  let seeded: Awaited<ReturnType<typeof seedWork>>

  beforeAll(async () => {
    hq = await createHqHarness({ founderEmails: ["founder@example.com"] })
    cookie = (await hq.signUp("founder@example.com")).cookie
    seeded = await seedWork({ baseUrl: BASE, cookie, fetch: harnessFetch(hq.app, cookie) })
  })
  afterAll(async () => {
    await hq.close()
  })

  /** Paths whose presence depends on the data a seed cannot make through /v1 (named, not hidden). */
  const DATA_DEPENDENT = [
    /^\.stats\.latestReopened\./, // null on the fixture board: nothing reopened
    /\.window\.waitingOn\[\]\./, // a connected verifier that has not answered yet
    /\.founderNotes\[\]\./, // a founder's retry, answer or revert, none in the seed
  ]
  const comparable = (paths: string[]) =>
    [...new Set(structural(paths))].filter((p) => !DATA_DEPENDENT.some((re) => re.test(p))).sort()

  it("the board fixture has the keys of the real board, value for value where a seed fixes them", async () => {
    const real = (await read("/v1/work/board")) as Record<string, unknown>
    const fixture = workBoardFixture()
    expect(comparable(keyPaths(real))).toEqual(comparable(keyPaths(fixture)))
    expect(keySet(real).includes(".needsYou[].merge.isDraft")).toBe(true)
    // the fixture is the real board's shape: five columns in order, hq's labels and dispatch
    expect(fixture.columns.map((c) => [c.key, c.label])).toEqual(
      (real.columns as { key: string; label: string }[]).map((c) => [c.key, c.label]),
    )
    expect(fixture.dispatch).toBe(real.dispatch)
    expect(fixture.needsYou.map((n) => n.kind).sort()).toEqual(
      (real.needsYou as { kind: string }[]).map((n) => n.kind).sort(),
    )
    for (const kind of ["merge_approval", "agent_question", "attempt_budget"] as const) {
      const entry = (real.needsYou as { kind: string }[]).find((n) => n.kind === kind)
      expect(normalized(needsYouFixture(kind)), kind).toEqual(normalized(entry))
    }
  })

  it("each fixture item equals the real item of the same number on everything a seed fixes", async () => {
    const fixtures = Object.values(workItemsFixture())
    for (const fixture of fixtures) {
      const real = workItemDetailSchema.parse(
        await read(`/v1/work-items/FAC-${fixture.number}`),
      ) as typeof fixture
      const view = (i: typeof fixture) =>
        normalized({
          title: i.title,
          state: i.state,
          cycle: i.cycle,
          card: i.card,
          attention: i.attention,
          attempts: i.attempts,
          pullRequest: i.pullRequest && {
            number: i.pullRequest.number,
            state: i.pullRequest.state,
            isDraft: i.pullRequest.isDraft,
            checks: i.pullRequest.checks,
            additions: i.pullRequest.additions,
          },
          signal: i.signal && {
            source: i.signal.source,
            urlChecked: i.signal.urlChecked,
            occurrences: i.signal.occurrences,
          },
          stages: i.stages,
          contract: i.contract.map((c) => [c.text, c.verifier, c.status, c.evidence]),
          attempts_: i.attemptList.map((a) => [a.number, a.kind, a.status, a.result]),
          questions: i.questions.map((q) => [q.prompt, q.options, q.status, q.defaultOptionId]),
          mergeApproval: i.mergeApproval && [i.mergeApproval.status, i.mergeApproval.headSha],
          window: i.window && [i.window.status, i.window.remainingMinutes, i.window.pastEnd],
          founderNotes: i.founderNotes,
          actions: i.actions,
          truncated: i.truncated,
        })
      expect(view(fixture), `FAC-${fixture.number}`).toEqual(view(real))
    }
    expect(seeded.built.length).toBe(10)
  })

  it("the item fixtures have the keys of the real items, as a set over the six", async () => {
    const real: unknown[] = []
    for (const fixture of Object.values(workItemsFixture())) {
      real.push(await read(`/v1/work-items/FAC-${fixture.number}`))
    }
    expect(comparable(keyPaths(real))).toEqual(
      comparable(keyPaths(Object.values(workItemsFixture()))),
    )
  })
})

describe("get_factory_status with the work tables dropped", () => {
  it("get_factory_status with the work tables dropped parses with work null, in the real hq and in the fake", async () => {
    const hq = await createHqHarness({ founderEmails: ["founder@example.com"] })
    try {
      const cookie = (await hq.signUp("founder@example.com")).cookie
      for (const table of [
        "work_item_events",
        "verification_windows",
        "merge_approvals",
        "agent_questions",
        "contract_items",
        "pull_requests",
        "attempts",
        "signals",
        "work_items",
      ]) {
        await hq.db.execute(sql.raw(`drop table "hq"."${table}" cascade`))
      }
      const step: Step = {
        method: "GET",
        path: () => "/v1/factory/status",
        schema: factoryStatusSchema,
        status: 200,
        code: null,
      }
      const real = await runSteps([step], harnessFetch(hq.app, cookie), "")
      const fake = createFakeHq()
      fake.state.factoryStatus = { ...fake.state.factoryStatus, work: null }
      const faked = await runSteps([step], fake.fetch, "")
      expect(real.parsed).toEqual([true])
      expect(faked.parsed).toEqual([true])
      expect(faked.keys).toEqual(real.keys)
      const body = (await (
        await harnessFetch(hq.app, cookie)(`${BASE}/v1/factory/status`)
      ).json()) as {
        work: unknown
      }
      expect(body.work).toBeNull()
      expect(factoryStatusSchema.parse(body).work).toBeNull()
    } finally {
      await hq.close()
    }
  })
})

describe("the fake and hq agree on a work path nobody serves", () => {
  it("the fake answers an unknown work path with 404 and a non-JSON body to a founder write with 400", async () => {
    const hq = await createHqHarness({ founderEmails: ["founder@example.com"] })
    try {
      const cookie = (await hq.signUp("founder@example.com")).cookie
      const send = harnessFetch(hq.app, cookie)
      const fake = createFakeHq()
      const post = (path: string, body: string): RequestInit => ({
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
      for (const [path, init, status] of [
        ["/v1/work-items/FAC-1/delete", post("", "{}"), 404],
        ["/v1/work/nope", undefined, 404],
        ["/v1/work-items/FAC-1/stop", post("", "not json"), 400],
        ["/v1/work-items", post("", "not json"), 400],
      ] as const) {
        const real = await observe(await send(`${BASE}${path}`, init))
        const faked = await observe(await fake.fetch(`${BASE}${path}`, init))
        expect([real.status, faked.status], path).toEqual([status, status])
        expect(errorCodeOf(faked.body), path).toBe(errorCodeOf(real.body))
        expect(keySet(faked.body), path).toEqual(keySet(real.body))
      }
      // The paths nobody serves are violations in the fake (a screen must not call them); the
      // two writes that exist are not.
      expect(fakeViolations).toHaveLength(2)
      fakeViolations.length = 0
    } finally {
      await hq.close()
    }
  })
})

// ---------------------------------------------------------------------------------------------
// get_digest's `pipeline` (Task 19). The real digest over a fresh hq and over the seed's board,
// against the fake's fixtures: the same keys, the same VALUES on what a seed fixes, and a fake
// that refuses a pipeline hq would never send.
// ---------------------------------------------------------------------------------------------

describe("get_digest's pipeline: the fake and hq agree", () => {
  let hq: Awaited<ReturnType<typeof createHqHarness>>
  let cookie = ""
  const read = async (path: string): Promise<{ pipeline: unknown } & Record<string, unknown>> => {
    const res = await harnessFetch(hq.app, cookie)(`${BASE}${path}`)
    expect(res.status, path).toBe(200)
    return (await res.json()) as { pipeline: unknown } & Record<string, unknown>
  }
  /** The events and the merges in one order: hq's ties are by id, which a seed cannot fix. */
  const inOrder = (pipeline: unknown) => {
    const p = pipeline as {
      events: { displayId: string; result: string }[]
      merged: { displayId: string }[]
    }
    return {
      ...p,
      events: [...p.events].sort((a, b) =>
        `${a.displayId}:${a.result}`.localeCompare(`${b.displayId}:${b.result}`, "en", {
          numeric: true,
        }),
      ),
      merged: [...p.merged].sort((a, b) =>
        a.displayId.localeCompare(b.displayId, "en", { numeric: true }),
      ),
    }
  }

  // hq's clock is fixed in the harness, and a window excludes its own end: the seed writes at the
  // fixed instant, so the clock moves one minute on once it has.
  const SEEDED_AT = new Date("2026-11-17T12:00:00Z")
  let clock = SEEDED_AT

  beforeAll(async () => {
    hq = await createHqHarness({ founderEmails: ["founder@example.com"], now: () => clock })
    cookie = (await hq.signUp("founder@example.com")).cookie
  })
  afterAll(async () => {
    await hq.close()
  })

  it("a fresh hq answers the pipeline the fixture holds: zeros and empty lists, value for value", async () => {
    const real = await read("/v1/digest")
    expect(real.pipeline).toEqual(digestFixture().pipeline)
    expect(real.pipeline).toEqual(emptyDigestPipeline())
    const fake = (await (await createFakeHq().fetch(`${BASE}/v1/digest`)).json()) as typeof real
    expect(Object.keys(fake).sort()).toEqual(Object.keys(real).sort())
  })

  it("the fake's whole-digest schema parses a real hq reply, the Phase 3 part too, and a reply with no pipeline key parses through the client's schema", async () => {
    const real = await read("/v1/digest")
    expect(digestStrict.safeParse(real).success).toBe(true)
    // an older hq sends no pipeline key: the client still reads the rest
    const { pipeline: _omitted, ...older } = real
    expect("pipeline" in older).toBe(false)
    expect(digestSchema.safeParse(older).success).toBe(true)
    expect(digestSchema.parse(older).pipeline).toBeUndefined()
    // ...and the strict fake would not answer with one (hq always sends the key)
    expect(digestStrict.safeParse(older).success).toBe(false)
  })

  it("the seed's pipeline equals digestPipelineFixture on everything a seed fixes (times and uuids aside)", async () => {
    await seedWork({ baseUrl: BASE, cookie, fetch: harnessFetch(hq.app, cookie) })
    clock = new Date(SEEDED_AT.getTime() + 60_000)
    const real = await read("/v1/digest")
    expect(normalized(inOrder(real.pipeline))).toEqual(normalized(inOrder(digestPipelineFixture())))
    // the fake serves it with the same keys, parsed by the client's own schema
    const fake = createFakeHq()
    fake.state.digest = digestFixture({ pipeline: digestPipelineFixture() })
    const faked = await (await fake.fetch(`${BASE}/v1/digest`)).json()
    expect(keySet((faked as { pipeline: unknown }).pipeline)).toEqual(keySet(real.pipeline))
    expect(digestSchema.safeParse(faked).success).toBe(true)
    expect(digestSchema.safeParse(real).success).toBe(true)
  })

  it("the fake accepts a null pipeline and a populated one without recording a violation", async () => {
    const before = fakeViolations.length
    for (const pipeline of [null, emptyDigestPipeline(), digestPipelineFixture()]) {
      const fake = createFakeHq()
      fake.state.digest = digestFixture({ pipeline })
      const res = await fake.fetch(`${BASE}/v1/digest`)
      expect(res.status).toBe(200)
      expect(((await res.json()) as { pipeline: unknown }).pipeline).toEqual(pipeline)
    }
    expect(fakeViolations.length).toBe(before)
  })

  it("the fake refuses to answer with a digest or a pipeline hq would never send", async () => {
    const good = digestFixture({ pipeline: digestPipelineFixture() })
    const p = digestPipelineFixture()
    const { pipeline: _dropped, ...withoutPipeline } = good
    const bad: unknown[] = [
      { ...good, pipeline: { ...p, extra: 1 } },
      { ...good, pipeline: { ...p, stuckAttempts: -1 } },
      { ...good, pipeline: { ...p, opened: 1.5 } },
      { ...good, pipeline: { ...p, needsYou: [{ ...p.needsYou[0], extra: 1 }] } },
      { ...good, pipeline: { ...p, needsYou: [{ ...p.needsYou[0], kind: "default_answer" }] } },
      { ...good, pipeline: { ...p, merged: [{ ...p.merged[0], state: "live" }] } },
      { ...good, pipeline: { ...p, events: [{ ...p.events[0], result: "deployed" }] } },
      { ...good, pipeline: { ...p, events: [{ ...p.events[0], at: undefined }] } },
      { ...good, extra: 1 },
      // hq always sends the key: an older hq's reply is not one the fake may answer with
      withoutPipeline,
    ]
    for (const digest of bad) {
      const fake = createFakeHq()
      fake.state.digest = digest as typeof good
      await expect(fake.fetch(`${BASE}/v1/digest`)).rejects.toThrow()
    }
    // Provoked on purpose: the setup's afterEach would otherwise fail this test.
    fakeViolations.length = 0
  })

  it("with the work tables dropped the real digest parses with pipeline null, in the real hq and in the fake", async () => {
    const dropped = await createHqHarness({ founderEmails: ["founder@example.com"] })
    try {
      const droppedCookie = (await dropped.signUp("founder@example.com")).cookie
      for (const table of [
        "work_item_events",
        "verification_windows",
        "merge_approvals",
        "agent_questions",
        "contract_items",
        "pull_requests",
        "attempts",
        "signals",
        "work_items",
      ]) {
        await dropped.db.execute(sql.raw(`drop table "hq"."${table}" cascade`))
      }
      const fake = createFakeHq()
      fake.state.digest = digestFixture({ pipeline: null })
      const fakeBody = (await (await fake.fetch(`${BASE}/v1/digest`)).json()) as Record<
        string,
        unknown
      >
      expect(digestSchema.parse(fakeBody).pipeline).toBeNull()
      const body = (await (
        await harnessFetch(dropped.app, droppedCookie)(`${BASE}/v1/digest`)
      ).json()) as { pipeline: unknown }
      expect(body.pipeline).toBeNull()
      expect(digestSchema.parse(body).pipeline).toBeNull()
      // the same top-level keys, and the key is there with null in both
      expect(Object.keys(fakeBody).sort()).toEqual(Object.keys(body).sort())
      expect(fakeBody.pipeline).toBeNull()
    } finally {
      await dropped.close()
    }
  })
})
