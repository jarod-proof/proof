import { createDb } from "@proof/db"
import { eq, inArray } from "drizzle-orm"
import { afterAll, describe, expect, it } from "vitest"

import { signals, workItems } from "../db/schema"
import { recordSignal } from "./signals"
import { forceState } from "./work.test.helpers"

// Two signals with one dedupe key must make one item. The advisory lock in data/signals.ts is what
// guarantees it, and PGlite has one connection and cannot show two transactions interleaving: on it
// deleting the lock passes every test. So this needs real Postgres and real, separate connections:
// a worktree's database (`pnpm wt new` makes `proof_wt_<name>`, migrated with hq's tables) or
// HQ_TEST_DATABASE_URL, and only one named `*_wt_*` or `*_test`. Every key and id it writes is its
// own (a random run tag), because an item's events are append-only and cannot be deleted: the rows
// stay in the throwaway database. Anywhere else it is skipped, and the skip says so.
const dbName = (url: string | undefined) => (url ? new URL(url).pathname.slice(1) : "")
const explicitUrl = process.env.HQ_TEST_DATABASE_URL
const ambientUrl = process.env.DATABASE_URL
const realUrl = /(_wt_|_test$)/.test(dbName(explicitUrl))
  ? explicitUrl
  : /_wt_/.test(dbName(ambientUrl))
    ? ambientUrl
    : undefined
const REAL = realUrl !== undefined

const CLIENTS = 4
const ROUNDS = 20

describe.skipIf(!REAL)(`signals under real concurrency (real Postgres: ${dbName(realUrl)})`, () => {
  // Separate clients, each with its own pool: no shared connection or transaction.
  const clients = REAL && realUrl ? Array.from({ length: CLIENTS }, () => createDb(realUrl)) : []
  const [admin] = clients as [ReturnType<typeof createDb>]
  const run = crypto.randomUUID().slice(0, 8)
  const repo = `race-${run}/web`
  const now = new Date("2026-11-17T12:00:00Z")
  const recorder = { type: "agent", id: `race-${run}` } as const
  const send = (i: number, n: number, tag: string) =>
    recordSignal(clients[i % CLIENTS] as typeof admin, {
      source: "github_issue",
      externalId: `${repo}#${n}:${tag}`,
      dedupeKey: `github-issue:${repo}#${n}`,
      repo,
      title: `Race ${n}`,
      summary: "two at once",
      recorder,
      now,
    })

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.$client.end()))
  })

  it("two simultaneous signals with one dedupe key make one item and two signals", async () => {
    // Without the lock both see no item and each makes its own; several rounds, because one
    // lucky interleaving proves nothing.
    for (let round = 0; round < ROUNDS; round++) {
      const n = 500 + round
      const results = await Promise.all([send(0, n, "a"), send(1, n, "b")])
      const key = `github-issue:${repo}#${n}`
      const items = await admin
        .select({ id: workItems.id })
        .from(workItems)
        .where(eq(workItems.dedupeKey, key))
      expect(items, `round ${round}`).toHaveLength(1)
      const rows = await admin
        .select({ id: signals.id })
        .from(signals)
        .where(eq(signals.dedupeKey, key))
      expect(rows, `round ${round}`).toHaveLength(2)
      expect(results.map((r) => r.outcome).sort()).toEqual(["attached", "created"])
    }
  })

  it("four simultaneous signals with one dedupe key make one item and four signals", async () => {
    // Several rounds, because one lucky interleaving proves nothing. Without the lock every
    // client sees no item and each makes its own.
    for (let round = 0; round < ROUNDS; round++) {
      const n = 1000 + round
      const results = await Promise.all(
        Array.from({ length: CLIENTS }, (_, i) => send(i, n, `delivery-${i}`)),
      )
      const items = await admin
        .select({ id: workItems.id })
        .from(workItems)
        .where(eq(workItems.dedupeKey, `github-issue:${repo}#${n}`))
      expect(items, `round ${round}`).toHaveLength(1)
      const rows = await admin
        .select({ id: signals.id })
        .from(signals)
        .where(eq(signals.dedupeKey, `github-issue:${repo}#${n}`))
      expect(rows, `round ${round}`).toHaveLength(CLIENTS)
      expect(new Set(results.map((r) => r.itemId)).size).toBe(1)
      expect(results.filter((r) => r.outcome === "created")).toHaveLength(1)
      expect(results.filter((r) => r.outcome === "attached")).toHaveLength(CLIENTS - 1)
    }
  })

  it("one external id under two dedupe keys at once makes one signal and one item", async () => {
    // Two keys take two advisory locks, so the unique constraint on (source, external_id) is what
    // decides: the loser rolls back whole, including the item it had just made, and answers with
    // the winner's signal.
    for (let round = 0; round < ROUNDS; round++) {
      const a = 4000 + 2 * round
      const shared = `${repo}#shared-${round}`
      const sendKey = (i: number, n: number) =>
        recordSignal(clients[i % CLIENTS] as typeof admin, {
          source: "github_issue",
          externalId: shared,
          dedupeKey: `github-issue:${repo}#${n}`,
          repo,
          title: `Shared ${round}`,
          summary: "one id, two keys",
          recorder,
          now,
        })
      const results = await Promise.all([sendKey(0, a), sendKey(1, a + 1)])
      expect(results.map((r) => r.outcome).sort(), `round ${round}`).toEqual([
        "created",
        "duplicate",
      ])
      expect(new Set(results.map((r) => r.signalId)).size).toBe(1)
      expect(new Set(results.map((r) => r.itemId)).size).toBe(1)
      const rows = await admin
        .select({ id: signals.id })
        .from(signals)
        .where(eq(signals.externalId, shared))
      expect(rows, `round ${round}`).toHaveLength(1)
      const keys = [`github-issue:${repo}#${a}`, `github-issue:${repo}#${a + 1}`]
      const items = await admin
        .select({ id: workItems.id })
        .from(workItems)
        .where(inArray(workItems.dedupeKey, keys))
      expect(items, `round ${round}`).toHaveLength(1)
    }
  })

  it("simultaneous redeliveries of one signal make one signal", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const n = 2000 + round
      const results = await Promise.all(
        Array.from({ length: CLIENTS }, (_, i) => send(i, n, "same-delivery")),
      )
      const rows = await admin
        .select({ id: signals.id })
        .from(signals)
        .where(eq(signals.dedupeKey, `github-issue:${repo}#${n}`))
      expect(rows, `round ${round}`).toHaveLength(1)
      expect(results.filter((r) => r.outcome === "created")).toHaveLength(1)
      expect(results.filter((r) => r.outcome === "duplicate")).toHaveLength(CLIENTS - 1)
    }
  })

  it("simultaneous signals for an item in verify reopen it once", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const n = 3000 + round
      const first = await send(0, n, "first")
      await forceState(admin, first.itemId, "verify", now)
      const results = await Promise.all(
        Array.from({ length: CLIENTS }, (_, i) => send(i, n, `again-${i}`)),
      )
      expect(
        results.filter((r) => r.outcome === "reopened"),
        `round ${round}`,
      ).toHaveLength(1)
      expect(results.filter((r) => r.outcome === "attached")).toHaveLength(CLIENTS - 1)
      const [item] = await admin
        .select({ state: workItems.state })
        .from(workItems)
        .where(inArray(workItems.id, [first.itemId]))
      expect(item?.state).toBe("reopened")
    }
  })
})
