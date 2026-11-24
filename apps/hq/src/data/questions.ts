// Agent questions: a question the agent put to a founder. It waits until a founder answers; its
// default option is only a recommendation, never applied on a timer. The data layer records the
// question and the answer and nothing else: answering creates no attempt (the operation decides
// what an answer starts), and a stop withdraws what is still open (decisions.ts).
import type { Database } from "@proof/db"
import { AppError } from "@proof/errors"
import { and, eq } from "drizzle-orm"

import { agentQuestions, attempts } from "../db/schema"
import { MAX_QUESTION_OPTIONS, NOTE_MAX_CHARS } from "../work/constants"
import { isInFlight } from "../work/machine"
import type { AskQuestionInput, QuestionOptionInput } from "../work/types"
import { checkFounderId, checkUuid, optionalNote } from "./decisions"
import { appendEvent } from "./work-events"
import { type Actor, checkText, lockItem } from "./work-items"

export type QuestionRow = typeof agentQuestions.$inferSelect

export const QUESTION_PROMPT_MAX_CHARS = NOTE_MAX_CHARS
export const OPTION_ID_MAX_CHARS = 100
export const OPTION_LABEL_MAX_CHARS = 200
export const OPTION_DETAIL_MAX_CHARS = 500
const ACTOR_ID_MAX_CHARS = 200

const bad = (message: string, field: string) =>
  new AppError("BAD_REQUEST", message, { context: { field } })

function checkOptions(value: unknown): QuestionOptionInput[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_QUESTION_OPTIONS) {
    throw bad(`options must hold 2 to ${MAX_QUESTION_OPTIONS} entries`, "options")
  }
  const options = value.map((raw: unknown, i): QuestionOptionInput => {
    const field = `options[${i}]`
    if (!raw || typeof raw !== "object") throw bad(`${field} must be an object`, field)
    const o = raw as Partial<QuestionOptionInput>
    const detail =
      o.detail === undefined
        ? undefined
        : checkText(`${field}.detail`, o.detail, { max: OPTION_DETAIL_MAX_CHARS })
    return {
      id: checkText(`${field}.id`, o.id, { max: OPTION_ID_MAX_CHARS }),
      label: checkText(`${field}.label`, o.label, { max: OPTION_LABEL_MAX_CHARS }),
      ...(detail === undefined ? {} : { detail }),
    }
  })
  if (new Set(options.map((o) => o.id)).size !== options.length) {
    throw bad("option ids must be unique", "options")
  }
  return options
}

/**
 * The agent asks a founder something. The item must be in flight (a done, stopped or reopened item
 * has nobody to wait for the answer), 2 to 5 options with unique ids, a default (a recommendation,
 * shown on a button) among them, and an `attemptId`, when given, must be an attempt of this item.
 * Text is capped and stored as it came; it is rendered as text only.
 */
export async function askQuestion(
  db: Database,
  input: AskQuestionInput & { actor: Actor; now: Date },
): Promise<QuestionRow> {
  const itemId = checkUuid("itemId", input.itemId)
  const prompt = checkText("prompt", input.prompt, { max: QUESTION_PROMPT_MAX_CHARS })
  const options = checkOptions(input.options)
  const defaultOptionId =
    input.defaultOptionId === undefined
      ? null
      : checkText("defaultOptionId", input.defaultOptionId, { max: OPTION_ID_MAX_CHARS })
  if (defaultOptionId !== null && !options.some((o) => o.id === defaultOptionId)) {
    throw bad("defaultOptionId must be one of the options", "defaultOptionId")
  }
  const attemptId = input.attemptId === undefined ? null : checkUuid("attemptId", input.attemptId)
  const { actor, now } = input
  const actorId = checkText("actor.id", actor.id, { max: ACTOR_ID_MAX_CHARS })
  return db.transaction(async (tx) => {
    const item = await lockItem(tx, itemId)
    if (!isInFlight(item.state)) {
      throw new AppError("CONFLICT", `Nobody is waiting on a work item that is ${item.state}.`, {
        context: { state: item.state },
      })
    }
    if (attemptId !== null) {
      const [own] = await tx
        .select({ id: attempts.id })
        .from(attempts)
        .where(and(eq(attempts.id, attemptId), eq(attempts.itemId, item.id)))
      if (!own) throw bad("attemptId is not an attempt of this work item", "attemptId")
    }
    const [row] = await tx
      .insert(agentQuestions)
      .values({
        id: crypto.randomUUID(),
        itemId: item.id,
        attemptId,
        prompt,
        options,
        defaultOptionId,
        status: "open",
        createdAt: now,
      })
      .returning()
    if (!row) throw new AppError("INTERNAL", "The question was not stored")
    await appendEvent(tx, {
      itemId: item.id,
      at: now,
      kind: "question_asked",
      actor: { type: actor.type, id: actorId, via: actor.via },
      detail: { questionId: row.id, attemptId },
      cycle: item.cycle,
    })
    return row
  })
}

/**
 * A founder answers an open question with one of its options, once. An answered or withdrawn
 * question is CONFLICT. The answer is recorded (who, which option, the optional note) and nothing
 * else moves: no attempt starts and the item stays where it is.
 */
export async function answerQuestion(
  db: Database,
  input: { questionId: string; optionId: string; note?: string; founderId: string; now: Date },
): Promise<QuestionRow> {
  const questionId = checkUuid("questionId", input.questionId)
  const optionId = checkText("optionId", input.optionId, { max: OPTION_ID_MAX_CHARS })
  const note = optionalNote("note", input.note)
  const founderId = checkFounderId(input.founderId)
  const { now } = input
  const [seen] = await db
    .select({ itemId: agentQuestions.itemId })
    .from(agentQuestions)
    .where(eq(agentQuestions.id, questionId))
  if (!seen) throw new AppError("NOT_FOUND", "Question not found")
  return db.transaction(async (tx) => {
    const item = await lockItem(tx, seen.itemId)
    const [cur] = await tx.select().from(agentQuestions).where(eq(agentQuestions.id, questionId))
    if (!cur) throw new AppError("NOT_FOUND", "Question not found")
    if (cur.status !== "open") {
      throw new AppError("CONFLICT", `This question is already ${cur.status}.`, {
        context: { status: cur.status },
      })
    }
    if (!cur.options.some((o) => o.id === optionId)) {
      throw bad("optionId is not one of the question's options", "optionId")
    }
    const [row] = await tx
      .update(agentQuestions)
      .set({
        status: "answered",
        answeredOptionId: optionId,
        answerNote: note,
        answeredBy: founderId,
        answeredAt: now,
      })
      .where(and(eq(agentQuestions.id, cur.id), eq(agentQuestions.status, "open")))
      .returning()
    if (!row) throw new AppError("CONFLICT", "This question was answered first.")
    await appendEvent(tx, {
      itemId: item.id,
      at: now,
      kind: "question_answered",
      actor: { type: "founder", id: founderId },
      note,
      detail: { questionId: row.id, optionId },
      cycle: item.cycle,
    })
    return row
  })
}
