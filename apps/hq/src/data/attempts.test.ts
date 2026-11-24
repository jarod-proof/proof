import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { AppError } from "@proof/errors"
import { and, asc, eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import { attempts, contractItems, pullRequests, workItemEvents, workItems } from "../db/schema"
import { ATTEMPT_LEASE_MINUTES, NOTE_MAX_CHARS } from "../work/constants"
import type { AttemptKind } from "../work/machine"
import { createHqTestDb } from "../testing"
import {
  claimAttempt,
  expireStaleAttempts,
  finishAttempt,
  heartbeatAttempt,
  listAttempts,
  requestAttempt,
  startAttempt,
} from "./attempts"
import {
  minutesAfter,
  NOW,
  resetWork,
  seedAttempt,
  seedItem,
  seedPullRequest,
} from "./work.test.helpers"
import { loadFacts, lockItem, resolveItem } from "./work-items"

const AGENT = { type: "agent", id: "agent-key" } as const
const FOUNDER = "founder-1"

const REVIEW = { verdict: "approve", summary: "Looks right." } as const

/** The text of every call of `requestAttempt(...)` in a source whose arguments never say `origin`. */
function callsWithoutOrigin(source: string): string[] {
  const found: string[] = []
  for (const m of source.matchAll(/\brequestAttempt\(/g)) {
    const index = m.index ?? 0
    if (/function\s+$/.test(source.slice(Math.max(0, index - 20), index))) continue // the definition
    let depth = 0
    let end = source.length - 1
    for (let i = index + "requestAttempt".length; i < source.length; i++) {
      if (source[i] === "(") depth++
      if (source[i] === ")") {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    const call = source.slice(index, end + 1)
    if (!/\borigin\b/.test(call)) found.push(call)
  }
  return found
}

describe("attempts (in-process Postgres)", () => {
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
  const stateOf = async (itemId: string) => (await resolveItem(db(), itemId)).state
  const events = (itemId: string) =>
    db()
      .select()
      .from(workItemEvents)
      .where(eq(workItemEvents.itemId, itemId))
      .orderBy(asc(workItemEvents.at))
  const eventKinds = async (itemId: string) => (await events(itemId)).map((e) => e.kind)
  const start = (
    itemId: string,
    o: { kind?: AttemptKind; externalRef?: string; attemptLimit?: number; now?: Date } = {},
  ) =>
    startAttempt(db(), {
      itemId,
      kind: o.kind ?? "investigate",
      ...(o.externalRef === undefined ? {} : { externalRef: o.externalRef }),
      ...(o.attemptLimit === undefined ? {} : { attemptLimit: o.attemptLimit }),
      actor: AGENT,
      now: o.now ?? NOW,
    })
  const contract = async (itemId: string, cycle = 1) => {
    await db().insert(contractItems).values({
      id: crypto.randomUUID(),
      itemId,
      cycle,
      position: 1,
      text: "It works",
      verifierKind: "reviewer",
      status: "pending",
      createdByType: "system",
      createdById: "test",
    })
  }
  const factsOf = async (itemId: string, now = NOW) =>
    db().transaction(async (tx) => loadFacts(tx, await lockItem(tx, itemId), now))
  const expectAppError = async (p: Promise<unknown>, code: string) => {
    const error = await p.then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe(code)
  }

  describe("start", () => {
    it("startAttempt investigate moves triage to plan and fix moves plan to attempt", async () => {
      const item = await seedItem(db(), { state: "triage" })
      const investigate = await start(item.id, { kind: "investigate" })
      expect(investigate).toMatchObject({
        status: "running",
        kind: "investigate",
        number: 1,
        cycle: 1,
        startedAt: NOW,
        leaseExpiresAt: minutesAfter(NOW, ATTEMPT_LEASE_MINUTES),
      })
      expect(await stateOf(item.id)).toBe("plan")
      await finishAttempt(db(), {
        actor: AGENT,
        attemptId: investigate.id,
        result: "investigated",
        now: minutesAfter(NOW, 5),
      })
      await contract(item.id)
      const fix = await start(item.id, { kind: "fix", now: minutesAfter(NOW, 6) })
      expect(fix).toMatchObject({ status: "running", kind: "fix", number: 2 })
      expect(await stateOf(item.id)).toBe("attempt")
      const transitions = (await events(item.id)).filter((e) => e.kind === "transition")
      expect(transitions.map((e) => [e.fromState, e.toState, e.reason, e.actorType])).toEqual([
        ["triage", "plan", "investigation_started", "agent"],
        ["plan", "attempt", "fix_started", "agent"],
      ])
    })

    it("the move and the start events of one start get strictly increasing instants (1 ms apart), so (at, id) ordering keeps the story", async () => {
      const item = await seedItem(db(), { state: "triage" })
      await start(item.id, { kind: "investigate" })
      const rows = await events(item.id)
      const move = rows.find((e) => e.kind === "transition")
      const started = rows.find((e) => e.kind === "attempt_started")
      expect(move?.at).toEqual(NOW)
      expect(started?.at).toEqual(new Date(NOW.getTime() + 1))
    })

    it("an investigate start in plan stays in plan and writes only the attempt event", async () => {
      const item = await seedItem(db(), { state: "plan" })
      await start(item.id, { kind: "investigate" })
      expect(await stateOf(item.id)).toBe("plan")
      expect(await eventKinds(item.id)).toEqual(["attempt_started"])
    })

    it("a fix start in plan without a contract is CONFLICT and writes nothing", async () => {
      const item = await seedItem(db(), { state: "plan" })
      await expectAppError(start(item.id, { kind: "fix" }), "CONFLICT")
      expect(await db().select().from(attempts)).toHaveLength(0)
      expect(await events(item.id)).toHaveLength(0)
      expect(await stateOf(item.id)).toBe("plan")
    })

    it("a fix attempt from review moves to attempt with reason retry_started", async () => {
      const item = await seedItem(db(), { state: "review", attemptLimit: 3 })
      await seedAttempt(db(), item.id, { number: 1, kind: "fix", result: "rejected" })
      const fix = await start(item.id, { kind: "fix" })
      expect(fix.number).toBe(2)
      expect(await stateOf(item.id)).toBe("attempt")
      const [moved] = (await events(item.id)).filter((e) => e.kind === "transition")
      expect(moved).toMatchObject({
        fromState: "review",
        toState: "attempt",
        reason: "retry_started",
      })
    })

    it("a fix from attempt stays in attempt, an investigate from attempt or review is CONFLICT", async () => {
      const inAttempt = await seedItem(db(), { state: "attempt" })
      const fix = await start(inAttempt.id, { kind: "fix" })
      expect(fix.status).toBe("running")
      expect(await stateOf(inAttempt.id)).toBe("attempt")
      await expectAppError(
        start((await seedItem(db(), { state: "attempt" })).id, { kind: "investigate" }),
        "CONFLICT",
      )
      await expectAppError(
        start((await seedItem(db(), { state: "review" })).id, { kind: "investigate" }),
        "CONFLICT",
      )
    })

    it("a fix from triage is CONFLICT", async () => {
      const item = await seedItem(db(), { state: "triage" })
      await expectAppError(start(item.id, { kind: "fix" }), "CONFLICT")
      expect(await stateOf(item.id)).toBe("triage")
    })

    it("an item outside triage, plan, attempt and review is CONFLICT, an unknown item NOT_FOUND", async () => {
      for (const state of ["signal", "deploy", "verify", "done", "reopened", "stopped"] as const) {
        const item = await seedItem(db(), { state })
        await expectAppError(start(item.id, { kind: "investigate" }), "CONFLICT")
      }
      await expectAppError(start(crypto.randomUUID()), "NOT_FOUND")
    })

    it("a second active attempt is CONFLICT and a finished one allows the next", async () => {
      const item = await seedItem(db(), { state: "triage" })
      const first = await start(item.id, { externalRef: "k1" })
      await expectAppError(start(item.id, { externalRef: "k2" }), "CONFLICT")
      await finishAttempt(db(), {
        actor: AGENT,
        attemptId: first.id,
        result: "investigated",
        now: minutesAfter(NOW, 1),
      })
      const next = await start(item.id, { externalRef: "k2", now: minutesAfter(NOW, 2) })
      expect(next.number).toBe(2)
    })

    it("numbers are 1, 2, 3 per item", async () => {
      const item = await seedItem(db(), { state: "triage" })
      const other = await seedItem(db(), { state: "triage" })
      const numbers: number[] = []
      for (const i of [1, 2, 3]) {
        const a = await start(item.id, { now: minutesAfter(NOW, i * 2) })
        numbers.push(a.number)
        await finishAttempt(db(), {
          actor: AGENT,
          attemptId: a.id,
          result: "investigated",
          now: minutesAfter(NOW, i * 2 + 1),
        })
      }
      expect(numbers).toEqual([1, 2, 3])
      expect((await start(other.id)).number).toBe(1)
    })

    it("attemptLimit is stored once and a later value is ignored", async () => {
      const item = await seedItem(db(), { state: "triage" })
      const a = await start(item.id, { attemptLimit: 3 })
      expect((await resolveItem(db(), item.id)).attemptLimit).toBe(3)
      await finishAttempt(db(), {
        actor: AGENT,
        attemptId: a.id,
        result: "investigated",
        now: minutesAfter(NOW, 1),
      })
      await start(item.id, { attemptLimit: 7, now: minutesAfter(NOW, 2) })
      expect((await resolveItem(db(), item.id)).attemptLimit).toBe(3)
    })

    it("an attemptLimit outside 1 to 10 is BAD_REQUEST and nothing is written", async () => {
      const item = await seedItem(db(), { state: "triage" })
      for (const attemptLimit of [0, 11, 1.5, -1]) {
        await expectAppError(start(item.id, { attemptLimit }), "BAD_REQUEST")
      }
      expect(await db().select().from(attempts)).toHaveLength(0)
    })

    it("the first limit applies to the very start that sets it", async () => {
      const item = await seedItem(db(), { state: "review" })
      await seedAttempt(db(), item.id, { number: 1, kind: "fix", result: "rejected" })
      await expectAppError(start(item.id, { kind: "fix", attemptLimit: 1 }), "CONFLICT")
      // the refused start rolled back whole, the limit too
      expect((await resolveItem(db(), item.id)).attemptLimit).toBeNull()
    })

    it("a fix start with attemptsUsed at the limit is CONFLICT, and an investigate start is not", async () => {
      const item = await seedItem(db(), { state: "plan", attemptLimit: 2 })
      await contract(item.id)
      await seedAttempt(db(), item.id, { number: 1, kind: "fix", result: "failed" })
      await seedAttempt(db(), item.id, { number: 2, kind: "fix", result: "rejected" })
      await expectAppError(start(item.id, { kind: "fix" }), "CONFLICT")
      expect(await stateOf(item.id)).toBe("plan")
      const investigate = await start(item.id, { kind: "investigate" })
      expect(investigate.number).toBe(3)
    })

    it("an investigate attempt does not count as used", async () => {
      const item = await seedItem(db(), { state: "plan", attemptLimit: 1 })
      await contract(item.id)
      await seedAttempt(db(), item.id, { number: 1, kind: "investigate", result: "investigated" })
      expect((await factsOf(item.id)).attemptsUsed).toBe(0)
      const fix = await start(item.id, { kind: "fix" })
      expect(fix.status).toBe("running")
      expect((await factsOf(item.id)).attemptsUsed).toBe(1)
    })

    it("the last allowed fix can start: its own row is not counted before the move", async () => {
      const item = await seedItem(db(), { state: "plan", attemptLimit: 2 })
      await contract(item.id)
      await seedAttempt(db(), item.id, { number: 1, kind: "fix", result: "failed" })
      const fix = await start(item.id, { kind: "fix" })
      expect(fix.number).toBe(2)
      expect(await stateOf(item.id)).toBe("attempt")
    })
  })

  describe("idempotency", () => {
    it("a start with an externalRef the item already holds returns the same attempt, writes no event and keeps the number", async () => {
      const item = await seedItem(db(), { state: "triage" })
      const first = await start(item.id, { externalRef: "s1:c1:analyst" })
      const before = await events(item.id)
      const again = await start(item.id, {
        externalRef: "s1:c1:analyst",
        now: minutesAfter(NOW, 3),
      })
      expect(again).toEqual(first)
      expect(await events(item.id)).toEqual(before)
      expect(await db().select().from(attempts)).toHaveLength(1)
    })

    it("a start with a different externalRef while one runs is CONFLICT", async () => {
      const item = await seedItem(db(), { state: "triage" })
      await start(item.id, { externalRef: "a" })
      await expectAppError(start(item.id, { externalRef: "b" }), "CONFLICT")
    })

    it("a same-key retry of the third fix (used 3 of 3, that fix running) returns the stored attempt and does not CONFLICT", async () => {
      const item = await seedItem(db(), { state: "review", attemptLimit: 3 })
      await seedAttempt(db(), item.id, { number: 1, kind: "fix", result: "failed" })
      await seedAttempt(db(), item.id, { number: 2, kind: "fix", result: "rejected" })
      const third = await start(item.id, { kind: "fix", externalRef: "s:c:implementer" })
      expect((await factsOf(item.id)).attemptsUsed).toBe(3)
      const retry = await start(item.id, { kind: "fix", externalRef: "s:c:implementer" })
      expect(retry).toEqual(third)
      expect(await db().select().from(attempts)).toHaveLength(3)
    })

    it("a different key at the limit is still CONFLICT", async () => {
      const item = await seedItem(db(), { state: "review", attemptLimit: 3 })
      await seedAttempt(db(), item.id, { number: 1, kind: "fix", result: "failed" })
      await seedAttempt(db(), item.id, { number: 2, kind: "fix", result: "rejected" })
      await seedAttempt(db(), item.id, { number: 3, kind: "fix", result: "rejected" })
      await expectAppError(start(item.id, { kind: "fix", externalRef: "other" }), "CONFLICT")
    })

    it("a same-key start whose attempt has finished, with the item since moved to review, returns it unchanged and moves nothing", async () => {
      const item = await seedItem(db(), { state: "attempt", attemptLimit: 1 })
      const fix = await start(item.id, { kind: "fix", externalRef: "s:c:implementer" })
      const finished = await finishAttempt(db(), {
        actor: AGENT,
        attemptId: fix.id,
        result: "failed",
        now: minutesAfter(NOW, 10),
      })
      await db().update(workItems).set({ state: "review" }).where(eq(workItems.id, item.id))
      const eventsBefore = await events(item.id)
      const again = await start(item.id, {
        kind: "fix",
        externalRef: "s:c:implementer",
        now: minutesAfter(NOW, 20),
      })
      expect(again).toEqual(finished)
      expect(again.status).toBe("finished")
      expect(await stateOf(item.id)).toBe("review")
      expect(await events(item.id)).toEqual(eventsBefore)
    })

    it("the same key on a stopped item still answers with the stored attempt", async () => {
      const item = await seedItem(db(), { state: "triage" })
      const first = await start(item.id, { externalRef: "k" })
      await db().update(workItems).set({ state: "stopped" }).where(eq(workItems.id, item.id))
      expect(await start(item.id, { externalRef: "k" })).toEqual(first)
    })

    it("the same key on another item is a different attempt", async () => {
      const a = await seedItem(db(), { state: "triage" })
      const b = await seedItem(db(), { state: "triage" })
      const first = await start(a.id, { externalRef: "k" })
      const second = await start(b.id, { externalRef: "k" })
      expect(second.id).not.toBe(first.id)
    })

    it("an empty, over-long or unstorable externalRef is BAD_REQUEST", async () => {
      const item = await seedItem(db(), { state: "triage" })
      for (const externalRef of ["", "x".repeat(201), "a\u0000b"]) {
        await expectAppError(start(item.id, { externalRef }), "BAD_REQUEST")
      }
    })
  })

  describe("cycles", () => {
    it("startAttempt and requestAttempt store the item's current cycle on the attempt", async () => {
      const a = await seedItem(db(), { state: "triage", cycle: 3 })
      const started = await start(a.id)
      expect(started.cycle).toBe(3)
      const b = await seedItem(db(), { state: "triage", cycle: 2 })
      const requested = await requestAttempt(db(), {
        itemId: b.id,
        kind: "investigate",
        origin: "founder_request",
        founderId: FOUNDER,
        now: NOW,
      })
      expect(requested.cycle).toBe(2)
    })

    it("a reopened item (cycle 2, after three fixes in cycle 1) starts an investigate and then, once a cycle 2 contract exists, a fix: attemptsUsed counts cycle 2 only (0, then 1), the attempts are numbered 5 and 6, and both carry cycle 2", async () => {
      const item = await seedItem(db(), { state: "triage", cycle: 2, attemptLimit: 3 })
      await seedAttempt(db(), item.id, {
        number: 1,
        cycle: 1,
        kind: "investigate",
        result: "investigated",
      })
      for (const n of [2, 3, 4]) {
        await seedAttempt(db(), item.id, { number: n, cycle: 1, kind: "fix", result: "rejected" })
      }
      expect((await factsOf(item.id)).attemptsUsed).toBe(0)
      const investigate = await start(item.id, { kind: "investigate" })
      expect(investigate).toMatchObject({ number: 5, cycle: 2 })
      await finishAttempt(db(), {
        actor: AGENT,
        attemptId: investigate.id,
        result: "investigated",
        now: minutesAfter(NOW, 1),
      })
      expect(await stateOf(item.id)).toBe("plan")
      // no cycle 2 contract yet: the cycle 1 contract does not carry over
      await contract(item.id, 1)
      await expectAppError(start(item.id, { kind: "fix", now: minutesAfter(NOW, 2) }), "CONFLICT")
      await contract(item.id, 2)
      expect((await factsOf(item.id)).attemptsUsed).toBe(0)
      const fix = await start(item.id, { kind: "fix", now: minutesAfter(NOW, 3) })
      expect(fix).toMatchObject({ number: 6, cycle: 2 })
      expect((await factsOf(item.id)).attemptsUsed).toBe(1)
    })

    it("an attempt still active from an older cycle blocks a new one (one active attempt per item)", async () => {
      const item = await seedItem(db(), { state: "triage", cycle: 2 })
      await seedAttempt(db(), item.id, {
        number: 1,
        cycle: 1,
        kind: "investigate",
        status: "running",
        leaseExpiresAt: minutesAfter(NOW, 30),
      })
      await expectAppError(start(item.id), "CONFLICT")
    })
  })

  describe("request and claim", () => {
    const request = (
      itemId: string,
      o: { kind?: AttemptKind; instructions?: string; now?: Date } = {},
    ) =>
      requestAttempt(db(), {
        itemId,
        kind: o.kind ?? "investigate",
        ...(o.instructions === undefined ? {} : { instructions: o.instructions }),
        origin: "founder_request",
        founderId: FOUNDER,
        now: o.now ?? NOW,
      })

    it("requestAttempt makes a requested attempt that counts as active but not as used", async () => {
      const item = await seedItem(db(), { state: "review", attemptLimit: 3 })
      const requested = await request(item.id, { kind: "fix", instructions: "Look at the retry" })
      expect(requested).toMatchObject({
        status: "requested",
        kind: "fix",
        number: 1,
        requestedBy: FOUNDER,
        instructions: "Look at the retry",
        startedAt: null,
        leaseExpiresAt: null,
        externalRef: null,
      })
      expect(await stateOf(item.id)).toBe("review")
      const facts = await factsOf(item.id)
      expect(facts.activeAttempt).toBe("fresh")
      expect(facts.attemptsUsed).toBe(0)
      expect(await eventKinds(item.id)).toEqual(["attempt_requested"])
      await expectAppError(request(item.id, { kind: "fix" }), "CONFLICT")
      await expectAppError(start(item.id, { kind: "fix", externalRef: "x" }), "CONFLICT")
    })

    it("requestAttempt records the origin on the event and moves no state", async () => {
      const item = await seedItem(db(), { state: "triage" })
      await requestAttempt(db(), {
        itemId: item.id,
        kind: "investigate",
        origin: "policy_dispatch",
        founderId: FOUNDER,
        now: NOW,
      })
      expect(await stateOf(item.id)).toBe("triage")
      const [event] = await events(item.id)
      expect(event).toMatchObject({
        kind: "attempt_requested",
        actorType: "founder",
        actorId: FOUNDER,
      })
      expect(event?.detail).toMatchObject({ origin: "policy_dispatch", kind: "investigate" })
    })

    it("a fix request from triage is CONFLICT, and so is a fix request at the limit", async () => {
      const triage = await seedItem(db(), { state: "triage" })
      await expectAppError(request(triage.id, { kind: "fix" }), "CONFLICT")
      const spent = await seedItem(db(), { state: "review", attemptLimit: 1 })
      await seedAttempt(db(), spent.id, { number: 1, kind: "fix", result: "rejected" })
      await expectAppError(request(spent.id, { kind: "fix" }), "CONFLICT")
      expect(await request(spent.id, { kind: "fix" }).catch(() => null)).toBeNull()
      expect(
        await db().select().from(attempts).where(eq(attempts.status, "requested")),
      ).toHaveLength(0)
    })

    it("instructions are capped and untrusted text is stored as text", async () => {
      const item = await seedItem(db(), { state: "triage" })
      await expectAppError(
        request(item.id, { instructions: "x".repeat(NOTE_MAX_CHARS + 1) }),
        "BAD_REQUEST",
      )
      await expectAppError(request(item.id, { instructions: "a\u0000b" }), "BAD_REQUEST")
      const ok = await request(item.id, { instructions: "x".repeat(NOTE_MAX_CHARS) })
      expect(ok.instructions).toHaveLength(NOTE_MAX_CHARS)
    })

    it("claimAttempt turns requested into running once, stores externalRef, and the second claim is CONFLICT", async () => {
      const item = await seedItem(db(), { state: "triage" })
      const requested = await requestAttempt(db(), {
        itemId: item.id,
        kind: "investigate",
        origin: "founder_request",
        founderId: FOUNDER,
        now: NOW,
      })
      const claimed = await claimAttempt(db(), {
        attemptId: requested.id,
        runId: "run-1",
        externalRef: "ticket-9",
        actor: AGENT,
        now: minutesAfter(NOW, 2),
      })
      expect(claimed).toMatchObject({
        id: requested.id,
        status: "running",
        runId: "run-1",
        externalRef: "ticket-9",
        claimedAt: minutesAfter(NOW, 2),
        startedAt: minutesAfter(NOW, 2),
        leaseExpiresAt: minutesAfter(NOW, 2 + ATTEMPT_LEASE_MINUTES),
        requestedBy: FOUNDER,
      })
      expect(await stateOf(item.id)).toBe("plan")
      await expectAppError(
        claimAttempt(db(), { attemptId: requested.id, actor: AGENT, now: minutesAfter(NOW, 3) }),
        "CONFLICT",
      )
      expect(await eventKinds(item.id)).toEqual([
        "attempt_requested",
        "transition",
        "attempt_started",
      ])
    })

    it("claiming a fix in plan takes plan to attempt (contract and budget), and without a contract it is CONFLICT and stays requested", async () => {
      const item = await seedItem(db(), { state: "plan", attemptLimit: 3 })
      const requested = await request(item.id, { kind: "fix" })
      await expectAppError(
        claimAttempt(db(), { attemptId: requested.id, actor: AGENT, now: NOW }),
        "CONFLICT",
      )
      const [row] = await db().select().from(attempts).where(eq(attempts.id, requested.id))
      expect(row?.status).toBe("requested")
      expect(await stateOf(item.id)).toBe("plan")
      await contract(item.id)
      const claimed = await claimAttempt(db(), { attemptId: requested.id, actor: AGENT, now: NOW })
      expect(claimed.status).toBe("running")
      expect(await stateOf(item.id)).toBe("attempt")
    })

    it("claiming the last allowed fix works: the claimed row is not counted against its own budget guard", async () => {
      const item = await seedItem(db(), { state: "plan", attemptLimit: 1 })
      await contract(item.id)
      const requested = await request(item.id, { kind: "fix" })
      const claimed = await claimAttempt(db(), { attemptId: requested.id, actor: AGENT, now: NOW })
      expect(claimed.status).toBe("running")
      expect(await stateOf(item.id)).toBe("attempt")
      expect((await factsOf(item.id)).attemptsUsed).toBe(1)
      // and at the limit with the fix used, a new request is refused
      await finishAttempt(db(), {
        actor: AGENT,
        attemptId: claimed.id,
        result: "failed",
        now: minutesAfter(NOW, 1),
      })
      await db().update(workItems).set({ state: "review" }).where(eq(workItems.id, item.id))
      await expectAppError(request(item.id, { kind: "fix" }), "CONFLICT")
    })

    it("claiming a fix in review takes review to attempt with reason retry_started", async () => {
      const item = await seedItem(db(), { state: "review", attemptLimit: 3 })
      const requested = await request(item.id, { kind: "fix" })
      await claimAttempt(db(), { attemptId: requested.id, actor: AGENT, now: NOW })
      const [moved] = (await events(item.id)).filter((e) => e.kind === "transition")
      expect(moved).toMatchObject({ toState: "attempt", reason: "retry_started" })
    })

    it("a claim keeps no externalRef when none is sent, and an unknown attempt is NOT_FOUND", async () => {
      const item = await seedItem(db(), { state: "triage" })
      const requested = await request(item.id)
      const claimed = await claimAttempt(db(), { attemptId: requested.id, actor: AGENT, now: NOW })
      expect(claimed.externalRef).toBeNull()
      await expectAppError(
        claimAttempt(db(), { attemptId: crypto.randomUUID(), actor: AGENT, now: NOW }),
        "NOT_FOUND",
      )
    })

    it("a claim whose externalRef another attempt of the item holds is CONFLICT and stays requested", async () => {
      const item = await seedItem(db(), { state: "triage" })
      const first = await start(item.id, { externalRef: "taken" })
      await finishAttempt(db(), {
        actor: AGENT,
        attemptId: first.id,
        result: "investigated",
        now: NOW,
      })
      const requested = await request(item.id)
      await expectAppError(
        claimAttempt(db(), {
          attemptId: requested.id,
          externalRef: "taken",
          actor: AGENT,
          now: NOW,
        }),
        "CONFLICT",
      )
      const [still] = await db().select().from(attempts).where(eq(attempts.id, requested.id))
      expect(still?.status).toBe("requested")
    })

    it("a claim of a running or finished attempt is CONFLICT", async () => {
      const item = await seedItem(db(), { state: "triage" })
      const running = await start(item.id)
      await expectAppError(
        claimAttempt(db(), { attemptId: running.id, actor: AGENT, now: NOW }),
        "CONFLICT",
      )
    })

    it("a needs_answer attempt does not count as used", async () => {
      const item = await seedItem(db(), { state: "attempt", attemptLimit: 1 })
      const fix = await start(item.id, { kind: "fix" })
      expect((await factsOf(item.id)).attemptsUsed).toBe(1)
      const asked = await finishAttempt(db(), {
        actor: AGENT,
        attemptId: fix.id,
        result: "needs_answer",
        now: minutesAfter(NOW, 1),
      })
      expect(asked.result).toBe("needs_answer")
      const facts = await factsOf(item.id)
      expect(facts.attemptsUsed).toBe(0)
      expect(facts.attemptsRemaining).toBe(true)
      // so the next fix may start at a limit of 1
      const again = await start(item.id, { kind: "fix", now: minutesAfter(NOW, 2) })
      expect(again.number).toBe(2)
    })

    it("requestAttempt takes origin founder_request or policy_dispatch; a call without origin fails typecheck (attempts.types.ts)", async () => {
      const item = await seedItem(db(), { state: "triage" })
      const loose = requestAttempt as (
        db: unknown,
        input: Record<string, unknown>,
      ) => Promise<unknown>
      const base = { itemId: item.id, kind: "investigate", founderId: FOUNDER, now: NOW }
      await expectAppError(loose(db(), base), "BAD_REQUEST")
      await expectAppError(loose(db(), { ...base, origin: "nobody" }), "BAD_REQUEST")
      expect(await db().select().from(attempts)).toHaveLength(0)
      for (const origin of ["founder_request", "policy_dispatch"] as const) {
        const fresh = await seedItem(db(), { state: "triage" })
        const made = await requestAttempt(db(), {
          itemId: fresh.id,
          kind: "investigate",
          origin,
          founderId: FOUNDER,
          now: NOW,
        })
        expect(made.status).toBe("requested")
      }
    })

    it("the origin scan flags a call without origin and accepts one with it", () => {
      expect(callsWithoutOrigin("await requestAttempt(db, { itemId, kind })")).toHaveLength(1)
      expect(
        callsWithoutOrigin('await requestAttempt(db, { itemId, kind, origin: "founder_request" })'),
      ).toEqual([])
      expect(
        callsWithoutOrigin(
          "await requestAttempt(\n  db,\n  { itemId: pick(a, b), kind },\n)\nconst x = { origin }",
        ),
      ).toHaveLength(1)
      expect(callsWithoutOrigin("export async function requestAttempt(\n  db: Database,")).toEqual(
        [],
      )
    })

    it("every call of requestAttempt in src passes origin", () => {
      const root = join(import.meta.dirname, "..")
      const without: string[] = []
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name)
          if (statSync(path).isDirectory()) {
            if (name !== "node_modules") walk(path)
          } else if (/\.tsx?$/.test(name) && !/\.test\.|\.types\.ts$/.test(name)) {
            if (callsWithoutOrigin(readFileSync(path, "utf8")).length > 0) without.push(path)
          }
        }
      }
      walk(root)
      expect(without).toEqual([])
    })
  })

  describe("finish and heartbeat", () => {
    const running = async (
      kind: AttemptKind = "investigate",
      state: "triage" | "attempt" = "triage",
    ) => {
      const item = await seedItem(db(), { state: kind === "fix" ? "attempt" : state })
      const attempt = await start(item.id, { kind })
      return { item, attempt }
    }

    it("finish validates kind against result and requires a reviewer for approved and rejected", async () => {
      const inv = await running("investigate")
      for (const result of ["approved", "rejected"] as const) {
        await expectAppError(
          finishAttempt(db(), {
            actor: AGENT,
            attemptId: inv.attempt.id,
            result,
            reviewer: REVIEW,
            now: NOW,
          }),
          "BAD_REQUEST",
        )
      }
      const fix = await running("fix")
      await expectAppError(
        finishAttempt(db(), {
          actor: AGENT,
          attemptId: fix.attempt.id,
          result: "investigated",
          now: NOW,
        }),
        "BAD_REQUEST",
      )
      for (const result of ["approved", "rejected"] as const) {
        await expectAppError(
          finishAttempt(db(), { actor: AGENT, attemptId: fix.attempt.id, result, now: NOW }),
          "BAD_REQUEST",
        )
      }
      // abandoned is the sweep's alone
      await expectAppError(
        finishAttempt(db(), {
          actor: AGENT,
          attemptId: fix.attempt.id,
          result: "abandoned" as never,
          now: NOW,
        }),
        "BAD_REQUEST",
      )
      // a verdict that contradicts the result
      await expectAppError(
        finishAttempt(db(), {
          actor: AGENT,
          attemptId: fix.attempt.id,
          result: "approved",
          reviewer: { verdict: "request_changes", summary: "no" },
          now: NOW,
        }),
        "BAD_REQUEST",
      )
      await expectAppError(
        finishAttempt(db(), {
          actor: AGENT,
          attemptId: fix.attempt.id,
          result: "rejected",
          reviewer: { verdict: "approve", summary: "yes" },
          now: NOW,
        }),
        "BAD_REQUEST",
      )
      // none of the refusals finished the attempt
      const [row] = await db().select().from(attempts).where(eq(attempts.id, fix.attempt.id))
      expect(row?.status).toBe("running")
      for (const result of ["failed", "needs_answer"] as const) {
        const f = await running("fix")
        const done = await finishAttempt(db(), {
          actor: AGENT,
          attemptId: f.attempt.id,
          result,
          now: NOW,
        })
        expect(done.result).toBe(result)
      }
    })

    it("finish stamps the result, duration, files, branch, session, reviewer and the head sha of the PR on its branch", async () => {
      const { item, attempt } = await running("fix")
      const pr = await seedPullRequest(db(), item.id, { number: 11 })
      const done = await finishAttempt(db(), {
        actor: AGENT,
        attemptId: attempt.id,
        result: "approved",
        note: "All good",
        files: ["src/a.ts", "src/b.ts"],
        branch: pr.branch,
        sessionId: "sess-1",
        reviewer: REVIEW,
        now: minutesAfter(NOW, 12),
      })
      expect(done).toMatchObject({
        status: "finished",
        result: "approved",
        finishedAt: minutesAfter(NOW, 12),
        durationMs: 12 * 60_000,
        note: "All good",
        files: ["src/a.ts", "src/b.ts"],
        branch: pr.branch,
        sessionId: "sess-1",
        reviewerVerdict: "approve",
        reviewerSummary: "Looks right.",
        reviewedHeadSha: pr.headSha,
      })
      const finished = (await events(item.id)).filter((e) => e.kind === "attempt_finished")
      expect(finished).toHaveLength(1)
      expect(finished[0]).toMatchObject({ actorType: "agent", actorId: AGENT.id })
      expect(finished[0]?.detail).toMatchObject({ result: "approved", number: 1 })
    })

    it("a finish with no recorded pull request stores a null head sha", async () => {
      const { attempt } = await running("investigate")
      const done = await finishAttempt(db(), {
        actor: AGENT,
        attemptId: attempt.id,
        result: "investigated",
        now: minutesAfter(NOW, 1),
      })
      expect(done.reviewedHeadSha).toBeNull()
    })

    it("a finish by an attempt with no branch (finish and heartbeat both sent none) takes the item's newest pull request head, so an approval is never bound to any head", async () => {
      const other = await running("fix")
      await seedPullRequest(db(), other.item.id, { number: 2, openedAt: NOW })
      await seedPullRequest(db(), other.item.id, { number: 3, openedAt: minutesAfter(NOW, 1) })
      await db()
        .update(pullRequests)
        .set({ headSha: "c".repeat(40) })
        .where(and(eq(pullRequests.itemId, other.item.id), eq(pullRequests.number, 3)))
      const noBranch = await finishAttempt(db(), {
        actor: AGENT,
        attemptId: other.attempt.id,
        result: "failed",
        now: minutesAfter(NOW, 2),
      })
      expect(noBranch.branch).toBeNull()
      expect(noBranch.reviewedHeadSha).toBe("c".repeat(40))
    })

    it("a finish whose branch matches no pull request (a cross-cycle pull request on a different branch) stores null, never that pull request's sha", async () => {
      const { item, attempt } = await running("fix")
      await seedPullRequest(db(), item.id, { number: 3 })
      const done = await finishAttempt(db(), {
        actor: AGENT,
        attemptId: attempt.id,
        result: "failed",
        branch: "agent/the-new-cycle-branch",
        now: minutesAfter(NOW, 1),
      })
      expect(done.reviewedHeadSha).toBeNull()
    })

    it("a finish takes the head sha from the pull request on the attempt's branch, not the item's newest (another cycle's pull request is another branch)", async () => {
      const { item, attempt } = await running("fix")
      const first = await seedPullRequest(db(), item.id, { number: 1, openedAt: NOW })
      await seedPullRequest(db(), item.id, { number: 2, openedAt: minutesAfter(NOW, 5) })
      await db()
        .update(pullRequests)
        .set({ headSha: "b".repeat(40) })
        .where(and(eq(pullRequests.itemId, item.id), eq(pullRequests.number, 1)))
      // the branch comes from the heartbeat, not from the finish
      await heartbeatAttempt(db(), {
        attemptId: attempt.id,
        branch: first.branch,
        now: minutesAfter(NOW, 6),
      })
      const done = await finishAttempt(db(), {
        actor: AGENT,
        attemptId: attempt.id,
        result: "failed",
        now: minutesAfter(NOW, 7),
      })
      expect(done.reviewedHeadSha).toBe("b".repeat(40))
    })

    it("finishing twice with the same result returns the stored attempt; with a different result it is CONFLICT", async () => {
      const { item, attempt } = await running("fix")
      const first = await finishAttempt(db(), {
        actor: AGENT,
        attemptId: attempt.id,
        result: "failed",
        note: "first note",
        now: minutesAfter(NOW, 5),
      })
      const before = await events(item.id)
      const again = await finishAttempt(db(), {
        actor: AGENT,
        attemptId: attempt.id,
        result: "failed",
        note: "second note",
        now: minutesAfter(NOW, 9),
      })
      expect(again).toEqual(first)
      expect(await events(item.id)).toEqual(before)
      await expectAppError(
        finishAttempt(db(), {
          actor: AGENT,
          attemptId: attempt.id,
          result: "needs_answer",
          now: minutesAfter(NOW, 9),
        }),
        "CONFLICT",
      )
    })

    it("finishing a requested attempt is CONFLICT and an unknown one NOT_FOUND", async () => {
      const item = await seedItem(db(), { state: "triage" })
      const requested = await requestAttempt(db(), {
        itemId: item.id,
        kind: "investigate",
        origin: "founder_request",
        founderId: FOUNDER,
        now: NOW,
      })
      await expectAppError(
        finishAttempt(db(), { actor: AGENT, attemptId: requested.id, result: "failed", now: NOW }),
        "CONFLICT",
      )
      await expectAppError(
        finishAttempt(db(), {
          actor: AGENT,
          attemptId: crypto.randomUUID(),
          result: "failed",
          now: NOW,
        }),
        "NOT_FOUND",
      )
    })

    it("untrusted text is capped: a note over 2000 characters, 201 files, an unstorable branch", async () => {
      const { attempt } = await running("fix")
      const base = { attemptId: attempt.id, result: "failed" as const, now: NOW }
      await expectAppError(
        finishAttempt(db(), { actor: AGENT, ...base, note: "x".repeat(NOTE_MAX_CHARS + 1) }),
        "BAD_REQUEST",
      )
      await expectAppError(
        finishAttempt(db(), {
          actor: AGENT,
          ...base,
          files: Array.from({ length: 201 }, (_, i) => `f${i}`),
        }),
        "BAD_REQUEST",
      )
      await expectAppError(
        finishAttempt(db(), { actor: AGENT, ...base, branch: "a\u0000b" }),
        "BAD_REQUEST",
      )
      await expectAppError(
        finishAttempt(db(), {
          actor: AGENT,
          attemptId: attempt.id,
          result: "approved",
          reviewer: { verdict: "approve", summary: "x".repeat(NOTE_MAX_CHARS + 1) },
          now: NOW,
        }),
        "BAD_REQUEST",
      )
    })

    it("a heartbeat extends the lease to now + 45 minutes and is CONFLICT after the finish", async () => {
      const { attempt } = await running("investigate")
      const at = minutesAfter(NOW, 30)
      const beat = await heartbeatAttempt(db(), {
        attemptId: attempt.id,
        branch: "agent/x",
        files: ["a.ts"],
        note: "halfway",
        now: at,
      })
      expect(beat.leaseExpiresAt).toEqual(minutesAfter(at, ATTEMPT_LEASE_MINUTES))
      const [row] = await db().select().from(attempts).where(eq(attempts.id, attempt.id))
      expect(row).toMatchObject({
        branch: "agent/x",
        files: ["a.ts"],
        note: "halfway",
        lastHeartbeatAt: at,
        leaseExpiresAt: minutesAfter(at, ATTEMPT_LEASE_MINUTES),
      })
      await finishAttempt(db(), {
        actor: AGENT,
        attemptId: attempt.id,
        result: "investigated",
        now: minutesAfter(at, 1),
      })
      await expectAppError(
        heartbeatAttempt(db(), { attemptId: attempt.id, now: minutesAfter(at, 2) }),
        "CONFLICT",
      )
    })

    it("a heartbeat that sends nothing keeps the stored branch, files and note", async () => {
      const { attempt } = await running("investigate")
      await heartbeatAttempt(db(), {
        attemptId: attempt.id,
        branch: "agent/x",
        files: ["a.ts"],
        note: "n",
        now: minutesAfter(NOW, 1),
      })
      await heartbeatAttempt(db(), { attemptId: attempt.id, now: minutesAfter(NOW, 2) })
      const [row] = await db().select().from(attempts).where(eq(attempts.id, attempt.id))
      expect(row).toMatchObject({ branch: "agent/x", files: ["a.ts"], note: "n" })
    })

    it("a heartbeat after the lease expired, on an abandoned or a requested attempt is CONFLICT", async () => {
      const { attempt } = await running("investigate")
      await expectAppError(
        heartbeatAttempt(db(), {
          attemptId: attempt.id,
          now: minutesAfter(NOW, ATTEMPT_LEASE_MINUTES),
        }),
        "CONFLICT",
      )
      await expireStaleAttempts(db(), minutesAfter(NOW, ATTEMPT_LEASE_MINUTES + 1))
      await expectAppError(
        heartbeatAttempt(db(), {
          attemptId: attempt.id,
          now: minutesAfter(NOW, ATTEMPT_LEASE_MINUTES + 2),
        }),
        "CONFLICT",
      )
      const item = await seedItem(db(), { state: "plan" })
      const requested = await requestAttempt(db(), {
        itemId: item.id,
        kind: "investigate",
        origin: "founder_request",
        founderId: FOUNDER,
        now: NOW,
      })
      await expectAppError(
        heartbeatAttempt(db(), { attemptId: requested.id, now: NOW }),
        "CONFLICT",
      )
      await expectAppError(
        heartbeatAttempt(db(), { attemptId: crypto.randomUUID(), now: NOW }),
        "NOT_FOUND",
      )
    })

    it("a heartbeat caps its files at 200 paths and its note at 2000 characters", async () => {
      const { attempt } = await running("investigate")
      await expectAppError(
        heartbeatAttempt(db(), {
          attemptId: attempt.id,
          files: Array.from({ length: 201 }, (_, i) => `f${i}`),
          now: NOW,
        }),
        "BAD_REQUEST",
      )
      await expectAppError(
        heartbeatAttempt(db(), {
          attemptId: attempt.id,
          note: "x".repeat(NOTE_MAX_CHARS + 1),
          now: NOW,
        }),
        "BAD_REQUEST",
      )
      await heartbeatAttempt(db(), {
        attemptId: attempt.id,
        files: Array.from({ length: 200 }, (_, i) => `f${i}`),
        now: NOW,
      })
    })

    it("expireStaleAttempts marks an attempt whose lease passed as abandoned and returns its id, and does nothing for a fresh one", async () => {
      const stale = await running("investigate")
      const fresh = await running("investigate")
      await heartbeatAttempt(db(), {
        attemptId: fresh.attempt.id,
        now: minutesAfter(NOW, ATTEMPT_LEASE_MINUTES - 1),
      })
      const at = minutesAfter(NOW, ATTEMPT_LEASE_MINUTES + 1)
      expect(await expireStaleAttempts(db(), at)).toEqual([stale.attempt.id])
      const [row] = await db().select().from(attempts).where(eq(attempts.id, stale.attempt.id))
      expect(row).toMatchObject({
        status: "finished",
        result: "abandoned",
        finishedAt: at,
        durationMs: (ATTEMPT_LEASE_MINUTES + 1) * 60_000,
      })
      const [still] = await db().select().from(attempts).where(eq(attempts.id, fresh.attempt.id))
      expect(still?.status).toBe("running")
      const abandoned = (await events(stale.item.id)).filter((e) => e.kind === "attempt_abandoned")
      expect(abandoned).toHaveLength(1)
      expect(abandoned[0]).toMatchObject({ actorType: "system" })
      // a second pass over the same clock changes nothing
      expect(await expireStaleAttempts(db(), at)).toEqual([])
      expect(
        (await events(stale.item.id)).filter((e) => e.kind === "attempt_abandoned"),
      ).toHaveLength(1)
      // the item does not move: the attempt is gone, the item still says where it is
      expect(await stateOf(stale.item.id)).toBe("plan")
    })

    it("an abandoned fix frees the item but still counts as used (the budget counts fixes that ran)", async () => {
      const item = await seedItem(db(), { state: "attempt", attemptLimit: 1 })
      const fix = await start(item.id, { kind: "fix", externalRef: "a" })
      expect((await factsOf(item.id)).attemptsUsed).toBe(1)
      await expireStaleAttempts(db(), minutesAfter(NOW, ATTEMPT_LEASE_MINUTES + 1))
      const facts = await factsOf(item.id, minutesAfter(NOW, 60))
      expect(facts.activeAttempt).toBe("none")
      // an abandoned fix still counts as used (it ran): the limit of 1 is spent
      expect(facts.attemptsUsed).toBe(1)
      await expectAppError(
        start(item.id, { kind: "fix", externalRef: "b", now: minutesAfter(NOW, 60) }),
        "CONFLICT",
      )
      expect(fix.number).toBe(1)
    })

    it("a requested attempt is never expired", async () => {
      const item = await seedItem(db(), { state: "triage" })
      await requestAttempt(db(), {
        itemId: item.id,
        kind: "investigate",
        origin: "founder_request",
        founderId: FOUNDER,
        now: NOW,
      })
      expect(await expireStaleAttempts(db(), minutesAfter(NOW, 24 * 60))).toEqual([])
    })
  })

  describe("listAttempts", () => {
    it("filters by status, item and externalRef and returns the item title and repo", async () => {
      const a = await seedItem(db(), { state: "triage", title: "Alpha", repo: "acme/web" })
      const b = await seedItem(db(), { state: "triage", title: "Beta", repo: "acme/api" })
      const first = await start(a.id, { externalRef: "ref-a" })
      await finishAttempt(db(), {
        actor: AGENT,
        attemptId: first.id,
        result: "investigated",
        now: NOW,
      })
      const second = await start(a.id, { externalRef: "ref-a2", now: minutesAfter(NOW, 1) })
      const requested = await requestAttempt(db(), {
        itemId: b.id,
        kind: "investigate",
        instructions: "Please look",
        origin: "founder_request",
        founderId: FOUNDER,
        now: minutesAfter(NOW, 2),
      })
      const all = await listAttempts(db(), {})
      expect(all.map((e) => e.attemptId)).toEqual([first.id, second.id, requested.id])
      expect(await listAttempts(db(), { status: "requested" })).toEqual([
        {
          attemptId: requested.id,
          itemId: b.id,
          displayId: b.displayId,
          kind: "investigate",
          status: "requested",
          title: "Beta",
          repo: "acme/api",
          instructions: "Please look",
          externalRef: null,
        },
      ])
      expect((await listAttempts(db(), { itemId: a.id })).map((e) => e.attemptId)).toEqual([
        first.id,
        second.id,
      ])
      const byRef = await listAttempts(db(), { externalRef: "ref-a2" })
      expect(byRef).toHaveLength(1)
      expect(byRef[0]).toMatchObject({ attemptId: second.id, title: "Alpha", repo: "acme/web" })
      expect(await listAttempts(db(), { status: "finished", itemId: b.id })).toEqual([])
    })
  })
})
