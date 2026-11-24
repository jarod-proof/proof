import { agentEnv } from "@proof/env/agent"
import { FACTORY_REPO, MAX_ATTEMPTS_PER_ITEM } from "../constants.js"
import {
  createHqClient,
  type AttemptView,
  type HqClient,
  HqError,
  type WorkItemDetail,
} from "../hq/client.js"
import {
  ASK_CAPS,
  ATTEMPT_CAPS,
  type AskCall,
  type AskResult,
  contractFor,
  kindOf,
  runningAttemptOf,
  type StationCall,
  type StationRecord,
  type StationSummary,
  stationOf,
} from "./attempts-shared.js"
import { recordDropped, recordSafely } from "./recorder.js"
import { storable } from "./storable.js"

/**
 * The hq half of the attempt recording: everything that reaches hq or the recorder, called from the
 * three `"use step"` functions of `attempts.ts` and from nowhere else. Kept out of `attempts.ts`
 * because a workflow body imports that file, and a helper that stays in it keeps its imports
 * (the recorder reaches pino, and the workflow bundle refuses Node built-ins) alive.
 */

/**
 * The client a step uses: built from the environment inside the step (a body cannot read
 * the environment), or null, quietly, when hq is not configured. The default 10 second timeout holds:
 * the hooks' 3 seconds are for a webhook that delays a dispatch.
 */
export function stepHq(): HqClient | null {
  const baseUrl = agentEnv("HQ_BASE_URL")?.trim()
  const apiKey = agentEnv("HQ_AGENT_API_KEY")?.trim()
  if (!baseUrl || !apiKey) {
    return null
  }
  return createHqClient({ baseUrl, apiKey })
}

/** The item a session is working on, or null: nothing to record. Reads through `recordSafely`. */
export async function findItem(
  hq: HqClient,
  call: Pick<StationCall, "subject">,
): Promise<string | null> {
  const { subject } = call
  if (subject === null) {
    return null
  }
  const repo = FACTORY_REPO.toLowerCase()
  const found = await recordSafely("find_work_item", async () => {
    if (subject.kind === "issue") {
      const { items } = await hq.listWorkItems({
        dedupeKey: `github-issue:${repo}#${subject.issueNumber}`,
      })
      return items[0]?.id ?? null
    }
    if (subject.kind === "ci_fix") {
      const { items } = await hq.listWorkItems({ pullRequestNumber: subject.pullNumber, repo })
      return items[0]?.id ?? null
    }
    const attempts = await hq.listAttempts({ externalRef: subject.ticketId })
    return attempts[0]?.itemId ?? null
  })
  return found
}

/** The recorded attempt, read fresh; null when hq cannot say. */
async function readAttempt(
  hq: HqClient,
  recordOf: StationRecord,
): Promise<{ detail: WorkItemDetail; attempt: AttemptView | null } | null> {
  const detail = await recordSafely("get_work_item", () =>
    hq.getWorkItem({ itemId: recordOf.itemId }),
  )
  if (detail === null) {
    return null
  }
  return { detail, attempt: detail.attemptList.find((a) => a.id === recordOf.attemptId) ?? null }
}

/**
 * One write that never throws. A CONFLICT is re-read: when `isEcho` says the stored attempt already
 * holds what this call wanted, it counts as done and nothing is logged; anything else is logged
 * as `work_record_dropped` and counted.
 *
 * @returns Whether hq holds what the call wanted (written now or already stored).
 */
async function write(
  hq: HqClient,
  recordOf: StationRecord,
  label: string,
  run: () => Promise<unknown>,
  isEcho: (attempt: AttemptView) => boolean,
): Promise<boolean> {
  const done = await recordSafely(label, async () => {
    try {
      await run()
    } catch (error) {
      if (error instanceof HqError && error.status === 409) {
        const stored = await readAttempt(hq, recordOf).catch(() => null)
        if (stored?.attempt && isEcho(stored.attempt)) {
          return true
        }
      }
      throw error
    }
    return true
  })
  return done === true
}

/**
 * The call a step makes with the limit it was given, or the agent's own: a workflow body may not
 * import `constants.ts` (it reads the environment at load), so the wrappers send no limit and the
 * step applies `MAX_ATTEMPTS_PER_ITEM` here.
 */
export const withLimit = (call: StationCall): StationCall => ({
  ...call,
  attemptLimit: call.attemptLimit ?? MAX_ATTEMPTS_PER_ITEM,
})

const sameFiles = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((file, i) => file === b[i])

/**
 * What `endStation` does with an open hq client: see {@link endStation} in `attempts.ts`. Every
 * write goes through `write`, so none throws.
 */
