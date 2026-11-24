// Signals: something that may need work. `recordSignal` is the door every signal comes through
// (the agent's `record_signal`): it validates the outside text, then in one transaction under a
// per-dedupe-key advisory lock either makes an item, attaches to the newest one for the key or
// reopens it (a recurrence). A signal never starts work: an item it makes waits in triage.
import type { Database } from "@proof/db"
import { AppError } from "@proof/errors"
import { desc, and, eq, sql } from "drizzle-orm"

import { signals, workItems } from "../db/schema"
import { RECURRENCE_REOPEN_DAYS } from "../work/constants"
import { CONNECTED_SIGNAL_SOURCES, SIGNAL_SOURCES, type SignalSource } from "../work/machine"
import type { RecordSignalInput } from "../work/types"
import { closeRunningWindow } from "./decisions"
import { isUniqueViolation } from "./entries"
import {
  type Actor,
  checkPayload,
  checkRepo,
  checkText,
  createItemFromSignal,
  ID_MAX_CHARS,
  lockItem,
  storeSignal,
  type StoredSignal,
  SUMMARY_MAX_CHARS,
  TITLE_MAX_CHARS,
  transitionItem,
  URL_MAX_CHARS,
  type WorkItemRow,
  toWorkItemRow,
} from "./work-items"

export interface RecordSignalResult {
  signalId: string
  itemId: string
  displayId: string
  outcome: "created" | "attached" | "reopened" | "duplicate"
}

/** The dedupe key of each source; group 1 is the repo, which hq lower-cases. */
const DEDUPE_PATTERNS: Partial<Record<SignalSource, RegExp>> = {
  github_issue: /^github-issue:([\w.-]+\/[\w.-]+)#\d+$/,
  ci_failure: /^ci:([\w.-]+\/[\w.-]+):[^:\s]+:[\w.-]+$/,
  manual: /^manual:[0-9a-f-]{36}$/,
}

const bad = (message: string, field: string) =>
  new AppError("BAD_REQUEST", message, { context: { field } })

/** The key with its repo segment lower-cased (a branch or an app name stays as given). */
function normalizeDedupeKey(source: SignalSource, key: string, repo: string): string {
  const pattern = DEDUPE_PATTERNS[source]
  const match = pattern?.exec(key)
  if (!match) throw bad(`dedupeKey does not match the ${source} pattern`, "dedupeKey")
  const keyRepo = match[1]
  if (keyRepo === undefined) return key
  if (keyRepo.toLowerCase() !== repo) {
    throw bad("dedupeKey names another repo than the signal", "dedupeKey")
  }
  return key.replace(keyRepo, repo)
}

function validate(input: RecordSignalInput, now: Date): StoredSignal {
  const { source } = input
  if (!(SIGNAL_SOURCES as readonly string[]).includes(source)) {
    throw bad(`source ${String(source)} is not known`, "source")
  }
  if (!(CONNECTED_SIGNAL_SOURCES as readonly string[]).includes(source)) {
    throw bad(`source ${source} is not connected`, "source")
  }
  const externalId = checkText("externalId", input.externalId, { max: ID_MAX_CHARS })
  const dedupeKeyIn = checkText("dedupeKey", input.dedupeKey, { max: ID_MAX_CHARS })
  const repo = checkRepo(input.repo)
  const dedupeKey = normalizeDedupeKey(source, dedupeKeyIn, repo)
  const title = checkText("title", input.title, { max: TITLE_MAX_CHARS })
  const summary = checkText("summary", input.summary, { max: SUMMARY_MAX_CHARS, allowEmpty: true })
  let url: string | null = null
  if (input.url !== undefined) {
    const text = checkText("url", input.url, { max: URL_MAX_CHARS })
    if (!URL.canParse(text) || new URL(text).protocol !== "https:") {
      throw bad("url must be an https address", "url")
    }
    url = text
  }
  let occurredAt = now
  if (input.occurredAt !== undefined) {
    const parsed = new Date(input.occurredAt)
    if (Number.isNaN(parsed.getTime())) throw bad("occurredAt is not a date", "occurredAt")
    // A signal cannot have happened after hq heard of it.
    occurredAt = parsed.getTime() > now.getTime() ? now : parsed
  }
  return {
    source,
    externalId,
    dedupeKey,
    repo,
    title,
    summary,
    url,
    payload: checkPayload(input.payload),
    occurredAt,
  }
}

