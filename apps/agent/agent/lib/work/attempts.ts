import { FatalError } from "eve/workflow"
import {
  adoptOrStartAttempt,
  ATTEMPT_LIMIT_MESSAGE,
  type AskCall,
  type AskResult,
  kindOf,
  limitReached,
  type StationCall,
  type StationRecord,
  type StationSummary,
  stationKey,
} from "./attempts-shared.js"
import { findItem, recordAsk, recordEnd, recordFail, stepHq, withLimit } from "./attempts-record.js"
import { traceToProbe } from "../offline/probe.js"
import { recordDropped, recordSafely } from "./recorder.js"

export {
  ASK_CAPS,
  ATTEMPT_CAPS,
  ATTEMPT_LIMIT_MESSAGE,
  type AdoptResult,
  type AskCall,
  type AskResult,
  type AttemptSubject,
  adoptOrStartAttempt,
  contractFor,
  type Station,
  type StationCall,
  type StationRecord,
  type StationSummary,
  stationKey,
  subjectOf,
  summarizeStation,
  takeHeadSha,
} from "./attempts-shared.js"

/**
 * Recording the Foreman stations as hq attempts: the steps the three `run_*` wrappers call.
 *
 * @remarks
 * A station wrapper's `execute` is a `"use workflow"` body. eve replays such a body (after every
 * `sleep()` and on resume) and says it "must stay deterministic", so a body never calls hq. It
 * reads `ctx.session.id`, `ctx.callId` and `ctx.session.auth.current`, calls the pure functions
 * below ({@link subjectOf}, {@link stationKey}, {@link summarizeStation}) and calls three top-level
 * `"use step"` functions: {@link beginStation}, {@link endStation} and {@link failStation}. Each
 * takes only serialisable values and builds its own hq client from the environment (`stepHq` in `attempts-record.ts`).
 * eve reuses a step's recorded result when the body replays and retries a step that throws, so
 * every step is idempotent: hq answers a start with a key it already holds by returning that
 * attempt (Task 4 rule 1), and a finish with the stored result is a no-op.
 *
 * What eve does with a step's throw (probe P4, `decisions/p4-workflow-steps.md`):
 * - a `FatalError` from `eve/workflow` is never retried and reaches the orchestrator as a tool
 *   error with its exact message. {@link beginStation} throws one, and only one: the attempt limit
 *   (`ATTEMPT_LIMIT_MESSAGE`).
 * - a plain `Error` is retried three times and then surfaces wrapped in a `FatalError` whose
 *   message starts `Step "<id>" failed after 3 retries: `. A `try/catch` in a workflow body sees
 *   BOTH as a `FatalError`, so it cannot tell them apart by class; the prefix is the only
 *   difference. No step here throws a plain error: everything that is not the limit is caught,
 *   logged as `work_record_dropped` and counted ({@link recordSafely}), because a retried step
 *   must never fail a build and a step that swallows its errors is never retried.
 *
 * Unrecorded fall-through: with hq unreachable, the environment unset, no item for the session or
 * a refusal, a step records nothing and the station runs as before. The one exception is the
 * attempt limit, which hq's own item read (a successful one) can answer.
 *
 * The run id (`defineState` of the spend hook) cannot be read from a body or a step (P4 (e)), so
 * `runId` is never sent and an attempt's cost reads "Not reported".
 *
 * The lease is UNVERIFIED. hq abandons a running attempt after `ATTEMPT_LEASE_MINUTES` (45) without
 * a heartbeat. This lab sets no station timeout and no per-station limit and has no periodic
 * heartbeat: the implementer's one heartbeat (branch and files, when it has pushed) is the only
 * one, so 45 minutes between the start and that heartbeat, or between it and the reviewer's
 * finish, is a guess either way. The sweep abandons only per the lease and nothing else.
 */

/**
 * Finds the session's item and starts or adopts the station's attempt. A step.
 *
 * @returns The record the other steps take, or null: nothing is recorded and the station runs.
 * @throws FatalError(ATTEMPT_LIMIT_MESSAGE) when the implementer's read of the item succeeded, its
 * fix attempts of this cycle have reached the stored limit and none is adoptable. It is thrown
 * outside `recordSafely` (which never rethrows) and never decided from an error message; eve does
 * not retry it and the orchestrator sees it as a tool error.
 */
