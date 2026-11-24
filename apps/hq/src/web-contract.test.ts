// The fake of hq the component tests use (web/src/test/fake-hq.ts) must be as strict as hq: each
// case below runs against the REAL app and against the fake, and both replies are parsed with the
// same zod schemas the client uses and compared on status, error code and the keys of the body.
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { z } from "zod"

import { createHqClient, type HqClient } from "../web/src/api/client"
import { errorFromReply, type HqErrorKind } from "../web/src/api/errors"
import {
  authErrorSchema,
  decisionSchema,
  digestSchema,
  errorEnvelopeSchema,
  factoryStatusSchema,
  policySchema,
  proposalsPageSchema,
  refusedBodySchema,
  sessionReplySchema,
  statusSchema,
} from "../web/src/api/schemas"
import {
  createFakeHq,
  type FakeHq,
  type FakeHqState,
  fakeViolations,
} from "../web/src/test/fake-hq"
import { factoryStatusFixture, policyFixture, proposalFixture } from "../web/src/test/fixtures"
import { createHqHarness } from "./app.test.helpers"
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
