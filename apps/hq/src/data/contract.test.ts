import { AppError } from "@proof/errors"
import { and, asc, eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { contractItems, workItemEvents } from "../db/schema"
import { createHqTestDb } from "../testing"
import type { ContractInput } from "../work/types"
import { claimAttempt, requestAttempt, startAttempt } from "./attempts"
import { setContract } from "./contract"
import { minutesAfter, NOW, resetWork, seedAttempt, seedItem } from "./work.test.helpers"
import { resolveItem } from "./work-items"

const AGENT = { type: "agent", id: "agent-key" } as const
const item1: ContractInput = {
  text: "The login form accepts a plus sign",
  verifier: { kind: "ci" },
}
const item2: ContractInput = {
  text: "The reviewer approves the fix",
  verifier: { kind: "reviewer" },
}
const item3: ContractInput = {
  text: "The error does not come back",
  verifier: { kind: "signal_recurrence", config: { window: "6h" } },
}

describe("contract (in-process Postgres)", () => {
  let test: Awaited<ReturnType<typeof createHqTestDb>>
  beforeAll(async () => {
    test = await createHqTestDb()
  })
  afterAll(async () => {
    await test.close()
  })
  beforeEach(async () => {
    await resetWork(test.db)
  })

  const db = () => test.db
  const set = (itemId: string, items: ContractInput[], o: { now?: Date } = {}) =>
    setContract(db(), { itemId, items, actor: AGENT, now: o.now ?? NOW })
  const rowsOf = (itemId: string, cycle?: number) =>
    db()
      .select()
      .from(contractItems)
      .where(
        and(
          eq(contractItems.itemId, itemId),
          cycle === undefined ? undefined : eq(contractItems.cycle, cycle),
        ),
      )
      .orderBy(asc(contractItems.cycle), asc(contractItems.position))
  const eventsOf = (itemId: string) =>
    db()
      .select()
      .from(workItemEvents)
      .where(eq(workItemEvents.itemId, itemId))
      .orderBy(asc(workItemEvents.at), asc(workItemEvents.id))
  const expectAppError = async (p: Promise<unknown>, code: string) => {
    const error = await p.then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe(code)
  }

  it("setContract replaces the cycle's items in order and is refused after the first fix attempt of the cycle started", async () => {
    const item = await seedItem(db(), { state: "plan" })
    const first = await set(item.id, [item1, item2])
    expect(first.map((r) => [r.position, r.text, r.verifierKind, r.status])).toEqual([
      [1, item1.text, "ci", "pending"],
      [2, item2.text, "reviewer", "pending"],
    ])
    expect(first[0]).toMatchObject({
      itemId: item.id,
      cycle: 1,
      evidence: null,
      checkedAt: null,
      createdByType: "agent",
      createdById: "agent-key",
    })

    // a second call replaces the whole set, in the order given
    const second = await set(item.id, [item3, item1, item2], { now: minutesAfter(NOW, 1) })
    expect(second.map((r) => r.text)).toEqual([item3.text, item1.text, item2.text])
    expect(second[0]?.verifierConfig).toEqual({ window: "6h" })
    expect((await rowsOf(item.id)).map((r) => [r.position, r.text])).toEqual([
      [1, item3.text],
      [2, item1.text],
      [3, item2.text],
    ])
    expect(second.map((r) => r.id)).not.toContain(first[0]?.id)

    // the first fix of the cycle starts: the contract is now fixed
    await startAttempt(db(), { itemId: item.id, kind: "fix", actor: AGENT, now: NOW })
    await expectAppError(set(item.id, [item1]), "CONFLICT")
    expect((await rowsOf(item.id)).map((r) => r.text)).toEqual([item3.text, item1.text, item2.text])
  })

  it("an investigation (or one that finished) does not fix the contract, a finished fix does", async () => {
    const item = await seedItem(db(), { state: "plan" })
    await seedAttempt(db(), item.id, { number: 1, kind: "investigate", status: "running" })
    await set(item.id, [item1])
    const done = await seedItem(db(), { state: "plan" })
    await seedAttempt(db(), done.id, { number: 1, kind: "fix", result: "failed" })
    await expectAppError(set(done.id, [item1]), "CONFLICT")
    const running = await seedItem(db(), { state: "plan" })
    await seedAttempt(db(), running.id, { number: 1, kind: "fix", status: "running", result: null })
    await expectAppError(set(running.id, [item1]), "CONFLICT")
    const abandoned = await seedItem(db(), { state: "plan" })
    await seedAttempt(db(), abandoned.id, { number: 1, kind: "fix", result: "abandoned" })
    await expectAppError(set(abandoned.id, [item1]), "CONFLICT")
  })

  it("a requested fix does not count as started: the contract can be set and the fix then claimed", async () => {
    const item = await seedItem(db(), { state: "plan" })
    const requested = await requestAttempt(db(), {
      itemId: item.id,
      kind: "fix",
      origin: "founder_request",
      founderId: "founder-1",
      now: NOW,
    })
    // without a contract the claim is refused by the machine's guard
    await expectAppError(
      claimAttempt(db(), { attemptId: requested.id, actor: AGENT, now: NOW }),
      "CONFLICT",
    )
    await set(item.id, [item1])
    const claimed = await claimAttempt(db(), {
      attemptId: requested.id,
      actor: AGENT,
      now: minutesAfter(NOW, 1),
    })
    expect(claimed.status).toBe("running")
    expect((await resolveItem(db(), item.id)).state).toBe("attempt")
  })

  it("a reopened item in cycle 2 (cycle 1 had a contract and three fixes) takes a new contract: cycle 2 rows exist, cycle 1 rows are untouched, and plan>attempt is allowed again", async () => {
    const item = await seedItem(db(), { state: "plan", cycle: 2, attemptLimit: 3 })
    await db().insert(contractItems).values({
      id: crypto.randomUUID(),
      itemId: item.id,
      cycle: 1,
      position: 1,
      text: "The old contract",
      verifierKind: "ci",
      status: "failing",
      evidence: "a check failed",
      createdByType: "agent",
      createdById: "agent-key",
    })
    for (const number of [1, 2, 3]) {
      await seedAttempt(db(), item.id, { number, cycle: 1, kind: "fix", result: "failed" })
    }
    const rows = await set(item.id, [item1, item2])
    expect(rows.map((r) => r.cycle)).toEqual([2, 2])
    const cycle1 = await rowsOf(item.id, 1)
    expect(cycle1).toHaveLength(1)
    expect(cycle1[0]).toMatchObject({ text: "The old contract", status: "failing" })
    const started = await startAttempt(db(), {
      itemId: item.id,
      kind: "fix",
      actor: AGENT,
      now: minutesAfter(NOW, 1),
    })
    expect(started).toMatchObject({ cycle: 2, number: 4 })
    expect((await resolveItem(db(), item.id)).state).toBe("attempt")
  })

  it("only an item in triage or plan takes a contract", async () => {
    for (const state of [
      "signal",
      "attempt",
      "review",
      "deploy",
      "verify",
      "done",
      "reopened",
      "stopped",
    ] as const) {
      const item = await seedItem(db(), { state })
      await expectAppError(set(item.id, [item1]), "CONFLICT")
      expect(await rowsOf(item.id)).toHaveLength(0)
    }
    const triage = await seedItem(db(), { state: "triage" })
    await set(triage.id, [item1])
    expect(await rowsOf(triage.id)).toHaveLength(1)
  })

  it("a verifier of kind sentry or posthog is BAD_REQUEST and writes nothing", async () => {
    const item = await seedItem(db(), { state: "plan" })
    await set(item.id, [item1])
    for (const kind of ["sentry", "posthog"] as const) {
      await expectAppError(
        set(item.id, [{ text: "No errors in Sentry", verifier: { kind } }]),
        "BAD_REQUEST",
      )
    }
    // the earlier contract is still there
    expect((await rowsOf(item.id)).map((r) => r.text)).toEqual([item1.text])
    await expectAppError(
      set(item.id, [{ text: "x", verifier: { kind: "nonsense" as never } }]),
      "BAD_REQUEST",
    )
  })

  it("0 and 9 items are refused and 8 are stored", async () => {
    const item = await seedItem(db(), { state: "plan" })
    await expectAppError(set(item.id, []), "BAD_REQUEST")
    const nine = Array.from({ length: 9 }, (_, i) => ({ ...item1, text: `Item ${i}` }))
    await expectAppError(set(item.id, nine), "BAD_REQUEST")
    expect(await rowsOf(item.id)).toHaveLength(0)
    const rows = await set(item.id, nine.slice(0, 8))
    expect(rows).toHaveLength(8)
  })

  it("text is capped at 300 characters, must not be empty and must be storable", async () => {
    const item = await seedItem(db(), { state: "plan" })
    const withText = (text: string): ContractInput[] => [{ text, verifier: { kind: "ci" } }]
    await expectAppError(set(item.id, withText("x".repeat(301))), "BAD_REQUEST")
    await expectAppError(set(item.id, withText("   ")), "BAD_REQUEST")
    await expectAppError(set(item.id, withText("a\u0000b")), "BAD_REQUEST")
    await expectAppError(set(item.id, "not a list" as never), "BAD_REQUEST")
    expect(await rowsOf(item.id)).toHaveLength(0)
    const rows = await set(item.id, withText("x".repeat(300)))
    expect(rows[0]?.text).toHaveLength(300)
  })

  it("a verifier config must be a small plain object", async () => {
    const item = await seedItem(db(), { state: "plan" })
    const withConfig = (config: unknown): ContractInput[] => [
      { text: "x", verifier: { kind: "ci", config: config as Record<string, unknown> } },
    ]
    await expectAppError(set(item.id, withConfig("text")), "BAD_REQUEST")
    await expectAppError(set(item.id, withConfig([1])), "BAD_REQUEST")
    await expectAppError(set(item.id, withConfig({ big: "x".repeat(20_001) })), "BAD_REQUEST")
    expect(await rowsOf(item.id)).toHaveLength(0)
  })

  it("an item id that is not a uuid is BAD_REQUEST, an unknown uuid is NOT_FOUND", async () => {
    await expectAppError(set("FAC-1", [item1]), "BAD_REQUEST")
    await expectAppError(set("", [item1]), "BAD_REQUEST")
    await expectAppError(set(crypto.randomUUID(), [item1]), "NOT_FOUND")
  })

  it("the author type is person for a founder, agent for an agent and system for hq", async () => {
    const a = await seedItem(db(), { state: "plan" })
    const f = await setContract(db(), {
      itemId: a.id,
      items: [item1],
      actor: { type: "founder", id: "founder-1" },
      now: NOW,
    })
    expect(f[0]).toMatchObject({ createdByType: "person", createdById: "founder-1" })
    const s = await setContract(db(), {
      itemId: a.id,
      items: [item1],
      actor: { type: "system", id: "hq" },
      now: NOW,
    })
    expect(s[0]).toMatchObject({ createdByType: "system", createdById: "hq" })
  })

  it("each set writes one contract_set event with the count, never the text", async () => {
    const item = await seedItem(db(), { state: "plan" })
    await set(item.id, [item1, item2])
    await set(item.id, [item3], { now: minutesAfter(NOW, 2) })
    const rows = await eventsOf(item.id)
    expect(rows.map((e) => e.kind)).toEqual(["contract_set", "contract_set"])
    expect(rows[0]).toMatchObject({
      actorType: "agent",
      actorId: "agent-key",
      cycle: 1,
      detail: { count: 2, replaced: 0 },
    })
    expect(rows[1]?.detail).toEqual({ count: 1, replaced: 2 })
    expect(JSON.stringify(rows)).not.toContain(item1.text)
  })
})