const RECURRENCE_MS = RECURRENCE_REOPEN_DAYS * 24 * 60 * 60 * 1000

async function findDuplicate(
  db: Database,
  source: SignalSource,
  externalId: string,
): Promise<RecordSignalResult | null> {
  const [row] = await db
    .select({ signalId: signals.id, item: workItems })
    .from(signals)
    .innerJoin(workItems, eq(workItems.id, signals.itemId))
    .where(and(eq(signals.source, source), eq(signals.externalId, externalId)))
  if (!row) return null
  const item = toWorkItemRow(row.item)
  return {
    signalId: row.signalId,
    itemId: item.id,
    displayId: item.displayId,
    outcome: "duplicate",
  }
}

/**
 * Record one signal. `(source, externalId)` seen before is a `duplicate` and writes nothing. Else,
 * under the dedupe key's advisory lock (so two signals for one key never both make an item), take
 * the newest item with the key:
 * - none, or `done` more than RECURRENCE_REOPEN_DAYS ago: a new item, in triage (`created`);
 * - in `verify`, or `done` within those days: reopened by the system, reason `recurrence`;
 * - any other state (`stopped` stays stopped; `deploy` and `reopened` carry on): attached.
 */
export async function recordSignal(
  db: Database,
  input: RecordSignalInput & { recorder: Actor; now: Date },
): Promise<RecordSignalResult> {
  const { recorder, now } = input
  const signal = validate(input, now)
  try {
    return await db.transaction(async (tx): Promise<RecordSignalResult> => {
      // The lock comes first: a redelivery that waited behind its twin must see the twin's signal.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`hq_signal:${signal.dedupeKey}`}, 0))`,
      )
      const seen = await findDuplicate(tx, signal.source, signal.externalId)
      if (seen) return seen

      const [newest] = await tx
        .select({ id: workItems.id })
        .from(workItems)
        .where(eq(workItems.dedupeKey, signal.dedupeKey))
        .orderBy(desc(workItems.createdAt), desc(workItems.number))
        .limit(1)
      // The row is read again under its own lock: another writer may be moving it.
      const item: WorkItemRow | null = newest ? await lockItem(tx, newest.id) : null

      const expired =
        item?.state === "done" && now.getTime() - item.stateChangedAt.getTime() > RECURRENCE_MS
      if (!item || expired) {
        const made = await createItemFromSignal(tx, signal, recorder, now)
        return {
          signalId: made.signalId,
          itemId: made.item.id,
          displayId: made.item.displayId,
          outcome: "created",
        }
      }
      const signalId = await storeSignal(tx, item, signal, recorder, now)
      if (item.state === "verify" || item.state === "done") {
        const system: Actor = { type: "system", id: "hq" }
        // One millisecond after the signal_attached event, and the window's close one after that:
        // (at, id) then tells the story in order.
        await transitionItem(tx, {
          item,
          to: "reopened",
          actor: system,
          reason: "recurrence",
          now: new Date(now.getTime() + 1),
        })
        if (item.state === "verify") {
          // The window the recurrence reopened the item out of is over: it failed (one ms later,
          // so the story reads in order).
          await closeRunningWindow(tx, {
            item,
            status: "failed",
            note: "A signal with this item's dedupe key arrived inside the window.",
            actor: system,
            now,
            eventAt: () => new Date(now.getTime() + 2),
          })
        }
        return { signalId, itemId: item.id, displayId: item.displayId, outcome: "reopened" }
      }
      return { signalId, itemId: item.id, displayId: item.displayId, outcome: "attached" }
    })
  } catch (error) {
    // The same external id arriving under two dedupe keys takes two locks and can race on the
    // unique constraint: the loser rolled back whole, and the answer is the winner's signal.
    if (isUniqueViolation(error)) {
      const seen = await findDuplicate(db, signal.source, signal.externalId)
      if (seen) return seen
    }
    throw error
  }
}