export async function recordEnd(
  hq: HqClient,
  recordOf: StationRecord,
  summary: StationSummary,
): Promise<void> {
  if (recordOf.attemptId === null) {
    return
  }
  const attemptId = recordOf.attemptId
  if (summary.station === "analyst") {
    const stored = await readAttempt(hq, recordOf)
    const attempt = stored?.attempt ?? null
    if (attempt?.status === "finished") {
      // Already ended: the same result is an echo of this very call, another one is not.
      if (attempt.result !== "investigated") {
        recordDropped("end_station", "conflict")
      }
      return
    }
    const detail = stored?.detail ?? null
    const hasFix = detail?.attemptList.some((a) => a.kind === "fix" && a.cycle === detail.cycle)
    if (!hasFix) {
      const items = contractFor(
        summary.acceptanceCriteria,
        (detail?.pullRequest?.checks.length ?? 0) > 0,
      )
      await write(
        hq,
        recordOf,
        "set_contract",
        () => hq.setContract({ itemId: recordOf.itemId, items }),
        () => false,
      )
    }
    await write(
      hq,
      recordOf,
      "finish_attempt",
      () => hq.finishAttempt({ attemptId, result: "investigated" }),
      (a) => a.result === "investigated",
    )
    return
  }
  if (summary.station === "implementer") {
    if (!summary.pushed) {
      const note = summary.limitation ?? "The implementer did not push the branch."
      await write(
        hq,
        recordOf,
        "finish_attempt",
        () => hq.finishAttempt({ attemptId, result: "failed", note }),
        (a) => a.result === "failed",
      )
      return
    }
    await write(
      hq,
      recordOf,
      "heartbeat_attempt",
      () =>
        hq.heartbeatAttempt({
          attemptId,
          ...(summary.branch === null ? {} : { branch: summary.branch }),
          files: summary.files,
        }),
      (a) => a.branch === summary.branch && sameFiles(a.files, summary.files),
    )
    return
  }
  const result = summary.verdict === "approve" ? "approved" : "rejected"
  await write(
    hq,
    recordOf,
    "finish_attempt",
    () =>
      hq.finishAttempt({
        attemptId,
        result,
        ...(summary.findings === "" ? {} : { note: summary.findings }),
        reviewer: {
          verdict: summary.verdict,
          summary: summary.summary,
          ...(summary.headSha === undefined ? {} : { headSha: summary.headSha }),
        },
      }),
    (a) => a.result === result,
  )
}

/** What `failStation` does with an open hq client: see {@link failStation} in `attempts.ts`. */
export async function recordFail(
  hq: HqClient,
  recordOf: StationRecord,
  message: string,
): Promise<void> {
  const station = stationOf(recordOf.key)
  if (station === null || recordOf.attemptId === null) {
    return
  }
  const attemptId = recordOf.attemptId
  const stored = await readAttempt(hq, recordOf)
  if (stored !== null && (stored.attempt === null || stored.attempt.status !== "running")) {
    return
  }
  if (stored?.attempt && stored.attempt.kind !== kindOf(station)) {
    return
  }
  // `stationOutput`'s own errors already start "The <station> station ..."; say it once.
  const said = String(message).startsWith(`The ${station} station `)
  const note = said
    ? storable(String(message), ATTEMPT_CAPS.failure)
    : `The ${station} station failed: ${storable(String(message), ATTEMPT_CAPS.failure)}`
  await write(
    hq,
    recordOf,
    "finish_attempt",
    () => hq.finishAttempt({ attemptId, result: "failed", note }),
    (a) => a.result === "failed",
  )
}

const sameOptions = (
  a: { id: string; label: string; detail?: string }[],
  b: { id: string; label: string; detail?: string }[],
): boolean =>
  a.length === b.length &&
  a.every((o, i) => o.id === b[i]?.id && o.label === b[i]?.label && o.detail === b[i]?.detail)

/**
 * What `askFounder` does with an open hq client: see {@link askFounder} in `attempts.ts`. Never
 * throws; every hq call goes through `recordSafely`.
 */
export async function recordAsk(hq: HqClient, call: AskCall): Promise<AskResult> {
  const itemId = await findItem(hq, call)
  if (itemId === null) {
    return { recorded: false }
  }
  const detail = await recordSafely("get_work_item", () => hq.getWorkItem({ itemId }))
  const running = detail === null ? null : runningAttemptOf(detail, call)
  const prompt = storable(call.prompt, ASK_CAPS.prompt)
  const options = call.options.map((o) => ({
    id: storable(o.id, ASK_CAPS.optionId),
    label: storable(o.label, ASK_CAPS.optionLabel),
    ...(o.detail === undefined ? {} : { detail: storable(o.detail, ASK_CAPS.optionDetail) }),
  }))
  // The same question, still open, is the same question: a repeat adds no second card.
  const open = detail?.questions.find(
    (q) => q.status === "open" && q.prompt === prompt && sameOptions(q.options, options),
  )
  let questionId = open?.id ?? null
  if (questionId === null) {
    const asked = await recordSafely("ask_question", () =>
      hq.askQuestion({
        itemId,
        prompt,
        options,
        ...(call.defaultOptionId === undefined
          ? {}
          : { defaultOptionId: storable(call.defaultOptionId, ASK_CAPS.optionId) }),
        ...(running === null ? {} : { attemptId: running.id }),
      }),
    )
    if (asked === null) {
      return { recorded: false }
    }
    questionId = asked.id
  }
  let attemptEnded = false
  if (running !== null) {
    attemptEnded = await write(
      hq,
      { itemId, attemptId: running.id, kind: running.kind, key: running.externalRef ?? "" },
      "finish_attempt",
      () => hq.finishAttempt({ attemptId: running.id, result: "needs_answer" }),
      (a) => a.result === "needs_answer",
    )
  }
  return { recorded: true, questionId, attemptEnded }
}
