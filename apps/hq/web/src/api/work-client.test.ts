// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"

import { createFakeHq, fakeViolations } from "../test/fake-hq"
import {
  factoryStatusFixture,
  needsYouFixture,
  questionFixture,
  WORK_HEAD_SHA,
  WORK_IDS,
  workBoardFixture,
  workItemFixture,
  workItemsFixture,
} from "../test/fixtures"
import { createHqClient } from "./client"
import { HqError } from "./errors"
import { hqKeys } from "./query-keys"
import {
  factoryStatusSchema,
  needsYouSchema,
  workBoardSchema,
  workItemDetailSchema,
} from "./schemas"

const failure = async (promise: Promise<unknown>): Promise<HqError> => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(HqError)
  return error as HqError
}

describe("the work methods of the hq client", () => {
  it("getWorkBoard sends GET /v1/work/board with same-origin credentials and parses the board", async () => {
    const hq = createFakeHq()
    const board = await createHqClient({ fetch: hq.fetch }).getWorkBoard()
    expect(hq.sent).toHaveLength(1)
    expect(hq.sent[0]).toMatchObject({
      method: "GET",
      path: "/v1/work/board",
      credentials: "same-origin",
      body: undefined,
    })
    expect(board).toEqual(workBoardFixture())
    expect(workBoardSchema.safeParse(board).success).toBe(true)
  })

  it("the reads send one GET each: the list with its query, one item by uuid or FAC-<n>", async () => {
    const hq = createFakeHq()
    const client = createHqClient({ fetch: hq.fetch })
    const page = await client.listWorkItems({ state: "triage", query: "BLANK & co", limit: 5 })
    expect(page.items).toEqual([])
    const blank = await client.listWorkItems({ state: "triage", query: "blank page" })
    expect(blank.items.map((i) => i.displayId)).toEqual(["FAC-1"])
    expect(blank.nextCursor).toBeNull()
    expect(hq.sent[0]?.path).toBe("/v1/work-items")
    expect(new URLSearchParams(hq.sent[0]?.search).get("query")).toBe("BLANK & co")
    expect(new URLSearchParams(hq.sent[0]?.search).get("state")).toBe("triage")
    expect(new URLSearchParams(hq.sent[0]?.search).get("limit")).toBe("5")

    const byUuid = await client.getWorkItem({ itemId: WORK_IDS.review })
    const byDisplay = await client.getWorkItem({ itemId: "FAC-6" })
    expect(byUuid).toEqual(workItemFixture())
    expect(byDisplay).toEqual(byUuid)
    expect(workItemDetailSchema.safeParse(byUuid).success).toBe(true)
    expect(hq.sent.slice(2).map((s) => [s.method, s.path])).toEqual([
      ["GET", `/v1/work-items/${WORK_IDS.review}`],
      ["GET", "/v1/work-items/FAC-6"],
    ])
    // no body, no content-type on a read
    expect(hq.sent.every((s) => s.body === undefined)).toBe(true)
  })

  it("each founder method sends exactly one POST with a JSON body and the pinned path (answerQuestion to /v1/questions/<id>/answer, approveMerge to /v1/work-items/<id>/merge-approval with headSha)", async () => {
    // claim mode, so request_attempt is allowed; label mode is its own test below
    const hq = createFakeHq({ workBoard: workBoardFixture({ dispatch: "claim" }) })
    const client = createHqClient({ fetch: hq.fetch })
    const fetchSpy = vi.fn(hq.fetch)
    const spied = createHqClient({ fetch: fetchSpy as typeof fetch })

    const created = await spied.createWorkItem({
      title: "A new thing",
      repo: "acme/web",
      body: "More.",
    })
    expect(created.displayId).toBe("FAC-11")
    await spied.requestAttempt({
      itemId: WORK_IDS.triage,
      kind: "investigate",
      instructions: "Look",
    })
    await spied.answerQuestion({ questionId: WORK_IDS.question, optionId: "even", note: "ledger" })
    await spied.approveMerge({ itemId: "FAC-6", headSha: WORK_HEAD_SHA, note: "ok" })
    await spied.stopWorkItem({ itemId: WORK_IDS.triage, note: "later" })
    await spied.reopenWorkItem({ itemId: WORK_IDS.triage })
    await spied.retryWorkItem({ itemId: WORK_IDS.exhausted, note: "once more" })
    await spied.requestRevert({ itemId: WORK_IDS.done, note: "broke it" })

    const posts = hq.sent.filter((s) => s.method === "POST")
    expect(posts.map((s) => [s.path, s.body])).toEqual([
      ["/v1/work-items", { title: "A new thing", repo: "acme/web", body: "More." }],
      [
        `/v1/work-items/${WORK_IDS.triage}/attempt-requests`,
        { kind: "investigate", instructions: "Look" },
      ],
      [`/v1/questions/${WORK_IDS.question}/answer`, { optionId: "even", note: "ledger" }],
      ["/v1/work-items/FAC-6/merge-approval", { headSha: WORK_HEAD_SHA, note: "ok" }],
      [`/v1/work-items/${WORK_IDS.triage}/stop`, { note: "later" }],
      [`/v1/work-items/${WORK_IDS.triage}/reopen`, {}],
      [`/v1/work-items/${WORK_IDS.exhausted}/retry`, { note: "once more" }],
      [`/v1/work-items/${WORK_IDS.done}/revert-request`, { note: "broke it" }],
    ])
    // one call to fetch per method, JSON, same-origin, and the client never sets an Origin
    expect(fetchSpy).toHaveBeenCalledTimes(8)
    for (const [, init] of fetchSpy.mock.calls) {
      expect(init?.method).toBe("POST")
      expect(init?.credentials).toBe("same-origin")
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json")
      expect(new Headers(init?.headers).has("origin")).toBe(false)
    }
    expect(client).toBeTruthy()
  })

  it("the founder methods read what hq answers", async () => {
    const hq = createFakeHq({ workBoard: workBoardFixture({ dispatch: "claim" }) })
    const client = createHqClient({ fetch: hq.fetch })
    await expect(
      client.approveMerge({ itemId: WORK_IDS.review, headSha: WORK_HEAD_SHA }),
    ).resolves.toEqual({
      status: "approved",
      headSha: WORK_HEAD_SHA,
      pullRequestUrl: "https://github.com/acme/web/pull/106",
    })
    const answered = await client.answerQuestion({ questionId: WORK_IDS.question, optionId: "up" })
    expect(answered).toMatchObject({ status: "answered", answeredOptionId: "up" })
    await expect(client.retryWorkItem({ itemId: "FAC-5", note: "again" })).resolves.toEqual({
      attemptLimit: 4,
    })
    await expect(client.stopWorkItem({ itemId: "FAC-1" })).resolves.toEqual({ state: "stopped" })
    await expect(client.reopenWorkItem({ itemId: "FAC-1" })).resolves.toEqual({ state: "triage" })
    await expect(client.requestRevert({ itemId: "FAC-10" })).resolves.toEqual({ state: "reopened" })
    const attempt = await client.requestAttempt({ itemId: "FAC-1", kind: "investigate" })
    expect(attempt).toMatchObject({ status: "requested", kind: "investigate" })
  })

  it("a 409 is HqError kind conflict and a 403 forbidden", async () => {
    const hq = createFakeHq()
    const client = createHqClient({ fetch: hq.fetch })
    await client.approveMerge({ itemId: "FAC-6", headSha: WORK_HEAD_SHA })
    const again = await failure(client.approveMerge({ itemId: "FAC-6", headSha: WORK_HEAD_SHA }))
    expect(again).toMatchObject({ kind: "conflict", status: 409, code: "CONFLICT" })

    const stranger = createFakeHq({ caller: "non-founder" })
    const forbidden = await failure(
      createHqClient({ fetch: stranger.fetch }).stopWorkItem({ itemId: "FAC-1" }),
    )
    expect(forbidden).toMatchObject({ kind: "forbidden", status: 403, code: "FORBIDDEN" })
  })

  it("401, 404, 400 and a foreign Origin map as the Phase 3 table says", async () => {
    const client = (hq = createFakeHq()) => createHqClient({ fetch: hq.fetch })
    const out = createFakeHq({ caller: "signed-out" })
    expect((await failure(client(out).getWorkBoard())).kind).toBe("unauthorized")
    expect((await failure(client().getWorkItem({ itemId: "FAC-999" }))).kind).toBe("not-found")
    expect((await failure(client().getWorkItem({ itemId: "nope" }))).kind).toBe("bad-request")
    expect(
      (await failure(client().approveMerge({ itemId: "FAC-6", headSha: "not hex" }))).kind,
    ).toBe("bad-request")
    // a browser would add the Origin of another site only if the page were on it: hq says so
    const foreign: typeof fetch = (input, init) =>
      createFakeHq().fetch(input, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init?.headers)),
          origin: "https://evil.example",
        },
      })
    const bad = await failure(createHqClient({ fetch: foreign }).stopWorkItem({ itemId: "FAC-1" }))
    expect(bad.kind).toBe("untrusted-origin")
  })

  it("request_attempt in label mode is bad-request and surfaces hq's own message, and sends one POST", async () => {
    const hq = createFakeHq()
    const error = await failure(
      createHqClient({ fetch: hq.fetch }).requestAttempt({ itemId: "FAC-1", kind: "fix" }),
    )
    expect(error).toMatchObject({
      kind: "bad-request",
      status: 400,
      code: "BAD_REQUEST",
      message: "This factory starts attempts from the agent:build label",
    })
    expect(hq.sent.filter((s) => s.method === "POST")).toHaveLength(1)
  })

  it("a mutation is never retried: a 500 is one POST and a server error", async () => {
    const hq = createFakeHq()
    hq.state.nextError = { status: 500, body: { error: { code: "INTERNAL", message: "boom" } } }
    const error = await failure(
      createHqClient({ fetch: hq.fetch }).stopWorkItem({ itemId: "FAC-1" }),
    )
    expect(error.kind).toBe("server")
    expect(hq.sent).toHaveLength(1)
  })

  it("a reply with an unknown state is a server error (the schema is strict about enums)", async () => {
    const board = workBoardFixture()
    const bad = structuredClone(board)
    const card = bad.columns.flatMap((c) => c.items)[0] as { state: string }
    card.state = "paused"
    const hq = createFakeHq()
    const fetch: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify(bad), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    const error = await failure(createHqClient({ fetch }).getWorkBoard())
    expect(error).toMatchObject({ kind: "server", status: 200 })
    expect(error.message).toContain("/v1/work/board")
    expect(hq.sent).toHaveLength(0)

    const detail = { ...workItemFixture(), attention: "mystery" }
    const item: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify(detail), { status: 200 })
    expect(
      (await failure(createHqClient({ fetch: item }).getWorkItem({ itemId: "FAC-6" }))).kind,
    ).toBe("server")
    // and a needs-you kind the app does not know
    expect(
      needsYouSchema.safeParse({ ...needsYouFixture("merge_approval"), kind: "x" }).success,
    ).toBe(false)
  })

  it("hqKeys.workItem('FAC-1') starts with ['work']", () => {
    for (const key of [
      hqKeys.workBoard(),
      hqKeys.workItems(),
      hqKeys.workItems("cart"),
      hqKeys.workItem("FAC-1"),
    ]) {
      expect(key[0]).toBe("work")
    }
    expect(hqKeys.workItem("FAC-1")).toEqual(["work", "item", "FAC-1"])
    expect(hqKeys.workItems("a")).not.toEqual(hqKeys.workItems("b"))
    expect(hqKeys.work()).toEqual(["work"])
  })

  it("factoryStatusSchema parses a reply with work, with work null and with no work key, and keeps work (a zod object strips unknown keys by default)", () => {
    const base = createFakeHq().state.factoryStatus
    const work = { inFlight: 5, needsYou: 3, pendingMergeApprovals: 1, openQuestions: 1 }
    expect(factoryStatusSchema.parse({ ...base, work })).toMatchObject({ work })
    expect(factoryStatusSchema.parse({ ...base, work: null }).work).toBeNull()
    const { work: _dropped, ...older } = base
    expect(factoryStatusSchema.parse(older).work).toBeUndefined()
    expect(factoryStatusSchema.safeParse({ ...base, work: { inFlight: 1 } }).success).toBe(false)
  })

  it("the fake accepts a work key on get_factory_status and a pipeline key on get_digest without recording a violation, answers every new work route, and records a FakeHqError in fakeViolations for an unknown work path", async () => {
    const hq = createFakeHq()
    hq.state.factoryStatus = {
      ...hq.state.factoryStatus,
      work: { inFlight: 1, needsYou: 1, pendingMergeApprovals: 1, openQuestions: 0 },
    }
    const client = createHqClient({ fetch: hq.fetch })
    await expect(client.getFactoryStatus()).resolves.toMatchObject({ work: { needsYou: 1 } })
    // the digest's pipeline key (Task 19 builds it): the fake's digest reply is not strict about it
    hq.state.digest = { ...hq.state.digest, pipeline: null } as typeof hq.state.digest
    await expect(client.getDigest()).resolves.toMatchObject({ summary: { tone: "quiet" } })
    await client.getWorkBoard()
    await client.listWorkItems()
    await client.getWorkItem({ itemId: "FAC-1" })
    expect(fakeViolations).toHaveLength(0)

    for (const [method, path] of [
      ["GET", "/v1/work/nope"],
      ["POST", "/v1/work-items/FAC-1/delete"],
      ["POST", "/v1/signals"],
      ["GET", "/v1/work-items/FAC-1/attempts"],
      ["POST", "/v1/work/verification-sweep"],
    ] as const) {
      fakeViolations.length = 0
      const res = await hq.fetch(`http://localhost:3100${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
      })
      expect(res.status, path).toBe(404)
      expect(fakeViolations, path).toHaveLength(1)
      expect(fakeViolations[0]?.message).toContain(path)
    }
    // an unknown path outside the work prefixes stays a plain 404 (Phase 3's row)
    fakeViolations.length = 0
    expect((await hq.fetch("http://localhost:3100/v1/nope")).status).toBe(404)
    expect(fakeViolations).toHaveLength(0)
  })

  it("a default fake's get_factory_status.work is its board's own numbers, before and after a decision; a fresh hq's fixture stays zeros", async () => {
    const zeros = { inFlight: 0, needsYou: 0, pendingMergeApprovals: 0, openQuestions: 0 }
    expect(factoryStatusFixture().work).toEqual(zeros)
    const hq = createFakeHq({ workBoard: workBoardFixture({ dispatch: "claim" }) })
    const client = createHqClient({ fetch: hq.fetch })
    const work = async () => (await client.getFactoryStatus()).work
    expect(await work()).toEqual({
      inFlight: hq.state.workBoard.stats.inFlight,
      needsYou: hq.state.workBoard.stats.needsYou,
      pendingMergeApprovals: 1,
      openQuestions: 1,
    })
    expect(await work()).toEqual({
      inFlight: 5,
      needsYou: 3,
      pendingMergeApprovals: 1,
      openQuestions: 1,
    })
    await client.approveMerge({ itemId: "FAC-6", headSha: WORK_HEAD_SHA })
    expect(await work()).toEqual({
      inFlight: 5,
      needsYou: 2,
      pendingMergeApprovals: 0,
      openQuestions: 1,
    })
    await client.answerQuestion({ questionId: WORK_IDS.question, optionId: "up" })
    expect(await work()).toEqual({
      inFlight: 5,
      needsYou: 1,
      pendingMergeApprovals: 0,
      openQuestions: 0,
    })
    // a test that passes its own status keeps it until a decision changes the counts
    const own = createFakeHq({ factoryStatus: factoryStatusFixture() })
    expect((await createHqClient({ fetch: own.fetch }).getFactoryStatus()).work).toEqual(zeros)
  })

  it("openQuestions counts every open question of an item in flight, also one a merge approval hides", async () => {
    const hidden = questionFixture({
      id: "00000000-0000-4000-8000-000000000601",
      prompt: "Also this?",
    })
    const items = workItemsFixture()
    items[WORK_IDS.review] = workItemFixture({ questions: [hidden] })
    const hq = createFakeHq({ workItems: items })
    const client = createHqClient({ fetch: hq.fetch })
    // two open questions, one Needs you card for a question: hq counts the questions
    expect((await client.getFactoryStatus()).work).toMatchObject({
      openQuestions: 2,
      pendingMergeApprovals: 1,
    })
    await client.approveMerge({ itemId: "FAC-6", headSha: WORK_HEAD_SHA })
    // the approval is decided, the question the card hid comes forward
    const board = await client.getWorkBoard()
    expect(board.needsYou.map((n) => [n.displayId, n.kind])).toEqual([
      ["FAC-2", "agent_question"],
      ["FAC-5", "attempt_budget"],
      ["FAC-6", "agent_question"],
    ])
    expect(board.stats.needsYou).toBe(3)
    expect((await client.getFactoryStatus()).work).toMatchObject({
      needsYou: 3,
      pendingMergeApprovals: 0,
      openQuestions: 2,
    })
    expect((await client.getWorkItem({ itemId: "FAC-6" })).card.label).toBe("asking you")
  })

  it("the fake refuses a board or an item hq could not have sent", () => {
    const board = workBoardFixture()
    const extra = { ...board, extra: 1 } as unknown as typeof board
    expect(() => createFakeHq({ workBoard: extra })).toThrow(/key hq does not send/)
    const wrongOrder = { ...board, columns: [...board.columns].reverse() }
    expect(() => createFakeHq({ workBoard: wrongOrder })).toThrow(/five columns/)
    const item = workItemFixture()
    expect(() =>
      createFakeHq({ workItems: { [item.id]: { ...item, state: "paused" } as never } }),
    ).toThrow(/not what hq returns/)
    expect(() =>
      createFakeHq({ workItems: { [item.id]: { ...item, extra: true } as never } }),
    ).toThrow(/key hq does not send/)
    expect(() => createFakeHq({ workItems: { other: item } })).toThrow(/keyed by the item's id/)
  })
})
