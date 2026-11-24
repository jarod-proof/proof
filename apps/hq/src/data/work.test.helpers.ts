// Test-only helpers for the work pipeline's data layer. Production code never imports this file
// (work-items.test.ts scans for it). The rows are written straight to the tables, so a test can
// reach any state without walking the machine.
import type { Database } from "@proof/db"
import { eq, sql } from "drizzle-orm"

import { attempts, pullRequests, workItems } from "../db/schema"
import type { AttemptKind, AttemptResult, AttemptStatus, WorkState } from "../work/machine"
import type { PullRequestState } from "../work/types"
import { toWorkItemRow, type WorkItemRow } from "./work-items"

/** The fixed clock of the work tests. */
export const NOW = new Date("2026-11-17T12:00:00Z")
export const minutesAfter = (from: Date, minutes: number) =>
  new Date(from.getTime() + minutes * 60_000)
export const daysAfter = (from: Date, days: number) => minutesAfter(from, days * 24 * 60)

/** Empty the work tables and restart `FAC-` numbering (the events table's trigger spares TRUNCATE). */
export async function resetWork(db: Database): Promise<void> {
  await db.execute(sql`truncate table "hq"."work_items" restart identity cascade`)
}

export async function seedItem(
  db: Database,
  o: {
    title?: string
    repo?: string
    source?: "github_issue" | "ci_failure" | "manual"
    state?: WorkState
    cycle?: number
    dedupeKey?: string | null
    attemptLimit?: number | null
    now?: Date
  } = {},
): Promise<WorkItemRow> {
  const now = o.now ?? NOW
  const [row] = await db
    .insert(workItems)
    .values({
      id: crypto.randomUUID(),
      title: o.title ?? "A seeded item",
      repo: o.repo ?? "acme/web",
      source: o.source ?? "github_issue",
      state: o.state ?? "triage",
      cycle: o.cycle ?? 1,
      dedupeKey: o.dedupeKey === undefined ? null : o.dedupeKey,
      attemptLimit: o.attemptLimit ?? null,
      createdByType: "system",
      createdById: "test",
      createdAt: now,
      updatedAt: now,
      stateChangedAt: now,
    })
    .returning()
  if (!row) throw new Error("seedItem: no row")
  return toWorkItemRow(row)
}

/** Put an item in a state at an instant without an event (the instant is `state_changed_at`). */
export async function forceState(
  db: Database,
  itemId: string,
  state: WorkState,
  at: Date,
): Promise<void> {
  await db
    .update(workItems)
    .set({ state, stateChangedAt: at, updatedAt: at })
    .where(eq(workItems.id, itemId))
}

export async function seedAttempt(
  db: Database,
  itemId: string,
  o: {
    number: number
    cycle?: number
    kind?: AttemptKind
    status?: AttemptStatus
    result?: AttemptResult | null
    leaseExpiresAt?: Date | null
    files?: string[]
    branch?: string | null
    now?: Date
  },
) {
  const now = o.now ?? NOW
  const status = o.status ?? "finished"
  const [row] = await db
    .insert(attempts)
    .values({
      id: crypto.randomUUID(),
      itemId,
      number: o.number,
      cycle: o.cycle ?? 1,
      kind: o.kind ?? "fix",
      status,
      result: o.result === undefined ? (status === "finished" ? "failed" : null) : o.result,
      leaseExpiresAt: o.leaseExpiresAt ?? null,
      files: o.files ?? [],
      branch: o.branch ?? null,
      createdAt: now,
    })
    .returning()
  if (!row) throw new Error("seedAttempt: no row")
  return row
}

export async function seedPullRequest(
  db: Database,
  itemId: string,
  o: {
    number?: number
    state?: PullRequestState
    openedAt?: Date
    mergedAt?: Date | null
    repo?: string
    branch?: string
    attemptId?: string | null
  } = {},
) {
  const number = o.number ?? 7
  const openedAt = o.openedAt ?? NOW
  const [row] = await db
    .insert(pullRequests)
    .values({
      id: crypto.randomUUID(),
      itemId,
      number,
      url: `https://github.com/${o.repo ?? "acme/web"}/pull/${number}`,
      branch: o.branch ?? `factory/fix-${number}`,
      attemptId: o.attemptId ?? null,
      base: "main",
      headSha: "a".repeat(40),
      isDraft: false,
      state: o.state ?? "open",
      openedAt,
      mergedAt: o.mergedAt ?? null,
      updatedAt: openedAt,
    })
    .returning()
  if (!row) throw new Error("seedPullRequest: no row")
  return row
}
