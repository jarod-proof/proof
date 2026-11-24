import { createDb } from "@proof/db"
import { AppError } from "@proof/errors"
import { eq } from "drizzle-orm"
import { afterAll, describe, expect, it } from "vitest"

import { attempts, contractItems, workItemEvents, workItems } from "../db/schema"
import type { AttemptKind } from "../work/machine"
import { claimAttempt, requestAttempt, startAttempt } from "./attempts"
import { seedItem } from "./work.test.helpers"

// Two claims of one requested attempt must have one winner, and two starts with one externalRef
// must make one attempt. Both are decided inside Postgres (the item's row lock, the status
// predicate of the claim, the partial unique indexes), and PGlite has one connection and cannot
// show two transactions interleaving: on it removing the predicate passes every test. So this
// needs real Postgres and real, separate connections: a worktree's database (`pnpm wt new` makes
// `proof_wt_<name>`, migrated with hq's tables; run it through `mise exec` so DATABASE_URL is the
// worktree's) or HQ_TEST_DATABASE_URL, and only one named `*_wt_*` or `*_test`. Every id and repo
// it writes is its own (a random run tag), because an item's events are append-only and cannot
// be deleted: the rows stay in the throwaway database. Anywhere else it is skipped.
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

describe.skipIf(!REAL)(
  `attempts under real concurrency (real Postgres: ${dbName(realUrl)})`,
  () => {
    // Separate clients, each with its own pool: no shared connection or transaction.
    const clients = REAL && realUrl ? Array.from({ length: CLIENTS }, () => createDb(realUrl)) : []
    const [admin] = clients as [ReturnType<typeof createDb>]
    const run = crypto.randomUUID().slice(0, 8)
    const repo = `race-${run}/web`
    const now = new Date("2026-11-17T12:00:00Z")
    const agent = { type: "agent", id: `race-${run}` } as const
    const client = (i: number) => clients[i % CLIENTS] as typeof admin

    afterAll(async () => {
      await Promise.all(clients.map((c) => c.$client.end()))
    })

    const settle = <T>(p: Promise<T>) =>
      p.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )

    const newItem = (state: "triage" | "plan" | "review", withContract = false) =>
      seedItem(admin, { state, repo, attemptLimit: 3 }).then(async (item) => {
        if (withContract) {
          await admin.insert(contractItems).values({
            id: crypto.randomUUID(),
            itemId: item.id,
            cycle: 1,
            position: 1,
            text: "It works",
            verifierKind: "reviewer",
            status: "pending",
            createdByType: "system",
            createdById: "race",
          })
        }
        return item
      })

    const request = (itemId: string, kind: AttemptKind) =>
      requestAttempt(admin, {
        itemId,
        kind,
        origin: "founder_request",
        founderId: `founder-${run}`,
        now,
      })

    const winnersOfClaim = async (
      kind: AttemptKind,
      state: "triage" | "plan" | "review",
      withContract: boolean,
      round: number,
    ) => {
      const item = await newItem(state, withContract)
      const requested = await request(item.id, kind)
      const results = await Promise.all(
        Array.from({ length: CLIENTS }, (_, i) =>
          settle(
            claimAttempt(client(i), {
              attemptId: requested.id,
              externalRef: `ticket-${round}-${i}`,
              actor: agent,
              now,
            }),
          ),
        ),
      )
      const [row] = await admin.select().from(attempts).where(eq(attempts.id, requested.id))
      const events = await admin
        .select({ kind: workItemEvents.kind })
        .from(workItemEvents)
        .where(eq(workItemEvents.itemId, item.id))
      const [after] = await admin.select().from(workItems).where(eq(workItems.id, item.id))
      return { results, row, events, after }
    }

    it("two claims of one requested attempt have one winner", async () => {
      // Without the status predicate every claim "wins": the item's lock only serializes them, and
      // the loser, finding the attempt already running, would otherwise promote it a second time.
      // Several rounds and four claimers, because one lucky interleaving proves nothing.
      for (let round = 0; round < ROUNDS; round++) {
        const { results, row, events, after } = await winnersOfClaim(
          "investigate",
          "triage",
          false,
          round,
        )
        const winners = results.filter((r) => r.ok)
        const losers = results.filter((r) => !r.ok)
        expect(winners, `round ${round}`).toHaveLength(1)
        expect(losers, `round ${round}`).toHaveLength(CLIENTS - 1)
        for (const l of losers) {
          const error = l.ok ? null : l.error
          expect(error).toBeInstanceOf(AppError)
          expect((error as AppError).code).toBe("CONFLICT")
        }
        expect(row?.status).toBe("running")
        // the ticket stored is the winner's, and one start event and one move were written
        const winner = winners[0]
        expect(row?.externalRef).toBe(winner?.ok ? winner.value.externalRef : "unreachable")
        expect(
          events.filter((e) => e.kind === "attempt_started"),
          `round ${round}`,
        ).toHaveLength(1)
        expect(
          events.filter((e) => e.kind === "transition"),
          `round ${round}`,
        ).toHaveLength(1)
        expect(after?.state).toBe("plan")
      }
    })

    it("two claims of one requested fix have one winner and one move to attempt", async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const { results, row, events, after } = await winnersOfClaim("fix", "plan", true, round)
        expect(
          results.filter((r) => r.ok),
          `round ${round}`,
        ).toHaveLength(1)
        expect(row?.status).toBe("running")
        expect(
          events.filter((e) => e.kind === "attempt_started"),
          `round ${round}`,
        ).toHaveLength(1)
        expect(
          events.filter((e) => e.kind === "transition"),
          `round ${round}`,
        ).toHaveLength(1)
        expect(after?.state).toBe("attempt")
      }
    })

    it("two concurrent starts with one externalRef make one attempt", async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const item = await newItem("triage")
        const results = await Promise.all(
          Array.from({ length: CLIENTS }, (_, i) =>
            startAttempt(client(i), {
              itemId: item.id,
              kind: "investigate",
              externalRef: `session:${round}:analyst`,
              actor: agent,
              now,
            }),
          ),
        )
        expect(new Set(results.map((r) => r.id)).size, `round ${round}`).toBe(1)
        const rows = await admin.select().from(attempts).where(eq(attempts.itemId, item.id))
        expect(rows, `round ${round}`).toHaveLength(1)
        const events = await admin
          .select({ kind: workItemEvents.kind })
          .from(workItemEvents)
          .where(eq(workItemEvents.itemId, item.id))
        expect(events.filter((e) => e.kind === "attempt_started")).toHaveLength(1)
        expect(events.filter((e) => e.kind === "transition")).toHaveLength(1)
      }
    })

    it("simultaneous starts with different externalRefs have one winner", async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const item = await newItem("triage")
        const results = await Promise.all(
          Array.from({ length: CLIENTS }, (_, i) =>
            settle(
              startAttempt(client(i), {
                itemId: item.id,
                kind: "investigate",
                externalRef: `session:${round}:${i}`,
                actor: agent,
                now,
              }),
            ),
          ),
        )
        expect(
          results.filter((r) => r.ok),
          `round ${round}`,
        ).toHaveLength(1)
        for (const r of results) {
          if (!r.ok) expect((r.error as AppError).code).toBe("CONFLICT")
        }
        expect(
          await admin.select().from(attempts).where(eq(attempts.itemId, item.id)),
        ).toHaveLength(1)
      }
    })
  },
)
