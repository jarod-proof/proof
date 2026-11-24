import { defineWorkflowTool } from "eve/tools"
import { z } from "zod"
import { stationPolicy } from "../lib/github/approval.js"
import { founderApproval } from "../lib/github/founder-response.js"
import { stationOutput } from "../lib/stations/result.js"
import { ANALYST_OUTPUT_SCHEMA } from "../lib/stations/schemas.js"
import {
  ATTEMPT_LIMIT_MESSAGE,
  beginStation,
  endStation,
  failStation,
  subjectOf,
  summarizeStation,
} from "../lib/work/attempts.js"

/**
 * Blocking wrapper the orchestrator calls to run the `analyst` station.
 *
 * @remarks
 * Attaches the output schema per call, and throws when the station fails,
 * is cancelled, or returns no data (`stationOutput` in
 * `agent/lib/stations/result.ts`), so the orchestrator sees a tool error
 * instead of an empty result. Named `run_analyst`, not `analyst`:
 * the compiler rejects a tool and a local subagent with the same public
 * name.
 *
 * The body also records the run as an attempt of the session's work item: `beginStation` before the
 * station, then `endStation` with what it produced or `failStation` with why it threw, which is
 * rethrown unchanged. They are steps (`lib/work/attempts.ts`) and the body calls nothing else;
 * the station's output is returned exactly as before.
 */
export default defineWorkflowTool({
  approval: founderApproval(stationPolicy),
  description:
    "Analyze a classified work item against the real repository checkout and produce an " +
    "implementation plan: problem statement, approach, ordered steps, affected files, " +
    "risks, acceptance criteria, and test strategy. Planning only; writes no code. The " +
    "caller passes the work item, its classification, and any research findings in the " +
    "message, plus a research artifact id when the researcher saved a full memo. May " +
    "save its own deep supporting detail as an analysis artifact and return the id.",
  async execute({ message }, ctx) {
    "use workflow"
    // Recording is three steps and pure functions of `lib/work/attempts.ts`; the body calls nothing else.
    // beginStation sits OUTSIDE the try that records a failure: its attempt-limit FatalError must
    // reach the orchestrator as it is, never be recorded as this station failing. That error is
    // told by its exact message (a constant); anything else beginStation throws means "not
    // recorded", and the station runs.
    let record: Awaited<ReturnType<typeof beginStation>>
    try {
      record = await beginStation({
        callId: ctx.callId,
        sessionId: ctx.session.id,
        station: "analyst",
        subject: subjectOf(ctx.session.auth.current),
      })
    } catch (error) {
      if (error instanceof Error && error.message === ATTEMPT_LIMIT_MESSAGE) {
        throw error
      }
      record = null
    }
    let output: unknown
    try {
      const response = await ctx.agent("analyst").send(message, {
        outputSchema: ANALYST_OUTPUT_SCHEMA,
        signal: ctx.abortSignal,
      })
      output = stationOutput("analyst", await response.result())
    } catch (error) {
      await failStation(record, error instanceof Error ? error.message : String(error))
      throw error
    }
    await endStation(record, summarizeStation("analyst", output))
    return output
  },
  inputSchema: z.object({
    message: z
      .string()
      .describe("Everything the station needs; it does not see your conversation history."),
  }),
})
