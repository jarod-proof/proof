// What the claim-mode `answer_question` operation reads and writes around the attempt it asks for.
// The answer itself is `answerQuestion` (questions.ts), which creates no attempt: the operation
// commits it, then asks `requestAttempt` for one in its own transaction. This file holds the three
// small pieces that call needs: which kind to ask for, the instructions text, and the one event a
// refusal leaves. No attempt is created here.
import type { Database } from "@proof/db"
import { and, desc, eq } from "drizzle-orm"

import { attempts, workItems } from "../db/schema"
import { NOTE_MAX_CHARS } from "../work/constants"
import type { AttemptKind } from "../work/machine"
import { appendEvent } from "./work-events"
import { lockItem } from "./work-items"

/**
 * The kind of the item's newest attempt of its CURRENT cycle (an earlier cycle's does not count),
 * else `investigate`: a question asked in triage, or in a new cycle before any attempt, is about
 * understanding the item.
 */
export async function currentCycleAttemptKind(db: Database, itemId: string): Promise<AttemptKind> {
  const [row] = await db
    .select({ kind: attempts.kind })
    .from(attempts)
    .innerJoin(
      workItems,
      and(eq(workItems.id, attempts.itemId), eq(workItems.cycle, attempts.cycle)),
    )
    .where(eq(attempts.itemId, itemId))
    .orderBy(desc(attempts.number))
    .limit(1)
  return row?.kind ?? "investigate"
}

/** At most `max` UTF-16 units, cut between code points so an emoji is never split. */
function firstChars(text: string, max: number): string {
  let out = ""
  for (const point of text) {
    if (out.length + point.length > max) break
    out += point
  }
  return out
}

/**
 * The instructions of the attempt an answer asks for: the option the founder chose and their note,
 * within NOTE_MAX_CHARS (a label of 200 and a note of 2000 would otherwise overflow it and the
 * request would be refused after the answer committed). The note is cut first, never the label.
 */
export function answerInstructions(optionLabel: string, note: string | null): string {
  const head = firstChars(`A founder answered: ${optionLabel}`, NOTE_MAX_CHARS)
  if (!note) return head
  const room = NOTE_MAX_CHARS - head.length - 2
  return room > 0 ? `${head}\n\n${firstChars(note, room)}` : head
}

/**
 * The one event an answer leaves when the attempt it asked for was refused: the answer stays
 * recorded, no attempt exists, and the item's history says why. `reason` is the refusal's error
 * code, `note` its message (hq's own words, shown as text); the summary of this kind is fixed.
 */
export async function recordRefusedAttemptRequest(
  db: Database,
  input: {
    itemId: string
    questionId: string
    optionId: string
    kind: AttemptKind
    code: string
    message: string
    founderId: string
    at: Date
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    const item = await lockItem(tx, input.itemId)
    await appendEvent(tx, {
      itemId: item.id,
      at: input.at,
      kind: "attempt_request_refused",
      actor: { type: "founder", id: input.founderId },
      reason: input.code.toLowerCase(),
      note: firstChars(input.message, NOTE_MAX_CHARS),
      detail: { questionId: input.questionId, optionId: input.optionId, kind: input.kind },
      cycle: item.cycle,
    })
  })
}
