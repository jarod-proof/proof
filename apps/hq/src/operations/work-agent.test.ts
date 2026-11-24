// The thirteen agent operations of the work pipeline, over hq's real app on in-process Postgres,
// with the agent's UNCHANGED key scope (mint-agent-key.ts). A clock the tests move.
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { type Caller, invoke } from "@proof/api"
import { AppError } from "@proof/errors"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { and, asc, eq, sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { z } from "zod"

import { createHqHarness, type TestPerson } from "../app.test.helpers"
import { requestAttempt } from "../data/attempts"
import { reopenItem } from "../data/decisions"
import { answerQuestion } from "../data/questions"
import { itemDetail, workBoard } from "../data/work-board"
import { forceState, resetWork, seedAttempt, seedItem } from "../data/work.test.helpers"
import { attempts, workItemEvents, workItems } from "../db/schema"
import { findTransition, TRANSITIONS, type WorkState } from "../work/machine"
import { createHqOperations } from "./index"
import { jsonify } from "./work-read"
import * as schemas from "./work-schemas"

const BASE = "http://localhost:3100"
const T0 = new Date("2026-11-17T12:00:00Z")
const MIN = 60_000
const HOUR = 60 * MIN

/** The agent's key scope as mint-agent-key.ts mints it. Pinned against that file below. */
const AGENT_SCOPE = {
  hq_entry: ["read"],
  hq_proposal: ["read", "create"],
  hq_run: ["read", "create", "update"],
  hq_spend: ["read", "record", "request"],
}

const SHA_A = "a".repeat(40)
const SHA_B = "b".repeat(40)

const READS = ["list_work_items", "get_work_item", "get_work_board", "list_attempts"] as const
const WRITES = [
  "record_signal",
  "start_attempt",
  "claim_attempt",
  "heartbeat_attempt",
  "finish_attempt",
  "record_pull_request",
  "set_contract",
  "ask_question",
  "run_verification_sweep",
] as const
const ALL = [...READS, ...WRITES]

/** The one hq_run action each operation needs: a record that did not exist is `create`. */
const ACTION_OF = {
  list_work_items: "read",
  get_work_item: "read",
  get_work_board: "read",
  list_attempts: "read",
  record_signal: "create",
  start_attempt: "create",
  ask_question: "create",
  claim_attempt: "update",
  heartbeat_attempt: "update",
  finish_attempt: "update",
  record_pull_request: "update",
  set_contract: "update",
  run_verification_sweep: "update",
} as const

// What the tests read from a reply: what JSON.parse gives. The tests say what they expect of it.
type Json = ReturnType<typeof JSON.parse>
interface Reply {
  status: number
  body: Json
}

describe("the agent operations of the work pipeline (real Postgres via PGlite)", () => {
  let hq: Awaited<ReturnType<typeof createHqHarness>>
  let founder: TestPerson
  let agentKey: string
  let clock = T0
  const tick = (ms: number) => {
    clock = new Date(clock.getTime() + ms)
  }

  beforeAll(async () => {
    hq = await createHqHarness({ founderEmails: ["founder@example.com"], now: () => clock })
    founder = await hq.signUp("founder@example.com")
    agentKey = await hq.keyFor(founder, AGENT_SCOPE)
  })
  afterAll(() => hq.close())
  beforeEach(async () => {
    clock = T0
    await resetWork(hq.db)
  })

  const call = async (
    as: { key: string } | { cookie: string },
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<Reply> => hq.call(as, method, path, body) as unknown as Reply
  const agent = (method: "GET" | "POST", path: string, body?: unknown) =>
    call({ key: agentKey }, method, path, body)
  const get = (path: string) => agent("GET", path)
  const post = (path: string, body: unknown = {}) => agent("POST", path, body)

  let seq = 0
  /** A github_issue signal; each call is a new issue unless `n` repeats one. */
  const signal = async (o: { n?: number; externalId?: string } = {}) => {
    const n = o.n ?? ++seq
    const res = await post("/v1/signals", {
      source: "github_issue",
      externalId: o.externalId ?? `github-issue:acme/web#${n}:opened`,
      dedupeKey: `github-issue:acme/web#${n}`,
      repo: "acme/web",
      title: `Issue ${n}`,
      summary: `Issue ${n} fails`,
    })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return res.body as { signalId: string; itemId: string; displayId: string; outcome: string }
  }
  const startAttempt = (itemId: string, kind: "investigate" | "fix", extra: object = {}) =>
    post(`/v1/work-items/${itemId}/attempts`, { kind, ...extra })
  const okBody = (res: Reply) => {
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    return res.body
  }
  const contract = (itemId: string, kinds: string[] = ["reviewer"]) =>
    post(`/v1/work-items/${itemId}/contract`, {
      items: kinds.map((kind) => ({ text: `It ${kind}`, verifier: { kind } })),
    })
  const prUrl = (n: number) => `https://github.com/acme/web/pull/${n}`
  const pr = (itemId: string | undefined, n: number, extra: object = {}) =>
    post("/v1/pull-requests", {
      ...(itemId ? { itemId } : {}),
      branch: `factory/fix-${n}`,
      number: n,
      url: prUrl(n),
      base: "main",
      headSha: SHA_A,
      isDraft: false,
      state: "open",
      ...extra,
    })
  const stateOf = async (itemId: string) =>
    (await hq.db.select().from(workItems).where(eq(workItems.id, itemId)))[0]?.state

  /**
   * A signal, an investigation, a contract and a fix with its branch reported: the item is in
   * `attempt` with a running fix. Returns the ids.
   */
  async function fixing(o: { kinds?: string[] } = {}) {
    const made = await signal()
    const itemId = made.itemId
    const inv = okBody(await startAttempt(itemId, "investigate", { externalRef: `inv-${itemId}` }))
    okBody(await contract(itemId, o.kinds))
    okBody(
      await post(`/v1/attempts/${inv.id}/finish`, { result: "investigated", note: "It is a bug." }),
    )
    const fix = okBody(
      await startAttempt(itemId, "fix", { attemptLimit: 3, externalRef: `fix-${itemId}` }),
    )
    const branch = `factory/fix-${made.displayId.slice(4)}`
    okBody(await post(`/v1/attempts/${fix.id}/heartbeat`, { branch, files: ["src/a.ts"] }))
    return { itemId, displayId: made.displayId, fixId: fix.id as string, branch }
  }

  // ---- scope ---------------------------------------------------------------------------------
  describe("scope", () => {
    it("the key scope used here is the one mint-agent-key.ts mints and the agent fixture holds", () => {
      const mint = readFileSync(join(__dirname, "..", "mint-agent-key.ts"), "utf8")
      const block = /const AGENT_SCOPE = (\{[\s\S]*?\n\})/.exec(mint)?.[1] ?? ""
      const parsed = JSON.parse(
        block
          .replace(/\/\/.*$/gm, "")
          .replace(/(\w+):/g, '"$1":')
          .replace(/,(\s*[}\]])/g, "$1"),
      ) as unknown
      expect(parsed).toEqual(AGENT_SCOPE)
      // the agent's own fixture, parsed the same way: the whole object, not a substring of it
      const fixture = readFileSync(
        join(__dirname, "..", "..", "..", "agent", "tests", "hq", "hq-fixture.ts"),
        "utf8",
      )
      const fixtureBlock =
        /export const AGENT_KEY_SCOPE = (\{[\s\S]*?\n\})/.exec(fixture)?.[1] ?? ""
      expect(fixtureBlock).not.toBe("")
      const fixtureScope = JSON.parse(
        fixtureBlock
          .replace(/\/\/.*$/gm, "")
          .replace(/(\w+):/g, '"$1":')
          .replace(/,(\s*[}\]])/g, "$1"),
      ) as Record<string, string[]>
      expect(Object.keys(fixtureScope).sort()).toEqual(Object.keys(AGENT_SCOPE).sort())
      for (const [resource, actions] of Object.entries(AGENT_SCOPE)) {
        expect(fixtureScope[resource], resource).toEqual(actions)
      }
    })

    it("the agent scope can call every agent operation: record_signal, start, heartbeat, finish, record_pull_request, set_contract, ask_question, run_verification_sweep (200)", async () => {
      const made = await signal()
      expect(made.outcome).toBe("created")
      const inv = okBody(await startAttempt(made.itemId, "investigate"))
      okBody(await contract(made.itemId))
      okBody(
        await post(`/v1/work-items/${made.itemId}/questions`, {
          prompt: "Which fix?",
          options: [
            { id: "a", label: "Patch" },
            { id: "b", label: "Rewrite" },
          ],
          defaultOptionId: "a",
          attemptId: inv.id,
        }),
      )
      okBody(await post(`/v1/attempts/${inv.id}/heartbeat`, { note: "reading" }))
      okBody(await post(`/v1/attempts/${inv.id}/finish`, { result: "needs_answer" }))
      const fix = okBody(await startAttempt(made.itemId, "fix", { attemptLimit: 3 }))
      okBody(await post(`/v1/attempts/${fix.id}/heartbeat`, { branch: "factory/fix-1" }))
      okBody(await pr(made.itemId, 1))
      okBody(await post("/v1/work/verification-sweep"))
      okBody(await get("/v1/work/board"))
      okBody(await get(`/v1/work-items/${made.itemId}`))
      okBody(await get("/v1/work-items"))
      okBody(await get("/v1/attempts"))
    })

    it("a key with only hq_run:read gets 403 on every write operation and 200 on the four reads", async () => {
      const made = await signal()
      const readKey = { key: await hq.keyFor(founder, { hq_run: ["read"] }) }
      const id = "11111111-1111-1111-1111-111111111111"
      const writes: [string, string, unknown][] = [
        [
          "POST",
          "/v1/signals",
          {
            source: "github_issue",
            externalId: "x",
            dedupeKey: "github-issue:acme/web#99",
            repo: "acme/web",
            title: "t",
            summary: "s",
          },
        ],
        ["POST", `/v1/work-items/${made.itemId}/attempts`, { kind: "investigate" }],
        ["POST", `/v1/attempts/${id}/claim`, {}],
        ["POST", `/v1/attempts/${id}/heartbeat`, {}],
        ["POST", `/v1/attempts/${id}/finish`, { result: "failed" }],
        ["POST", "/v1/pull-requests", { branch: "b", number: 1, url: prUrl(1) }],
        [
          "POST",
          `/v1/work-items/${made.itemId}/contract`,
          { items: [{ text: "t", verifier: { kind: "reviewer" } }] },
        ],
        [
          "POST",
          `/v1/work-items/${made.itemId}/questions`,
          {
            prompt: "p",
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          },
        ],
        ["POST", "/v1/work/verification-sweep", {}],
      ]
      expect(writes).toHaveLength(WRITES.length)
      for (const [method, path, body] of writes) {
        const res = await call(readKey, method as "POST", path, body)
        expect(res.status, path).toBe(403)
        expect(res.body.error.code).toBe("FORBIDDEN")
      }
      for (const path of [
        "/v1/work-items",
        `/v1/work-items/${made.itemId}`,
        "/v1/work/board",
        "/v1/attempts",
      ]) {
        expect((await call(readKey, "GET", path)).status, path).toBe(200)
      }
      // and nothing was written
      expect(await hq.db.select().from(attempts)).toEqual([])
    })

    it("a key with no hq_run grant gets 403 on all thirteen", async () => {
      const made = await signal()
      const noRun = { key: await hq.keyFor(founder, { hq_entry: ["read"], hq_proposal: ["read"] }) }
      const id = "11111111-1111-1111-1111-111111111111"
      const reqs: [string, string, unknown?][] = [
        ["GET", "/v1/work-items"],
        ["GET", `/v1/work-items/${made.itemId}`],
        ["GET", "/v1/work/board"],
        ["GET", "/v1/attempts"],
        ["POST", "/v1/signals", {}],
        ["POST", `/v1/work-items/${made.itemId}/attempts`, { kind: "investigate" }],
        ["POST", `/v1/attempts/${id}/claim`, {}],
        ["POST", `/v1/attempts/${id}/heartbeat`, {}],
        ["POST", `/v1/attempts/${id}/finish`, { result: "failed" }],
        ["POST", "/v1/pull-requests", {}],
        ["POST", `/v1/work-items/${made.itemId}/contract`, {}],
        ["POST", `/v1/work-items/${made.itemId}/questions`, {}],
        ["POST", "/v1/work/verification-sweep", {}],
      ]
      expect(reqs).toHaveLength(ALL.length)
      for (const [method, path, body] of reqs) {
        const res = await call(noRun, method as "GET", path, body)
        expect(res.status, path).toBe(403)
      }
    })

    it("a founder session and a full-read key both get 200 on the reads", async () => {
      const made = await signal()
      const fullRead = {
        key: await hq.keyFor(founder, {
          hq_run: ["read"],
          hq_proposal: ["read"],
          hq_spend: ["read"],
        }),
      }
      for (const as of [{ cookie: founder.cookie }, fullRead]) {
        for (const path of [
          "/v1/work-items",
          `/v1/work-items/${made.displayId}`,
          "/v1/work/board",
          "/v1/attempts",
        ]) {
          expect((await call(as, "GET", path)).status, path).toBe(200)
        }
      }
    })

    it("a session founder can call them too: the event records actor_type agent with detail.via session", async () => {
      const made = await call({ cookie: founder.cookie }, "POST", "/v1/signals", {
        source: "github_issue",
        externalId: "github-issue:acme/web#500:opened",
        dedupeKey: "github-issue:acme/web#500",
        repo: "acme/web",
        title: "From a session",
        summary: "s",
      })
      expect(made.status).toBe(200)
      const att = await call(
        { cookie: founder.cookie },
        "POST",
        `/v1/work-items/${made.body.itemId}/attempts`,
        { kind: "investigate" },
      )
      expect(att.status, JSON.stringify(att.body)).toBe(200)
      const events = await hq.db
        .select()
        .from(workItemEvents)
        .where(eq(workItemEvents.itemId, made.body.itemId))
        .orderBy(asc(workItemEvents.at), asc(workItemEvents.id))
      const bySession = events.filter((e) => e.kind !== "transition" || e.toState === "plan")
      expect(bySession.length).toBeGreaterThan(0)
      for (const e of bySession) {
        expect(e.actorType, e.kind).toBe("agent")
        expect(e.actorId).toBe(founder.userId)
        expect(e.detail).toMatchObject({ via: "session" })
      }
      // and a key's calls say so
      const viaKey = await signal()
      const [first] = await hq.db
        .select()
        .from(workItemEvents)
        .where(
          and(eq(workItemEvents.itemId, viaKey.itemId), eq(workItemEvents.kind, "signal_attached")),
        )
      expect(first?.detail).toMatchObject({ via: "key" })
      expect(first?.actorType).toBe("agent")
    })
  })

  // ---- signals and reads -----------------------------------------------------------------------
  describe("signals and reads", () => {
    it("record_signal is duplicate on redelivery", async () => {
      const first = await signal({ n: 1 })
      const again = await signal({ n: 1 })
      expect(again).toMatchObject({
        outcome: "duplicate",
        itemId: first.itemId,
        signalId: first.signalId,
      })
      const attached = await signal({ n: 1, externalId: "github-issue:acme/web#1:edited" })
      expect(attached).toMatchObject({ outcome: "attached", itemId: first.itemId })
    })

    it("record_signal is BAD_REQUEST for sentry, manual, a bad dedupe key and a 20 001 byte payload", async () => {
      const base = {
        source: "github_issue",
        externalId: "e1",
        dedupeKey: "github-issue:acme/web#7",
        repo: "acme/web",
        title: "t",
        summary: "s",
      }
      const cases: [string, object][] = [
        ["sentry", { source: "sentry", dedupeKey: "sentry:acme/web:1" }],
        ["posthog", { source: "posthog" }],
        ["manual", { source: "manual", dedupeKey: `manual:${crypto.randomUUID()}` }],
        ["a dedupe key of another shape", { dedupeKey: "issue 7" }],
        ["a key for another repo", { dedupeKey: "github-issue:other/web#7" }],
        ["a payload of 20 001 bytes", { payload: { text: "x".repeat(20_001 - 11) } }],
        ["a title of 301 characters", { title: "t".repeat(301) }],
        ["a bad repo", { repo: "nope" }],
      ]
      for (const [what, extra] of cases) {
        const res = await post("/v1/signals", { ...base, ...extra })
        expect(res.status, what).toBe(400)
        expect(res.body.error.code).toBe("BAD_REQUEST")
      }
      expect(await hq.db.select().from(workItems)).toEqual([])
      // 20 000 bytes is stored
      const ok = await post("/v1/signals", { ...base, payload: { text: "x".repeat(20_000 - 11) } })
      expect(ok.status).toBe(200)
    })

    it("get_work_item accepts the uuid and FAC-<n>, is NOT_FOUND for FAC-999 and BAD_REQUEST for 'garbage'", async () => {
      const made = await signal()
      const byId = okBody(await get(`/v1/work-items/${made.itemId}`))
      const byDisplay = okBody(await get(`/v1/work-items/${made.displayId}`))
      const byLower = okBody(await get(`/v1/work-items/${made.displayId.toLowerCase()}`))
      expect(byDisplay).toEqual(byId)
      expect(byLower).toEqual(byId)
      expect(byId).toMatchObject({ id: made.itemId, displayId: "FAC-1", state: "triage" })
      const missing = await get("/v1/work-items/FAC-999")
      expect([missing.status, missing.body.error.code]).toEqual([404, "NOT_FOUND"])
      for (const bad of ["garbage", "FAC-0", "FAC-", "FAC-1x", "fac_1", "1", "x".repeat(101)]) {
        const res = await get(`/v1/work-items/${encodeURIComponent(bad)}`)
        expect([bad, res.status, res.body.error.code]).toEqual([bad, 400, "BAD_REQUEST"])
      }
    })

    it("a malformed reference is BAD_REQUEST on every operation that takes one, before anything is read", async () => {
      const id = "11111111-1111-1111-1111-111111111111"
      const reqs: [string, string, unknown?][] = [
        ["POST", "/v1/work-items/garbage/attempts", { kind: "investigate" }],
        [
          "POST",
          "/v1/work-items/garbage/contract",
          { items: [{ text: "t", verifier: { kind: "reviewer" } }] },
        ],
        [
          "POST",
          "/v1/work-items/garbage/questions",
          {
            prompt: "p",
            options: [
              { id: "a", label: "A" },
              { id: "b", label: "B" },
            ],
          },
        ],
        ["POST", "/v1/pull-requests", { itemId: "garbage", branch: "b", number: 1, url: prUrl(1) }],
        ["GET", "/v1/attempts?itemId=garbage"],
        ["POST", "/v1/attempts/garbage/claim", {}],
        ["POST", "/v1/attempts/garbage/heartbeat", {}],
        ["POST", "/v1/attempts/garbage/finish", { result: "failed" }],
      ]
      for (const [method, path, body] of reqs) {
        const res = await call({ key: agentKey }, method as "GET", path, body)
        expect([path, res.status, res.body.error.code]).toEqual([path, 400, "BAD_REQUEST"])
      }
      // a well-formed one that does not exist is NOT_FOUND
      for (const path of [`/v1/attempts/${id}/claim`, `/v1/attempts/${id}/heartbeat`]) {
        expect((await post(path, {})).status).toBe(404)
      }
      expect((await startAttempt("FAC-777", "investigate")).status).toBe(404)
    })

    it("FAC-<n> works wherever an item is named", async () => {
      const made = await signal()
      const ref = made.displayId
      okBody(await startAttempt(ref, "investigate"))
      okBody(await contract(ref))
      okBody(
        await post(`/v1/work-items/${ref}/questions`, {
          prompt: "p",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
        }),
      )
      expect(okBody(await get(`/v1/attempts?itemId=${ref}`)).attempts).toHaveLength(1)
      expect(okBody(await pr(ref, 3)).matched).toBe(true)
    })

    it("list_work_items takes state, query, dedupeKey (exact) and pullRequestNumber with repo", async () => {
      const a = await signal({ n: 1 })
      const b = await signal({ n: 2 })
      okBody(await startAttempt(b.itemId, "investigate"))
      okBody(await contract(b.itemId))
      const ids = async (qs: string) =>
        (okBody(await get(`/v1/work-items?${qs}`)).items as Json[]).map((i) => i.id)
      expect(await ids("state=triage")).toEqual([a.itemId])
      expect(await ids("state=plan")).toEqual([b.itemId])
      expect(await ids("query=ISSUE%202")).toEqual([b.itemId])
      expect(await ids("query=fac-1")).toEqual([a.itemId])
      expect(await ids(`dedupeKey=${encodeURIComponent("github-issue:acme/web#1")}`)).toEqual([
        a.itemId,
      ])
      expect(await ids(`dedupeKey=${encodeURIComponent("github-issue:acme/web")}`)).toEqual([])
      okBody(await pr(b.itemId, 42))
      expect(await ids("pullRequestNumber=42&repo=Acme/Web")).toEqual([b.itemId])
      expect(await ids("pullRequestNumber=42&repo=other/web")).toEqual([])
      expect((await get("/v1/work-items?state=nope")).status).toBe(400)
    })

    it("list_work_items pages on (createdAt, id) newest first with nextCursor, at every limit", async () => {
      const made: string[] = []
      for (let i = 0; i < 5; i++) {
        made.push((await signal({ n: 100 + i })).itemId)
        tick(MIN)
      }
      // two created at one instant: the id breaks the tie, descending
      const twinA = (await signal({ n: 110 })).itemId
      const twinB = (await signal({ n: 111 })).itemId
      const newestFirst = [twinA, twinB].sort().reverse().concat(made.slice().reverse())
      const page = async (qs: string) => okBody(await get(`/v1/work-items?${qs}`))
      const walk = async (limit: number) => {
        const seen: string[] = []
        let cursor: string | null = null
        for (let guard = 0; guard < 20; guard++) {
          const res: Json = await page(
            `limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          )
          seen.push(...(res.items as Json[]).map((i) => i.id))
          cursor = res.nextCursor
          if (!cursor) return seen
        }
        throw new Error("did not end")
      }
      for (const limit of [1, 2, 3, 7, 100])
        expect(await walk(limit), `limit ${limit}`).toEqual(newestFirst)
      // exactly one full page: no next cursor
      expect((await page("limit=7")).nextCursor).toBeNull()
      expect((await page("limit=6")).nextCursor).toEqual(expect.any(String))
      expect((await get("/v1/work-items?limit=101")).status).toBe(400)
      expect((await get("/v1/work-items?limit=0")).status).toBe(400)
      expect((await get("/v1/work-items?cursor=garbage")).status).toBe(400)
      const moved = await page("limit=2")
      // paging is stable while an item's state moves: a move does not change createdAt
      okBody(await startAttempt(newestFirst[0] as string, "investigate"))
      const next = await page(`limit=2&cursor=${encodeURIComponent(moved.nextCursor)}`)
      expect((next.items as Json[]).map((i) => i.id)).toEqual(newestFirst.slice(2, 4))
    })

    it("get_work_board has the five columns in order and a needsYou entry for a pending merge approval", async () => {
      const f = await fixing()
      okBody(await pr(f.itemId, 1, { branch: f.branch }))
      okBody(
        await post(`/v1/attempts/${f.fixId}/finish`, {
          result: "approved",
          reviewer: { verdict: "approve", summary: "ok", headSha: SHA_A },
        }),
      )
      const board = okBody(await get("/v1/work/board"))
      expect((board.columns as Json[]).map((c) => c.key)).toEqual([
        "triage",
        "fixing",
        "in_review",
        "verifying",
        "done_today",
      ])
      expect(board.needsYou).toMatchObject([
        {
          kind: "merge_approval",
          itemId: f.itemId,
          merge: { headSha: SHA_A, number: 1, pullRequestUrl: prUrl(1), isDraft: false },
        },
      ])
      expect(board.columns[2].items[0]).toMatchObject({ id: f.itemId, attention: "merge_approval" })
      expect(board.dispatch).toBe("label")
    })
  })

  // ---- attempts --------------------------------------------------------------------------------
  describe("attempts", () => {
    it("claim_attempt: the second claimant gets CONFLICT", async () => {
      const made = await signal({ n: 1 })
      const requested = await requestAttempt(hq.db, {
        itemId: made.itemId,
        kind: "investigate",
        origin: "founder_request",
        founderId: founder.userId,
        instructions: "Look at it",
        now: clock,
      })
      const listed = okBody(await get("/v1/attempts?status=requested"))
      expect(listed.attempts).toEqual([
        {
          attemptId: requested.id,
          itemId: made.itemId,
          displayId: made.displayId,
          kind: "investigate",
          status: "requested",
          title: "Issue 1",
          repo: "acme/web",
          instructions: "Look at it",
          externalRef: null,
        },
      ])
      const first = await post(`/v1/attempts/${requested.id}/claim`, { externalRef: "ticket-1" })
      expect(first.status, JSON.stringify(first.body)).toBe(200)
      expect(first.body).toMatchObject({
        status: "running",
        externalRef: "ticket-1",
        requestedBy: founder.userId,
      })
      const second = await post(`/v1/attempts/${requested.id}/claim`, { externalRef: "ticket-2" })
      expect([second.status, second.body.error.code]).toEqual([409, "CONFLICT"])
      expect(await stateOf(made.itemId)).toBe("plan")
      expect(okBody(await get("/v1/attempts?externalRef=ticket-1")).attempts).toHaveLength(1)
    })

    it("start_attempt twice with one externalRef returns the same attempt (200 both times)", async () => {
      const made = await signal()
      const a = okBody(
        await startAttempt(made.itemId, "investigate", { externalRef: "s1:c1:analyst" }),
      )
      const b = okBody(
        await startAttempt(made.itemId, "investigate", { externalRef: "s1:c1:analyst" }),
      )
      expect(b).toEqual(a)
      expect(await hq.db.select().from(attempts)).toHaveLength(1)
      // another key while one runs is CONFLICT
      expect(
        (await startAttempt(made.itemId, "investigate", { externalRef: "other" })).status,
      ).toBe(409)
    })

    it("start_attempt stores the limit once and refuses a fix without a contract", async () => {
      const made = await signal()
      okBody(await startAttempt(made.itemId, "investigate"))
      const noContract = await startAttempt(made.itemId, "fix")
      expect(noContract.status).toBe(409)
      for (const attemptLimit of [0, 11, 1.5]) {
        expect((await startAttempt(made.itemId, "fix", { attemptLimit })).status).toBe(400)
      }
    })

    it("finish_attempt twice with the same result returns the stored attempt, with a different result is CONFLICT", async () => {
      const f = await fixing()
      const input = {
        result: "approved",
        reviewer: { verdict: "approve", summary: "ok", headSha: SHA_A.toUpperCase() },
        files: ["src/a.ts"],
        note: "done",
      }
      const first = okBody(await post(`/v1/attempts/${f.fixId}/finish`, input))
      const again = okBody(await post(`/v1/attempts/${f.fixId}/finish`, input))
      expect(again).toEqual(first)
      expect(first).toMatchObject({
        status: "finished",
        result: "approved",
        reviewer: { verdict: "approve", summary: "ok", headSha: SHA_A },
        branch: f.branch,
        files: ["src/a.ts"],
        cycle: 1,
        endReason: null,
      })
      const other = await post(`/v1/attempts/${f.fixId}/finish`, { result: "failed" })
      expect([other.status, other.body.error.code]).toEqual([409, "CONFLICT"])
    })

    it("finish_attempt: approved needs a reviewer, a reviewer sha must be a commit id, abandoned is not an input", async () => {
      const f = await fixing()
      const finish = (body: object) => post(`/v1/attempts/${f.fixId}/finish`, body)
      expect((await finish({ result: "approved" })).status).toBe(400)
      expect((await finish({ result: "abandoned" })).status).toBe(400)
      expect((await finish({ result: "investigated" })).status).toBe(400)
      for (const headSha of ["xyz", "abc", "a".repeat(65), ""]) {
        const res = await finish({
          result: "approved",
          reviewer: { verdict: "approve", summary: "s", headSha },
        })
        expect([headSha, res.status]).toEqual([headSha, 400])
      }
      expect(
        (await finish({ result: "approved", reviewer: { verdict: "reject", summary: "s" } }))
          .status,
      ).toBe(400)
      // none of them finished it
      expect(
        okBody(await get(`/v1/attempts?itemId=${f.itemId}&status=running`)).attempts,
      ).toHaveLength(1)
    })

    it("the reviewer's sha binds the approval even when the finish arrives before the push", async () => {
      const f = await fixing()
      okBody(
        await post(`/v1/attempts/${f.fixId}/finish`, {
          result: "approved",
          reviewer: { verdict: "approve", summary: "ok", headSha: SHA_B },
        }),
      )
      // the pull request that comes later is on another head: no approval is asked for
      okBody(await pr(f.itemId, 1, { branch: f.branch, headSha: SHA_A }))
      let board = okBody(await get("/v1/work/board"))
      expect(board.needsYou).toEqual([])
      // a push of the reviewed head asks for one
      okBody(await pr(f.itemId, 1, { branch: f.branch, headSha: SHA_B }))
      board = okBody(await get("/v1/work/board"))
      expect(board.needsYou).toMatchObject([{ kind: "merge_approval", merge: { headSha: SHA_B } }])
    })

    it("heartbeat_attempt is CONFLICT when the item is stopped or done, and extends the lease otherwise", async () => {
      const f = await fixing()
      tick(10 * MIN)
      const ok = okBody(await post(`/v1/attempts/${f.fixId}/heartbeat`, { note: "still going" }))
      expect(ok.leaseExpiresAt).toBe(new Date(clock.getTime() + 45 * MIN).toISOString())
      for (const state of ["stopped", "done"] as const) {
        await forceState(hq.db, f.itemId, state, clock)
        tick(MIN)
        const res = await post(`/v1/attempts/${f.fixId}/heartbeat`, {})
        expect([state, res.status, res.body.error.code]).toEqual([state, 409, "CONFLICT"])
      }
    })

    it("every cap is enforced: note 2 000, files 200 of 500, branch 200, ref 200, session 200", async () => {
      const f = await fixing()
      const hb = (body: object) => post(`/v1/attempts/${f.fixId}/heartbeat`, body)
      expect((await hb({ note: "n".repeat(2001) })).status).toBe(400)
      expect((await hb({ note: "n".repeat(2000) })).status).toBe(200)
      expect((await hb({ files: Array.from({ length: 201 }, (_, i) => `f${i}`) })).status).toBe(400)
      expect((await hb({ files: Array.from({ length: 200 }, (_, i) => `f${i}`) })).status).toBe(200)
      expect((await hb({ files: ["f".repeat(501)] })).status).toBe(400)
      expect((await hb({ files: ["f".repeat(500)] })).status).toBe(200)
      expect((await hb({ branch: "b".repeat(201) })).status).toBe(400)
      expect((await hb({ branch: "b".repeat(200) })).status).toBe(200)
      const made = await signal()
      expect(
        (await startAttempt(made.itemId, "investigate", { externalRef: "r".repeat(201) })).status,
      ).toBe(400)
      expect(
        (await startAttempt(made.itemId, "investigate", { runId: "r".repeat(201) })).status,
      ).toBe(400)
      const fin = (body: object) =>
        post(`/v1/attempts/${f.fixId}/finish`, { result: "failed", ...body })
      expect((await fin({ sessionId: "s".repeat(201) })).status).toBe(400)
      expect((await fin({ note: "n".repeat(2001) })).status).toBe(400)
      expect(
        (await fin({ reviewer: { verdict: "reject", summary: "s".repeat(2001) } })).status,
      ).toBe(400)
      expect((await fin({ sessionId: "s".repeat(200), note: "n".repeat(2000) })).status).toBe(200)
    })
  })

  // ---- pull requests ---------------------------------------------------------------------------
  describe("pull requests", () => {
    it("record_pull_request for a branch no attempt knows answers 200 { matched: false }", async () => {
      const res = await pr(undefined, 5, { branch: "factory/unknown" })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ matched: false, itemId: null, state: null })
    })

    it("finds the item by branch and takes attempt to review", async () => {
      const f = await fixing()
      const res = okBody(await pr(undefined, 9, { branch: f.branch }))
      expect(res).toEqual({ matched: true, itemId: f.itemId, state: "review" })
    })

    it("record_pull_request with a url for another repo is 400", async () => {
      const f = await fixing()
      for (const url of [
        "https://github.com/other/repo/pull/1",
        "http://github.com/acme/web/pull/1",
        "javascript:alert(1)",
        "https://github.com/acme/web/issues/1",
      ]) {
        const res = await pr(f.itemId, 1, { url })
        expect([url, res.status]).toEqual([url, 400])
      }
      // the right repo, another number than the url's
      expect((await pr(f.itemId, 2, { url: prUrl(3) })).status).toBe(400)
    })

    it("record_pull_request with mergedAt and state merged stores it; mergedAt with state open is 400", async () => {
      const f = await fixing()
      okBody(await pr(f.itemId, 1, { branch: f.branch }))
      expect((await pr(f.itemId, 1, { mergedAt: T0.toISOString() })).status).toBe(400)
      expect((await pr(f.itemId, 1, { mergedBy: "octocat" })).status).toBe(400)
      expect((await pr(f.itemId, 1, { state: "merged", mergedAt: "yesterday" })).status).toBe(400)
      const mergedAt = new Date(T0.getTime() - 5 * MIN)
      const res = okBody(
        await pr(f.itemId, 1, {
          state: "merged",
          mergedAt: mergedAt.toISOString(),
          mergedBy: "octocat",
        }),
      )
      expect(res.state).toBe("deploy")
      const detail = okBody(await get(`/v1/work-items/${f.itemId}`))
      expect(detail.pullRequest).toMatchObject({
        state: "merged",
        mergedAt: mergedAt.toISOString(),
        mergedBy: "octocat",
      })
    })

    it("a merge recorded with a date in the future is clamped to now and never moves again", async () => {
      const f = await fixing()
      okBody(await pr(f.itemId, 1, { branch: f.branch }))
      okBody(
        await pr(f.itemId, 1, {
          state: "merged",
          mergedAt: new Date(T0.getTime() + HOUR).toISOString(),
        }),
      )
      tick(MIN)
      okBody(
        await pr(f.itemId, 1, {
          state: "merged",
          mergedAt: new Date(T0.getTime() - HOUR).toISOString(),
        }),
      )
      const detail = okBody(await get(`/v1/work-items/${f.itemId}`))
      expect(detail.pullRequest.mergedAt).toBe(T0.toISOString())
    })

    it("a stale merged pull request recorded after the current one does not replace it", async () => {
      const f = await fixing()
      okBody(await pr(f.itemId, 7, { branch: f.branch }))
      okBody(
        await post(`/v1/attempts/${f.fixId}/finish`, {
          result: "approved",
          reviewer: { verdict: "approve", summary: "ok", headSha: SHA_A },
        }),
      )
      tick(5 * MIN)
      const stale = okBody(
        await pr(f.itemId, 3, {
          branch: "factory/old",
          state: "merged",
          mergedAt: new Date(T0.getTime() - 3 * 24 * HOUR).toISOString(),
        }),
      )
      expect(stale.state).toBe("review")
      const detail = okBody(await get(`/v1/work-items/${f.itemId}`))
      expect(detail.pullRequest).toMatchObject({ number: 7, state: "open" })
      expect(detail.mergeApproval).toMatchObject({ status: "pending", headSha: SHA_A })
    })
  })

  // ---- contract and questions --------------------------------------------------------------------
  describe("contract and questions", () => {
    it("set_contract replaces, returns the items in order and is refused after a fix started", async () => {
      const made = await signal()
      okBody(await startAttempt(made.itemId, "investigate"))
      const first = okBody(await contract(made.itemId, ["reviewer", "ci"]))
      expect(first.contract).toMatchObject([
        {
          text: "It reviewer",
          verifier: { kind: "reviewer", label: "reviewer" },
          status: "pending",
          evidence: null,
          checkedAt: null,
        },
        { text: "It ci", verifier: { kind: "ci", label: "ci" } },
      ])
      expect(okBody(await contract(made.itemId, ["signal_recurrence"])).contract).toHaveLength(1)
      for (const kind of ["sentry", "posthog"])
        expect((await contract(made.itemId, [kind])).status).toBe(400)
      expect((await contract(made.itemId, [])).status).toBe(400)
      expect((await contract(made.itemId, Array(9).fill("reviewer"))).status).toBe(400)
      expect(
        (
          await post(`/v1/work-items/${made.itemId}/contract`, {
            items: [{ text: "t".repeat(301), verifier: { kind: "ci" } }],
          })
        ).status,
      ).toBe(400)
      const inv = okBody(await get(`/v1/attempts?itemId=${made.itemId}`)).attempts[0]
      okBody(await post(`/v1/attempts/${inv.attemptId}/finish`, { result: "investigated" }))
      okBody(await startAttempt(made.itemId, "fix", { attemptLimit: 3 }))
      expect((await contract(made.itemId)).status).toBe(409)
    })

    it("ask_question needs 2 to 5 options and a default among them, and shows as needing a founder", async () => {
      const made = await signal()
      const ask = (body: object) =>
        post(`/v1/work-items/${made.itemId}/questions`, { prompt: "Which?", ...body })
      const opts = (n: number) =>
        Array.from({ length: n }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }))
      expect((await ask({ options: opts(1) })).status).toBe(400)
      expect((await ask({ options: opts(6) })).status).toBe(400)
      expect((await ask({ options: opts(3), defaultOptionId: "zz" })).status).toBe(400)
      expect(
        (
          await ask({
            options: [
              { id: "a", label: "A" },
              { id: "a", label: "B" },
            ],
          })
        ).status,
      ).toBe(400)
      expect((await ask({ options: opts(2), prompt: "p".repeat(2001) })).status).toBe(400)
      const q = okBody(await ask({ options: opts(5), defaultOptionId: "o2" }))
      expect(q).toMatchObject({
        status: "open",
        defaultOptionId: "o2",
        answeredBy: null,
        attemptId: null,
        options: opts(5),
      })
      const board = okBody(await get("/v1/work/board"))
      expect(board.needsYou).toMatchObject([
        { kind: "agent_question", question: { questionId: q.id, defaultOptionId: "o2" } },
      ])
    })
  })

  // ---- the sweep ---------------------------------------------------------------------------------
  describe("run_verification_sweep", () => {
    afterEach(async () => {
      await hq.db.execute(sql`drop trigger if exists test_fail_events on hq.work_item_events`)
      await hq.db.execute(sql`drop function if exists hq.test_fail_events()`)
    })

    it("abandons a stale attempt, and a second sweep changes nothing", async () => {
      const f = await fixing()
      tick(46 * MIN)
      const first = okBody(await post("/v1/work/verification-sweep"))
      expect(first).toEqual({
        advanced: [],
        passed: [],
        reopened: [],
        retriaged: [],
        abandoned: [f.fixId],
        errors: [],
      })
      const second = okBody(await post("/v1/work/verification-sweep"))
      expect(second.abandoned).toEqual([])
      const detail = okBody(await get(`/v1/work-items/${f.itemId}`))
      const fix = (detail.attemptList as Json[]).find((a) => a.id === f.fixId)
      expect(fix).toMatchObject({
        status: "finished",
        result: "abandoned",
        endReason: "lease_expired",
      })
    })

    it("reports errors: one item that throws is listed and the others still move", async () => {
      const bad = await seedItem(hq.db, { state: "attempt", title: "bad" })
      const ok = await seedItem(hq.db, { state: "attempt", title: "ok" })
      for (const item of [bad, ok]) {
        await seedAttempt(hq.db, item.id, {
          number: 1,
          status: "running",
          result: null,
          leaseExpiresAt: new Date(T0.getTime() - MIN),
        })
      }
      await hq.db.execute(sql`create function hq.test_fail_events() returns trigger
        language plpgsql as $$ begin raise exception 'boom'; end $$`)
      await hq.db.execute(
        sql.raw(`create trigger test_fail_events before insert on hq.work_item_events
          for each row when (new.item_id = '${bad.id}') execute function hq.test_fail_events()`),
      )
      const res = okBody(await post("/v1/work/verification-sweep"))
      expect(res.abandoned).toHaveLength(1)
      expect(res.errors).toEqual([
        { itemId: bad.id, rule: "expire", message: expect.stringMatching(/boom/) },
      ])
    })

    it("walks a merge to done: the evidence moves the item, no caller names a state", async () => {
      const f = await fixing()
      okBody(await pr(f.itemId, 1, { branch: f.branch }))
      okBody(
        await post(`/v1/attempts/${f.fixId}/finish`, {
          result: "approved",
          reviewer: { verdict: "approve", summary: "ok", headSha: SHA_A },
        }),
      )
      okBody(
        await pr(f.itemId, 1, {
          state: "merged",
          mergedAt: clock.toISOString(),
          mergedBy: "octocat",
        }),
      )
      expect(await stateOf(f.itemId)).toBe("deploy")
      tick(16 * MIN)
      expect(okBody(await post("/v1/work/verification-sweep")).advanced).toEqual([f.itemId])
      expect(await stateOf(f.itemId)).toBe("verify")
      tick(7 * HOUR)
      expect(okBody(await post("/v1/work/verification-sweep")).passed).toEqual([f.itemId])
      expect(await stateOf(f.itemId)).toBe("done")
    })
  })

  // ---- the replies carry every field the data layer returns ---------------------------------------
  describe("the output schemas name every field", () => {
    /** Every key path of a JSON value (arrays merged, `detail` left opaque). */
    function paths(value: unknown, prefix = ""): Set<string> {
      const out = new Set<string>()
      const walk = (v: unknown, at: string) => {
        if (Array.isArray(v)) return v.forEach((x) => walk(x, `${at}[]`))
        if (v !== null && typeof v === "object") {
          for (const [k, x] of Object.entries(v)) {
            out.add(`${at}.${k}`)
            if (k !== "detail") walk(x, `${at}.${k}`)
          }
        }
      }
      walk(value, prefix)
      return out
    }
    const same = (reply: unknown, data: unknown) => {
      const a = paths(reply)
      const b = paths(data)
      expect(
        [...b].filter((p) => !a.has(p)),
        "in the data, not in the reply",
      ).toEqual([])
      expect(
        [...a].filter((p) => !b.has(p)),
        "in the reply, not in the data",
      ).toEqual([])
    }

    it("a fully populated item: window, approval, abandoned attempt, reviewer sha, flags", async () => {
      const made = await signal()
      // an investigation that goes stale, then another that finishes
      const stale = okBody(await startAttempt(made.itemId, "investigate", { externalRef: "i1" }))
      tick(46 * MIN)
      okBody(await post("/v1/work/verification-sweep"))
      const inv = okBody(
        await startAttempt(made.itemId, "investigate", { externalRef: "i2", runId: "run-1" }),
      )
      okBody(await contract(made.itemId, ["reviewer", "ci"]))
      okBody(
        await post(`/v1/attempts/${inv.id}/finish`, { result: "investigated", note: "Found it" }),
      )
      const fix = okBody(await startAttempt(made.itemId, "fix", { attemptLimit: 3 }))
      okBody(
        await post(`/v1/attempts/${fix.id}/heartbeat`, {
          branch: "factory/fix-1",
          files: ["a.ts"],
        }),
      )
      okBody(
        await pr(made.itemId, 1, {
          additions: 3,
          deletions: 1,
          files: 1,
          checks: [{ name: "ci", state: "pending" }],
          isDraft: true,
        }),
      )
      okBody(
        await post(`/v1/attempts/${fix.id}/finish`, {
          result: "approved",
          reviewer: { verdict: "approve", summary: "ok", headSha: SHA_A },
        }),
      )
      const asked = okBody(
        await post(`/v1/work-items/${made.itemId}/questions`, {
          prompt: "Ship it?",
          options: [
            { id: "y", label: "Yes", detail: "Now" },
            { id: "n", label: "No" },
          ],
          defaultOptionId: "y",
        }),
      )
      okBody(
        await pr(made.itemId, 1, {
          state: "merged",
          mergedAt: clock.toISOString(),
          mergedBy: "octocat",
        }),
      )
      tick(16 * MIN)
      okBody(await post("/v1/work/verification-sweep"))
      expect(await stateOf(made.itemId)).toBe("verify")
      tick(7 * HOUR) // past the end: pastEnd is true while the contract still waits on the ci check

      // a founder's answer with a note: the founderNotes list is compared too
      await answerQuestion(hq.db, {
        questionId: asked.id,
        optionId: "y",
        note: "Yes, after lunch.",
        founderId: founder.userId,
        now: clock,
      })

      const reply = okBody(await get(`/v1/work-items/${made.itemId}`))
      const data = jsonify(await itemDetail(hq.db, made.itemId, clock))
      expect(data.founderNotes).toHaveLength(1)
      same(reply, data)
      expect(reply).toEqual(data)
      // the fields the plan carries name, each present
      for (const path of [
        ".signal.urlChecked",
        ".window.mergedAt",
        ".window.pastEnd",
        ".window.waitingOn[].state",
        ".mergeApproval.requestedAt",
        ".pullRequest.isDraft",
        ".truncated.events",
        ".attemptList[].cycle",
        ".attemptList[].endReason",
        ".attemptList[].reviewer.headSha",
        ".events[].summary",
        ".founderNotes[].at",
        ".founderNotes[].kind",
        ".founderNotes[].text",
      ]) {
        expect(paths(reply).has(path), path).toBe(true)
      }
      expect(stale.id).toBeTruthy()
      expect((reply.attemptList as Json[]).find((a) => a.id === stale.id)).toMatchObject({
        result: "abandoned",
        endReason: "lease_expired",
      })
      expect(reply.window.mergedAt).toEqual(expect.any(String))
    })

    it("the board with a merge approval and a question, and the sweep result", async () => {
      const f = await fixing()
      okBody(await pr(f.itemId, 1, { branch: f.branch }))
      okBody(
        await post(`/v1/attempts/${f.fixId}/finish`, {
          result: "approved",
          reviewer: { verdict: "approve", summary: "ok", headSha: SHA_A },
        }),
      )
      const other = await signal()
      okBody(
        await post(`/v1/work-items/${other.itemId}/questions`, {
          prompt: "Which?",
          options: [
            { id: "a", label: "A", detail: "d" },
            { id: "b", label: "B" },
          ],
        }),
      )
      // an item a founder reopened today: stats.latestReopened is compared too
      const gone = await seedItem(hq.db, { state: "done", title: "Gone" })
      await reopenItem(hq.db, {
        itemId: gone.id,
        note: "Again.",
        founderId: founder.userId,
        now: clock,
      })
      const board = okBody(await get("/v1/work/board"))
      same(board, jsonify(await workBoard(hq.db, clock)))
      expect(board.stats.latestReopened).toMatchObject({ displayId: expect.any(String) })
      expect(paths(board).has(".stats.latestReopened.reason")).toBe(true)
      expect(board).toEqual(jsonify(await workBoard(hq.db, clock)))
      expect(board.needsYou).toHaveLength(2)
      const sweep = okBody(await post("/v1/work/verification-sweep"))
      expect(Object.keys(sweep).sort()).toEqual([
        "abandoned",
        "advanced",
        "errors",
        "passed",
        "reopened",
        "retriaged",
      ])
    })
  })

  // ---- the registry ----------------------------------------------------------------------------
  describe("the registry", () => {
    const ops = () =>
      createHqOperations({ db: hq.db, now: () => clock }).filter((o) =>
        ALL.includes(o.name as never),
      )

    it("all thirteen are in OpenAPI, llms.txt and MCP tools/list", async () => {
      expect(
        ops()
          .map((o) => o.name)
          .sort(),
      ).toEqual([...ALL].sort())
      const doc = (await (await hq.app.request(`${BASE}/openapi.json`)).json()) as {
        paths: Record<string, Record<string, unknown>>
      }
      for (const op of ops()) {
        const path = op.path.replace(/:(\w+)/g, "{$1}")
        expect(doc.paths[path]?.[op.method.toLowerCase()], op.name).toBeDefined()
      }
      const llms = await (await hq.app.request(`${BASE}/llms.txt`)).text()
      for (const name of ALL) expect(llms, name).toContain(name)
      const client = new Client({ name: "test", version: "1.0.0" })
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
          fetch: async (url, init) => {
            const headers = new Headers(init?.headers)
            headers.set("cookie", founder.cookie)
            headers.set("origin", BASE)
            return hq.app.request(String(url), { ...init, headers })
          },
        }),
      )
      const { tools } = await client.listTools()
      for (const name of ALL)
        expect(
          tools.map((t) => t.name),
          name,
        ).toContain(name)
      await client.close()
    })

    it("each description says what the caller may and may not do, and that text is untrusted", () => {
      for (const op of ops()) {
        expect(op.description, op.name).toContain("untrusted data")
        expect(op.description.length, op.name).toBeGreaterThan(150)
        expect(op.description, op.name).toMatch(/\b(never|not|cannot|nothing|no )\b/i)
      }
    })

    it("hints: reads are read-only and idempotent, writes are not read-only nor destructive", () => {
      for (const op of ops()) {
        if ((READS as readonly string[]).includes(op.name)) {
          expect(op.hints, op.name).toMatchObject({ readOnly: true, idempotent: true })
        } else {
          expect(op.hints, op.name).toMatchObject({ readOnly: false, destructive: false })
        }
      }
    })

    it("permissions reuse the agent scope: only hq_run, reads on read, create/update on writes", () => {
      for (const op of ops()) {
        expect(Object.keys(op.permissions), op.name).toEqual(["hq_run"])
        const actions = op.permissions.hq_run as string[]
        expect(actions, op.name).toHaveLength(1)
        expect(actions, op.name).toEqual([ACTION_OF[op.name as keyof typeof ACTION_OF]])
        // everything an operation needs is in the agent's scope
        for (const a of actions) expect(AGENT_SCOPE.hq_run).toContain(a)
      }
    })
  })

  // ---- no operation takes a target state ------------------------------------------------------------
  describe("no operation takes a target state", () => {
    it("no write operation's input has a field that accepts a state of a work item", () => {
      const end = new Set<string>(["done", "stopped", "reopened"])
      const enumsOf = (schema: z.ZodType): string[][] => {
        const def = schema as unknown as { def: Json }
        const type = def.def.type as string
        if (type === "enum") return [Object.values(def.def.entries as Record<string, string>)]
        if (type === "optional" || type === "nullable" || type === "default")
          return enumsOf(def.def.innerType as z.ZodType)
        if (type === "array") return enumsOf(def.def.element as z.ZodType)
        if (type === "object")
          return Object.values(def.def.shape as Record<string, z.ZodType>).flatMap(enumsOf)
        return []
      }
      for (const op of createHqOperations({ db: hq.db, now: () => clock })) {
        if (!ALL.includes(op.name as never) || (READS as readonly string[]).includes(op.name))
          continue
        for (const values of enumsOf(op.input as z.ZodType)) {
          expect(
            values.filter((v) => end.has(v)),
            op.name,
          ).toEqual([])
          expect(values.includes("plan") || values.includes("verify"), op.name).toBe(false)
        }
      }
    })

    it("no write operation's input has a field named state, to or targetState (record_pull_request.state and its checks' state are the exceptions)", () => {
      const fieldsOf = (schema: z.ZodType, path = ""): string[] => {
        const def = (schema as unknown as { def: Json }).def
        const type = def.type as string
        if (type === "optional" || type === "nullable" || type === "default")
          return fieldsOf(def.innerType as z.ZodType, path)
        if (type === "array") return fieldsOf(def.element as z.ZodType, `${path}[]`)
        if (type === "object") {
          return Object.entries(def.shape as Record<string, z.ZodType>).flatMap(([k, v]) => [
            `${path}.${k}`,
            ...fieldsOf(v, `${path}.${k}`),
          ])
        }
        return []
      }
      const refused = ["state", "to", "targetstate"]
      let scanned = 0
      for (const op of createHqOperations({ db: hq.db, now: () => clock })) {
        if (!ALL.includes(op.name as never) || (READS as readonly string[]).includes(op.name))
          continue
        scanned++
        const fields = fieldsOf(op.input as z.ZodType)
        for (const field of fields) {
          const name = field.split(".").pop()?.replace("[]", "").toLowerCase() ?? ""
          // the pull request's own state (open, merged, closed) and one check's (passed, failed,
          // pending): neither is a state of a work item, and the enum scan above covers values
          if (op.name === "record_pull_request" && [".state", ".checks[].state"].includes(field))
            continue
          expect(refused, `${op.name}${field}`).not.toContain(name)
        }
      }
      expect(scanned).toBe(WRITES.length)
    })

    it("no work operation file imports a founder-only data function", () => {
      const founderOnly = [
        "requestAttempt",
        "answerQuestion",
        "approveMerge",
        "stopItem",
        "reopenItem",
        "retryItem",
        "requestRevert",
        "createManualItem",
        "transitionItem",
      ]
      for (const file of [
        "work-signals.ts",
        "work-read.ts",
        "work-attempts.ts",
        "work-schemas.ts",
      ]) {
        const text = readFileSync(join(__dirname, file), "utf8")
        for (const name of founderOnly)
          expect(text, `${file} ${name}`).not.toMatch(new RegExp(`\\b${name}\\b`))
        // a file that holds queries is not an operation file
        expect(text, file).not.toMatch(/from "drizzle-orm"/)
        expect(text, file).not.toMatch(/from "\.\.\/db\//)
      }
    })

    it("the actor of every agent operation is set by the operation, never from the input", () => {
      for (const file of ["work-signals.ts", "work-attempts.ts"]) {
        const text = readFileSync(join(__dirname, file), "utf8")
        expect(text).not.toMatch(/type:\s*"founder"/)
        expect(text).not.toMatch(/actor:\s*input/)
      }
    })

    it("work-schemas.ts is shared with the web: it imports only zod and ../work/*", () => {
      const text = readFileSync(join(__dirname, "work-schemas.ts"), "utf8")
      const imports = [...text.matchAll(/^import[\s\S]*?from "([^"]+)"/gm)].map((m) => m[1])
      expect(imports.length).toBeGreaterThan(0)
      for (const from of imports)
        expect(from === "zod" || from?.startsWith("../work/"), from).toBe(true)
      expect(text).not.toMatch(/\bimport\b[^;]*\b(hono|react)\b/i)
      expect(Object.keys(schemas)).toEqual(
        expect.arrayContaining([
          "recordSignalInput",
          "workItemSummary",
          "workItemDetail",
          "workBoard",
          "attemptView",
          "questionView",
          "contractItemView",
          "pullRequestView",
          "needsYou",
        ]),
      )
    })

    it("seeded call orders: every change into done, stopped or reopened has its evidence, every other change is an agent or system row of TRANSITIONS", async () => {
      const ops = createHqOperations({ db: hq.db, now: () => clock })
      const caller: Caller = {
        organizationId: founder.orgId,
        actor: { type: "apiKey", keyId: "walk-key" },
        grants: [AGENT_SCOPE],
        via: "api-key",
      }
      const run = async (name: string, input: object) => {
        const op = ops.find((o) => o.name === name)
        if (!op) throw new Error(name)
        try {
          return (await invoke(op, input, { caller })) as Json
        } catch (e) {
          // a refusal is the machine doing its job; anything else is a bug
          if (e instanceof AppError && e.code !== "INTERNAL") return null
          throw e
        }
      }
      let s = 0x9e3779b9
      const rand = () => {
        s = (s + 0x6d2b79f5) | 0
        let t = Math.imul(s ^ (s >>> 15), 1 | s)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T
      const chance = (p: number) => rand() < p

      const reached = { done: 0, stopped: 0, reopened: { recurrence: 0, contract_failed: 0 } }
      const seen = new Set<string>()
      const known = new Map<string, WorkState>()
      let steps = 0

      const checkNewEvents = async () => {
        const rows = await hq.db
          .select()
          .from(workItemEvents)
          .orderBy(asc(workItemEvents.at), asc(workItemEvents.id))
        for (const e of rows) {
          if (seen.has(e.id)) continue
          seen.add(e.id)
          // nothing here is a founder
          expect(e.actorType, `${e.kind} ${e.reason}`).not.toBe("founder")
          if (e.kind !== "transition") continue
          const from = e.fromState as WorkState
          const to = e.toState as WorkState
          expect(known.get(e.itemId) ?? "signal", `${from}>${to}`).toBe(from)
          known.set(e.itemId, to)
          const edge = findTransition(from, to, e.actorType)
          expect(edge, `${from} > ${to} by ${e.actorType}`).not.toBeNull()
          expect(TRANSITIONS).toContain(edge)
          expect(edge?.reasons, `${from} > ${to}`).toContain(e.reason)
          if (to === "stopped") {
            expect([e.actorType, e.reason]).toEqual(["agent", "pull_request_closed"])
            reached.stopped++
          } else if (to === "reopened") {
            expect(e.actorType).toBe("system")
            expect(["recurrence", "contract_failed"]).toContain(e.reason)
            reached.reopened[e.reason as "recurrence" | "contract_failed"]++
          } else if (to === "done") {
            expect([e.actorType, e.reason, from]).toEqual(["system", "window_passed", "verify"])
            reached.done++
          }
        }
      }

      const shas = [SHA_A, SHA_B, "c".repeat(40)]
      for (let order = 0; order < 200; order++) {
        await resetWork(hq.db)
        clock = T0
        seen.clear()
        known.clear()
        const issues = [1, 2, 3].map((i) => order * 10 + i)
        const items: { id: string; ref: string; n: number }[] = []
        let prNumber = 1
        const itemRows = () => hq.db.select().from(workItems)
        const attemptRows = () => hq.db.select().from(attempts)

        for (let step = 0; step < 14; step++) {
          steps++
          const roll = rand()
          if (roll < 0.14 || items.length === 0) {
            const n = pick(issues)
            const out = await run("record_signal", {
              source: "github_issue",
              externalId: `github-issue:acme/web#${n}:${steps}`,
              dedupeKey: `github-issue:acme/web#${n}`,
              repo: "acme/web",
              title: `Issue ${n}`,
              summary: "walk",
            })
            if (out && !items.some((i) => i.id === out.itemId)) {
              items.push({ id: out.itemId, ref: out.displayId, n })
            }
          } else if (roll < 0.2) {
            tick(pick([MIN, 20 * MIN, 50 * MIN, 7 * HOUR, 8 * 24 * HOUR]))
          } else if (roll < 0.28) {
            await run("run_verification_sweep", {})
          } else if (roll < 0.34) {
            await run(pick(["list_work_items", "get_work_board", "list_attempts"]), {})
          } else {
            const target = pick(items)
            const [row] = (await itemRows()).filter((r) => r.id === target.id)
            const state = row?.state
            const mine = (await attemptRows()).filter((a) => a.itemId === target.id)
            const running = mine.find((a) => a.status === "running")
            const branch = `factory/walk-${target.n}`
            // a directed step most of the time, anything the operations accept some of the time
            const directed = chance(0.8)
            if (directed && state === "triage") {
              await run("start_attempt", {
                itemId: target.id,
                kind: "investigate",
                externalRef: `r${steps}`,
              })
              await run("set_contract", {
                itemId: target.ref,
                items: [
                  { text: "t", verifier: { kind: pick(["reviewer", "ci", "signal_recurrence"]) } },
                ],
              })
            } else if (directed && state === "plan") {
              if (running) {
                await run("finish_attempt", { attemptId: running.id, result: "investigated" })
              } else {
                await run("start_attempt", { itemId: target.id, kind: "fix", attemptLimit: 3 })
              }
            } else if (directed && (state === "attempt" || state === "review")) {
              if (running) {
                const act = pick(["heartbeat", "finish", "open", "merge", "close", "push"])
                if (act === "heartbeat")
                  await run("heartbeat_attempt", { attemptId: running.id, branch })
                else if (act === "finish") {
                  const approved = chance(0.8)
                  await run("finish_attempt", {
                    attemptId: running.id,
                    result: approved ? "approved" : pick(["rejected", "failed", "needs_answer"]),
                    reviewer: {
                      verdict: approved ? "approve" : "reject",
                      summary: "walk",
                      headSha: pick(shas),
                    },
                    branch,
                  })
                } else await recordPr(act)
              } else if (state === "review" && chance(0.5)) {
                await run("start_attempt", { itemId: target.id, kind: "fix" })
              } else {
                await recordPr(pick(["open", "merge", "close", "push"]))
              }
            } else if (directed && (state === "done" || state === "verify" || state === "deploy")) {
              if (chance(0.5)) {
                tick(pick([20 * MIN, 7 * HOUR]))
                await run("run_verification_sweep", {})
              } else {
                const n = target.n
                await run("record_signal", {
                  source: "github_issue",
                  externalId: `github-issue:acme/web#${n}:again${steps}`,
                  dedupeKey: `github-issue:acme/web#${n}`,
                  repo: "acme/web",
                  title: `Issue ${n}`,
                  summary: "again",
                })
              }
            } else {
              // anything: a random operation with a random, often wrong, input
              const kind = pick(["investigate", "fix"])
              await run(
                pick([
                  "start_attempt",
                  "claim_attempt",
                  "heartbeat_attempt",
                  "finish_attempt",
                  "ask_question",
                  "set_contract",
                ]),
                {
                  itemId: target.id,
                  attemptId: mine.length ? pick(mine.map((a) => a.id)) : crypto.randomUUID(),
                  kind,
                  result: pick(["investigated", "approved", "rejected", "failed", "needs_answer"]),
                  reviewer: {
                    verdict: pick(["approve", "reject", "request_changes"]),
                    summary: "x",
                  },
                  prompt: "q",
                  options: [
                    { id: "a", label: "A" },
                    { id: "b", label: "B" },
                  ],
                  items: [{ text: "t", verifier: { kind: "reviewer" } }],
                },
              )
            }
            async function recordPr(act: string) {
              const open = (
                await hq.db.select().from(workItems).where(eq(workItems.id, target.id))
              )[0]
              if (!open) return
              const number = act === "open" ? prNumber++ : Math.max(1, prNumber - 1)
              await run("record_pull_request", {
                itemId: target.id,
                branch,
                number,
                url: `https://github.com/acme/web/pull/${number}`,
                base: "main",
                headSha: act === "push" ? pick(shas) : SHA_A,
                isDraft: false,
                state: act === "merge" ? "merged" : act === "close" ? "closed" : "open",
                ...(act === "merge"
                  ? {
                      mergedAt: new Date(clock.getTime() - pick([0, MIN, HOUR])).toISOString(),
                      checks: [{ name: "ci", state: pick(["passed", "passed", "failed"]) }],
                    }
                  : {}),
              })
            }
          }
          await checkNewEvents()
          // the row says what the events say: no state changes without its event
          for (const row of await itemRows()) {
            expect(row.state, `${row.id} after step ${step} of order ${order}`).toBe(
              known.get(row.id) ?? "signal",
            )
          }
        }
      }
      // the walk is not vacuous: it reached each of the end states, by each kind of evidence
      expect(reached.done, "done").toBeGreaterThan(0)
      expect(reached.stopped, "stopped").toBeGreaterThan(0)
      expect(reached.reopened.recurrence, "reopened by a recurring signal").toBeGreaterThan(0)
      expect(reached.reopened.contract_failed, "reopened by a failed contract").toBeGreaterThan(0)
    }, 600_000)
  })
})
