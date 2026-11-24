import { AppError } from "@proof/errors"
import { asc, eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { agentQuestions, attempts, workItemEvents } from "../db/schema"
import { createHqTestDb } from "../testing"
import { deriveAttention } from "../work/machine"
import { answerQuestion, askQuestion } from "./questions"
import { minutesAfter, NOW, resetWork, seedAttempt, seedItem } from "./work.test.helpers"
import { loadFacts, lockItem, resolveItem } from "./work-items"

const AGENT = { type: "agent", id: "agent-key" } as const
const OPTIONS = [
  { id: "a", label: "Keep the old behaviour", detail: "Safe, but the bug stays." },
  { id: "b", label: "Change the contract" },
]

describe("agent questions (in-process Postgres)", () => {
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
  const ask = (
    itemId: string,
    o: Partial<Parameters<typeof askQuestion>[1]> = {},
    now: Date = NOW,
  ) =>
    askQuestion(db(), {
      itemId,
      prompt: "Which way should the fix go?",
      options: OPTIONS,
      actor: AGENT,
      now,
      ...o,
    })
  const answer = (
    questionId: string,
    o: Partial<Parameters<typeof answerQuestion>[1]> = {},
    now: Date = minutesAfter(NOW, 5),
  ) =>
    answerQuestion(db(), {
      questionId,
      optionId: "a",
      founderId: "founder-1",
      now,
      ...o,
    })
  const eventsOf = (itemId: string) =>
    db()
      .select()
      .from(workItemEvents)
      .where(eq(workItemEvents.itemId, itemId))
      .orderBy(asc(workItemEvents.at), asc(workItemEvents.id))
  const questionRow = async (id: string) => {
    const [row] = await db().select().from(agentQuestions).where(eq(agentQuestions.id, id))
    if (!row) throw new Error("no question")
    return row
  }
  const expectAppError = async (p: Promise<unknown>, code: string) => {
    const error = await p.then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe(code)
  }
  const factsOf = (itemId: string) =>
    db().transaction(async (tx) => loadFacts(tx, await lockItem(tx, itemId), NOW))

  describe("askQuestion", () => {
    it("stores an open question with its options and default, and one question_asked event", async () => {
      const item = await seedItem(db(), { state: "plan" })
      const attempt = await seedAttempt(db(), item.id, {
        number: 1,
        kind: "investigate",
        status: "running",
        result: null,
      })
      const q = await ask(item.id, { defaultOptionId: "b", attemptId: attempt.id })
      expect(q).toMatchObject({
        itemId: item.id,
        attemptId: attempt.id,
        prompt: "Which way should the fix go?",
        options: OPTIONS,
        defaultOptionId: "b",
        status: "open",
        answeredOptionId: null,
        answeredBy: null,
        answeredAt: null,
        createdAt: NOW,
      })
      const rows = await eventsOf(item.id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        kind: "question_asked",
        actorType: "agent",
        actorId: "agent-key",
        cycle: 1,
        detail: { questionId: q.id, attemptId: attempt.id },
      })
      // the open question is the item's attention, and the default is only advice
      const facts = await factsOf(item.id)
      expect(facts.openQuestion).toBe(true)
      expect(deriveAttention(facts)).toBe("agent_question")
    })

    it("needs 2 to 5 options, unique ids and a default among them", async () => {
      const item = await seedItem(db(), { state: "plan" })
      const opt = (id: string) => ({ id, label: `Option ${id}` })
      await expectAppError(ask(item.id, { options: [opt("a")] }), "BAD_REQUEST")
      await expectAppError(ask(item.id, { options: [] }), "BAD_REQUEST")
      await expectAppError(
        ask(item.id, { options: ["a", "b", "c", "d", "e", "f"].map(opt) }),
        "BAD_REQUEST",
      )
      await expectAppError(ask(item.id, { options: [opt("a"), opt("a")] }), "BAD_REQUEST")
      await expectAppError(ask(item.id, { defaultOptionId: "zzz" }), "BAD_REQUEST")
      await expectAppError(ask(item.id, { options: "x" as never }), "BAD_REQUEST")
      expect(await db().select().from(agentQuestions)).toHaveLength(0)
      expect(await eventsOf(item.id)).toHaveLength(0)
      const five = await ask(item.id, { options: ["a", "b", "c", "d", "e"].map(opt) })
      expect(five.options).toHaveLength(5)
      expect(five.defaultOptionId).toBeNull()
    })

    it("caps the prompt, labels, details and ids, and refuses empty text", async () => {
      const item = await seedItem(db(), { state: "plan" })
      const withOption = (o: Record<string, unknown>) => [
        { id: "a", label: "A", ...o },
        OPTIONS[1]!,
      ]
      await expectAppError(ask(item.id, { prompt: "x".repeat(2001) }), "BAD_REQUEST")
      await expectAppError(ask(item.id, { prompt: "  " }), "BAD_REQUEST")
      await expectAppError(ask(item.id, { prompt: "a\u0000b" }), "BAD_REQUEST")
      await expectAppError(
        ask(item.id, { options: withOption({ label: "x".repeat(201) }) }),
        "BAD_REQUEST",
      )
      await expectAppError(ask(item.id, { options: withOption({ label: "" }) }), "BAD_REQUEST")
      await expectAppError(
        ask(item.id, { options: withOption({ detail: "x".repeat(501) }) }),
        "BAD_REQUEST",
      )
      await expectAppError(
        ask(item.id, { options: withOption({ id: "x".repeat(101) }) }),
        "BAD_REQUEST",
      )
      await expectAppError(ask(item.id, { options: withOption({ id: "" }) }), "BAD_REQUEST")
      const ok = await ask(item.id, {
        prompt: "x".repeat(2000),
        options: withOption({
          label: "x".repeat(200),
          detail: "x".repeat(500),
          id: "x".repeat(100),
        }),
      })
      expect(ok.prompt).toHaveLength(2000)
    })

    it("an attempt id must be an attempt of this item", async () => {
      const item = await seedItem(db(), { state: "plan" })
      const other = await seedItem(db(), { state: "plan" })
      const foreign = await seedAttempt(db(), other.id, { number: 1 })
      await expectAppError(ask(item.id, { attemptId: foreign.id }), "BAD_REQUEST")
      await expectAppError(ask(item.id, { attemptId: crypto.randomUUID() }), "BAD_REQUEST")
      await expectAppError(ask(item.id, { attemptId: "not-a-uuid" }), "BAD_REQUEST")
      expect(await db().select().from(agentQuestions)).toHaveLength(0)
    })

    it("is refused for an item that is not in flight, and for an id that is not a uuid", async () => {
      for (const state of ["done", "stopped", "reopened"] as const) {
        const item = await seedItem(db(), { state })
        await expectAppError(ask(item.id), "CONFLICT")
      }
      await expectAppError(ask("FAC-1"), "BAD_REQUEST")
      await expectAppError(ask(crypto.randomUUID()), "NOT_FOUND")
      expect(await db().select().from(agentQuestions)).toHaveLength(0)
    })
  })

  describe("answerQuestion", () => {
    it("answering records the founder and the option, once; the second answer is CONFLICT", async () => {
      const item = await seedItem(db(), { state: "plan" })
      const q = await ask(item.id, { defaultOptionId: "b" })
      const at = minutesAfter(NOW, 5)
      const answered = await answer(
        q.id,
        { optionId: "a", note: "Go slow.", founderId: "founder-1" },
        at,
      )
      expect(answered).toMatchObject({
        id: q.id,
        status: "answered",
        answeredOptionId: "a",
        answerNote: "Go slow.",
        answeredBy: "founder-1",
        answeredAt: at,
        defaultOptionId: "b",
      })
      const rows = await eventsOf(item.id)
      expect(rows.map((e) => e.kind)).toEqual(["question_asked", "question_answered"])
      expect(rows[1]).toMatchObject({
        actorType: "founder",
        actorId: "founder-1",
        note: "Go slow.",
        cycle: 1,
        detail: { questionId: q.id, optionId: "a" },
        at,
      })
      await expectAppError(answer(q.id, { optionId: "b", founderId: "founder-2" }), "CONFLICT")
      const stored = await questionRow(q.id)
      expect(stored).toMatchObject({ answeredOptionId: "a", answeredBy: "founder-1" })
      expect(await eventsOf(item.id)).toHaveLength(2)
      expect((await factsOf(item.id)).openQuestion).toBe(false)
    })

    it("a withdrawn question cannot be answered", async () => {
      const item = await seedItem(db(), { state: "plan" })
      const q = await ask(item.id)
      await db()
        .update(agentQuestions)
        .set({ status: "withdrawn" })
        .where(eq(agentQuestions.id, q.id))
      await expectAppError(answer(q.id), "CONFLICT")
      expect(await questionRow(q.id)).toMatchObject({ status: "withdrawn", answeredBy: null })
      expect(await eventsOf(item.id)).toHaveLength(1)
    })

    it("the option must be one of the question's, and the note is capped", async () => {
      const item = await seedItem(db(), { state: "plan" })
      const q = await ask(item.id)
      await expectAppError(answer(q.id, { optionId: "zzz" }), "BAD_REQUEST")
      await expectAppError(answer(q.id, { optionId: "" }), "BAD_REQUEST")
      await expectAppError(answer(q.id, { note: "x".repeat(2001) }), "BAD_REQUEST")
      await expectAppError(answer(q.id, { note: "a\u0000" }), "BAD_REQUEST")
      await expectAppError(answer(q.id, { founderId: "" }), "BAD_REQUEST")
      expect((await questionRow(q.id)).status).toBe("open")
      const ok = await answer(q.id, { note: "x".repeat(2000) })
      expect(ok.answerNote).toHaveLength(2000)
    })

    it("an answer without a note stores none, and a blank one is none", async () => {
      const item = await seedItem(db(), { state: "plan" })
      const q = await ask(item.id)
      const answered = await answer(q.id, { note: "   " })
      expect(answered.answerNote).toBeNull()
    })

    it("creates no attempt and moves no item", async () => {
      const item = await seedItem(db(), { state: "plan" })
      const q = await ask(item.id)
      await answer(q.id)
      expect(await db().select().from(attempts)).toHaveLength(0)
      expect((await resolveItem(db(), item.id)).state).toBe("plan")
      expect((await eventsOf(item.id)).map((e) => e.kind)).not.toContain("transition")
    })

    it("an unknown question is NOT_FOUND and a malformed id is BAD_REQUEST", async () => {
      await expectAppError(answer(crypto.randomUUID()), "NOT_FOUND")
      await expectAppError(answer("not-a-uuid"), "BAD_REQUEST")
      await expectAppError(answer(""), "BAD_REQUEST")
    })
  })
})