export async function beginStation(given: StationCall): Promise<StationRecord | null> {
  "use step"
  try {
    await traceToProbe("attempt-step", {
      step: "beginStation",
      station: given.station,
      callId: given.callId,
    })
    // The wrappers send no limit (a body imports no constants): the step applies the agent's own.
    const call = withLimit(given)
    const hq = call.subject === null ? null : stepHq()
    if (hq === null) {
      return null
    }
    const itemId = await findItem(hq, call)
    if (itemId === null) {
      return null
    }
    if (call.station === "implementer") {
      const detail = await recordSafely("get_work_item", () => hq.getWorkItem({ itemId }))
      if (detail !== null && limitReached(detail, call)) {
        throw new FatalError(ATTEMPT_LIMIT_MESSAGE)
      }
    }
    const result = await adoptOrStartAttempt(hq, call, itemId)
    if (!result.ok) {
      recordDropped(
        "begin_station",
        result.reason.startsWith("conflict")
          ? "conflict"
          : result.reason === "hq_unreachable"
            ? "unavailable"
            : "rejected",
      )
      return null
    }
    return {
      itemId,
      attemptId: result.attemptId,
      kind: kindOf(call.station),
      key: stationKey(call),
    }
  } catch (error) {
    if (error instanceof FatalError) {
      throw error
    }
    // Anything else (a bad payload, a TypeError) must not be retried by eve three times and then
    // stop the station: the build runs unrecorded.
    recordDropped("begin_station", "unavailable")
    return null
  }
}

/**
 * Records what a station produced. A step; never throws.
 *
 * - analyst: sets the contract (acceptance criteria, recurrence, a `ci` item when the item has pull
 *   request checks) unless a fix of this cycle exists, then finishes `investigated`.
 * - implementer: `pushed: false` finishes `failed` with the first limitation; otherwise sends the
 *   branch and files in one heartbeat and leaves the attempt running for the reviewer.
 * - reviewer: finishes the running fix `approved` or `rejected` with the verdict (and the head sha
 *   the reviewer read, when known) and the blocking findings as the note.
 *
 * Called twice with the same summary it changes nothing the second time. One exception, accepted: a
 * second run of the analyst call whose first `set_contract` committed but whose finish was lost
 * finds the attempt still running and sets the same contract again (hq replaces the rows and
 * appends a second `contract_set` event; the content is the same).
 */
export async function endStation(
  recordOf: StationRecord | null,
  summary: StationSummary,
): Promise<void> {
  "use step"
  try {
    await traceToProbe("attempt-step", { step: "endStation", station: summary.station })
    const hq = recordOf === null ? null : stepHq()
    if (recordOf === null || hq === null) {
      return
    }
    await recordEnd(hq, recordOf, summary)
  } catch {
    recordDropped("end_station", "unavailable")
  }
}

/**
 * Ends the running attempt `failed` with `The <station> station failed: <message>` (the message
 * cut at 500 characters; it is the error text the orchestrator already gets). A step; never
 * throws, so the wrapper's rethrow is always the station's own error.
 *
 * A reviewer that fails ends the implementer's running fix: that is the attempt it was reviewing.
 * An attempt that is not running, or is of another kind than the station's, is left alone.
 */
export async function failStation(recordOf: StationRecord | null, message: string): Promise<void> {
  "use step"
  try {
    await traceToProbe("attempt-step", { step: "failStation", key: recordOf?.key ?? null })
    const hq = recordOf === null ? null : stepHq()
    if (recordOf === null || hq === null) {
      return
    }
    await recordFail(hq, recordOf, message)
  } catch {
    recordDropped("fail_station", "unavailable")
  }
}

/**
 * Puts a question to a founder and ends the attempt that was running with `needs_answer`: what
 * `ask_founder` calls. A step; never throws.
 *
 * @remarks
 * Resolves its item through the same subject the stations use ({@link subjectOf}), so a summary-only
 * run, an unstamped session and a mention have none and write nothing. The attempt it ends is the
 * one that belongs to this session or ticket and is running; another session's is left alone.
 * Asking the same question again while it is still open adds no second one. The question's text is
 * the model's and is untrusted: hq stores it capped and a screen renders it as text.
 */
export async function askFounder(call: AskCall): Promise<AskResult> {
  "use step"
  try {
    await traceToProbe("attempt-step", { step: "askFounder" })
    const hq = call.subject === null ? null : stepHq()
    if (hq === null) {
      return { recorded: false }
    }
    return await recordAsk(hq, call)
  } catch {
    recordDropped("ask_founder", "unavailable")
    return { recorded: false }
  }
}
