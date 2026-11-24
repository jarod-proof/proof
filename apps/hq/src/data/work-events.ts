// The append-only history of a work item. Every change to an item is one row here; the database
// refuses to update or delete a row (migration work_events_append_only), so this file only inserts.
import { workItemEvents, type WorkEventKind } from "../db/schema"
import type { WorkState } from "../work/machine"
import type { Actor, Tx } from "./work-items"

export interface NewWorkEvent {
  itemId: string
  at: Date
  kind: WorkEventKind
  fromState?: WorkState | null
  toState?: WorkState | null
  actor: Actor
  reason?: string | null
  note?: string | null
  detail?: Record<string, unknown> | null
  /** The item's cycle when the event happened (the new cycle, for the move into it). */
  cycle: number
}

export async function appendEvent(tx: Tx, e: NewWorkEvent): Promise<void> {
  await tx.insert(workItemEvents).values({
    id: crypto.randomUUID(),
    itemId: e.itemId,
    at: e.at,
    kind: e.kind,
    fromState: e.fromState ?? null,
    toState: e.toState ?? null,
    actorType: e.actor.type,
    actorId: e.actor.id,
    reason: e.reason ?? null,
    note: e.note ?? null,
    // The actor's `via` is the credential's, so it overwrites a `via` the caller's own detail holds.
    detail: e.actor.via === undefined ? (e.detail ?? null) : { ...e.detail, via: e.actor.via },
    cycle: e.cycle,
  })
}
