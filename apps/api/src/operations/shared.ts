import { type Caller, decodeCursor, encodeCursor, operationsFor } from "@proof/api"
import type { Auth, Catalog } from "@proof/auth"
import type { Database } from "@proof/db"
import { AppError, reportError } from "@proof/errors"
import type { FileStore } from "@proof/storage"
import { z } from "zod"

import type { FlagService } from "../flags"
import type { Meter } from "../meter"
import type { ApiNotifier } from "../notifications"
import type { Operator } from "../tenant"

/** What the operation files draw on: the auth instance, the database, metering, notices and the clock. */
export interface OperationDeps {
  auth: Auth
  db: Database
  meter: Meter
  /** Sends the in-app notifications an operation's event causes (see ../notifications.ts). */
  notifier: ApiNotifier
  /** The clock: approval windows and timestamps read it, so tests can move time. */
  now: () => Date
  /** Where uploads go (STORAGE_DRIVER). Unset, uploads are off and their operations say so. */
  files?: FileStore
  /** The organization that runs the product: only it calls the operator operations. */
  operator: Operator
  /** Feature flag evaluation; the operator operations invalidate its cache after a write. */
  flags: FlagService
}

/**
 * Runs a notification after the operation's work is done. A notice never changes the response, so a
 * lookup or send that throws is reported and dropped here.
 */
export async function notifySafely(task: () => Promise<void>): Promise<void> {
  try {
    await task()
  } catch (error) {
    reportError(error, { phase: "notify" })
  }
}

/** The signed-in person behind a request, for "minus the actor" rules. Keys and agents have none. */
export const personUserId = (caller: Caller): string | undefined =>
  caller.actor.type === "user" ? caller.actor.userId : undefined

// Example operations. Each one is a REST route, an MCP tool, and an entry in openapi.json and
// llms.txt. Replace them with your product's; keep descriptions written for an agent reader.
// `permissions` is checked against the catalog in @proof/auth at compile time.
export const defineOperation = operationsFor<Catalog>()

// Keyset cursors: the position after the last row of a page, as the sort key (time and id).
// Year 0 is a valid ISO date but outside Postgres' timestamp range, so it would fail in the query.
const keyset = z.object({
  at: z.iso.datetime().refine((at) => new Date(at).getUTCFullYear() >= 1),
  id: z.string().min(1),
})

export function readCursor(cursor: string | undefined): z.output<typeof keyset> | undefined {
  // `?cursor=` (empty), as forms and URL templates send it, means the first page like no cursor.
  if (cursor === undefined || cursor === "") return undefined
  const parsed = keyset.safeParse(decodeCursor(cursor))
  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid cursor", {
      hint: "Pass nextCursor from the previous page unchanged, or omit cursor to start from the first page.",
    })
  }
  return parsed.data
}

/** Cut one page from `limit + 1` rows: the extra row only says whether there is a next page. */
export function cut<T extends { id: string }>(
  rows: readonly T[],
  limit: number,
  when: (row: T) => Date,
) {
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  const nextCursor =
    rows.length > limit && last ? encodeCursor({ at: when(last).toISOString(), id: last.id }) : null
  return { page, nextCursor }
}

export const actorType = (stored: string): "user" | "apiKey" =>
  stored === "apiKey" ? "apiKey" : "user"

/** Who is calling, as a run's startedBy records it. */
export const actorOf = (caller: Caller): { type: "user" | "apiKey"; id: string } =>
  caller.actor.type === "user"
    ? { type: "user", id: caller.actor.userId }
    : { type: "apiKey", id: caller.actor.keyId }

/** People see decisions; agents (keys, AI clients) see approvals only as pending until effective. */
export const viewerOf = (caller: Caller): "person" | "agent" =>
  caller.via === "session" ? "person" : "agent"

/**
 * Only a person signed in to the web app decides approvals: never a key, never an OAuth token.
 * Returns the person's user id, so the caller needs no second look at the actor.
 */
export function requirePerson(caller: Caller): string {
  if (caller.via !== "session" || caller.actor.type !== "user") {
    throw new AppError("FORBIDDEN", "Only a person can decide an approval", {
      hint: "Open the run in the web app and decide there. API keys and AI clients can't approve.",
    })
  }
  return caller.actor.userId
}

export const approvalOutputSchema = z.object({
  id: z.string(),
  stepId: z.string().nullable(),
  action: z.string().describe("The exact action, in words"),
  detail: z.string().nullable(),
  requestedAt: z.string(),
  status: z
    .enum(["pending", "approved", "denied"])
    .describe("For an agent: pending until the decision takes effect"),
  decision: z
    .object({
      decidedBy: z.string().nullable(),
      decidedAt: z.string().nullable(),
      effectiveAt: z.string().nullable(),
      undoableUntil: z.string().nullable().describe("Until when undo_approval works"),
    })
    .nullable()
    .describe("Shown to people only; null for agents"),
})

export const agentRef = z.object({ id: z.string().describe("Workspace agent id from list_agents") })
export const runRef = z.object({ id: z.string().describe("Run id from list_runs or start_run") })
export const approvalRef = z.object({ id: z.string().describe("Approval id from get_run") })
