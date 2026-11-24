// The contract: what an item's fix must satisfy, recorded before the first fix attempt of a cycle
// ("Recorded before the first attempt"). One set per cycle; setting it again replaces the cycle's
// items until a fix has started, then it is fixed. The machine's `contract_and_budget` guard reads
// the count, so a fix cannot start without one.
import type { Database } from "@proof/db"
import { AppError } from "@proof/errors"
import { and, eq, ne } from "drizzle-orm"

import { attempts, contractItems } from "../db/schema"
import { VERIFIER_KINDS, type VerifierKind } from "../work/machine"
import type { ContractInput } from "../work/types"
import { checkUuid } from "./decisions"
import { appendEvent } from "./work-events"
import { type Actor, authorTypeOf, checkPayload, checkText, lockItem } from "./work-items"

export type ContractItemRow = typeof contractItems.$inferSelect

export const CONTRACT_ITEMS_MAX = 8
export const CONTRACT_TEXT_MAX_CHARS = 300
const ACTOR_ID_MAX_CHARS = 200
/** The verifiers hq can evaluate itself; `sentry` and `posthog` wait until they are connected. */
export const CONNECTED_VERIFIER_KINDS: readonly VerifierKind[] = [
  "reviewer",
  "ci",
  "signal_recurrence",
]

const bad = (message: string, field: string) =>
  new AppError("BAD_REQUEST", message, { context: { field } })

function checkItem(raw: unknown, index: number) {
  const field = `items[${index}]`
  if (!raw || typeof raw !== "object") throw bad(`${field} must be an object`, field)
  const item = raw as Partial<ContractInput>
  const text = checkText(`${field}.text`, item.text, { max: CONTRACT_TEXT_MAX_CHARS }).trim()
  const verifier = item.verifier as Partial<ContractInput["verifier"]> | undefined
  if (!verifier || typeof verifier !== "object") throw bad(`${field}.verifier is required`, field)
  if (!(VERIFIER_KINDS as readonly unknown[]).includes(verifier.kind)) {
    throw bad(`${field}.verifier.kind must be one of ${VERIFIER_KINDS.join(", ")}`, field)
  }
  const kind = verifier.kind as VerifierKind
  if (!CONNECTED_VERIFIER_KINDS.includes(kind)) {
    throw bad(`${field}.verifier.kind ${kind} is not connected`, field)
  }
  return { text, kind, config: checkPayload(verifier.config, `${field}.verifier.config`) }
}

/**
 * Replace the item's CURRENT cycle's contract. Refused (CONFLICT) unless the item is in `triage` or
 * `plan`, and once a fix attempt of this cycle has started or finished (a `requested` fix has not:
 * it waits for this very contract, so it must not block it). Other cycles' rows are untouched.
 * 1 to 8 items, text at most 300 characters; `sentry` and `posthog` verifiers are BAD_REQUEST until
 * they are connected. The item's row is locked, so it serializes with a fix start.
 */
export async function setContract(
  db: Database,
  input: { itemId: string; items: ContractInput[]; actor: Actor; now: Date },
): Promise<ContractItemRow[]> {
  const itemId = checkUuid("itemId", input.itemId)
  if (
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > CONTRACT_ITEMS_MAX
  ) {
    throw bad(`items must hold 1 to ${CONTRACT_ITEMS_MAX} entries`, "items")
  }
  const items = input.items.map(checkItem)
  const { actor, now } = input
  const actorId = checkText("actor.id", actor.id, { max: ACTOR_ID_MAX_CHARS })
  return db.transaction(async (tx) => {
    const item = await lockItem(tx, itemId)
    if (item.state !== "triage" && item.state !== "plan") {
      throw new AppError(
        "CONFLICT",
        `A contract is set while the work item is in triage or plan, not in ${item.state}.`,
        { context: { state: item.state } },
      )
    }
    const [started] = await tx
      .select({ id: attempts.id })
      .from(attempts)
      .where(
        and(
          eq(attempts.itemId, item.id),
          eq(attempts.cycle, item.cycle),
          eq(attempts.kind, "fix"),
          ne(attempts.status, "requested"),
        ),
      )
      .limit(1)
    if (started) {
      throw new AppError("CONFLICT", "The contract is fixed: a fix attempt has started.", {
        hint: "It was recorded before the first attempt of this cycle.",
      })
    }
    const replaced = await tx
      .delete(contractItems)
      .where(and(eq(contractItems.itemId, item.id), eq(contractItems.cycle, item.cycle)))
      .returning({ id: contractItems.id })
    const rows = await tx
      .insert(contractItems)
      .values(
        items.map((c, i) => ({
          id: crypto.randomUUID(),
          itemId: item.id,
          cycle: item.cycle,
          position: i + 1,
          text: c.text,
          verifierKind: c.kind,
          verifierConfig: c.config,
          status: "pending" as const,
          createdByType: authorTypeOf(actor),
          createdById: actorId,
        })),
      )
      .returning()
    await appendEvent(tx, {
      itemId: item.id,
      at: now,
      kind: "contract_set",
      actor: { type: actor.type, id: actorId, via: actor.via },
      detail: { count: rows.length, replaced: replaced.length },
      cycle: item.cycle,
    })
    return rows.sort((a, b) => a.position - b.position)
  })
}
