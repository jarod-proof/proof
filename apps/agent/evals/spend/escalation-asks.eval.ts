import { defineEval } from "eve/evals"
import { satisfies } from "eve/evals/expect"
import { allowance, freshDay, latestFinishedRun, OFFLINE_TAG, probeEvents } from "../offline.js"

const biggerModelRuns = async () =>
  (await probeEvents()).filter((entry) => entry.event === "bigger-model-run").length

export default defineEval({
  description:
    "A hard question asks a founder for a bigger model, with an estimate, and no bigger model runs until they approve.",
  tags: [OFFLINE_TAG],
  async test(t) {
    await freshDay()

    const turn = await t.send("[hard] How should we price a team plan?")

    // The scripted chat model asked; the turn parked on the founder's approval.
    t.check(
      turn.status,
      satisfies((s: string) => s === "awaiting-input", "the turn parked on the founder's approval"),
    )
    t.eventsSatisfy("the approval asks with the model and the estimate", (events) =>
      events.some(
        (event) =>
          event.type === "interaction.opened" &&
          JSON.stringify(event.data).includes("claude-sonnet-5.5") &&
          JSON.stringify(event.data).includes("$0.75"),
      ),
    )
    // The bigger model was not called while the request is open.
    t.check(
      await biggerModelRuns(),
      satisfies((n: number) => n === 0, "no bigger-model run before approval"),
    )
    // The paused turn still holds its estimate against the cap.
    const parked = await allowance()
    t.check(
      parked.reservedUsd,
      satisfies((n: number) => n > 0, "the turn's hold stays open"),
    )

    // A listed founder approves: only now does the tool body run, once.
    await turn.session.respondAll("approve")
    t.calledTool("request_bigger_model", {
      status: "completed",
      input: { model: "anthropic/claude-sonnet-5.5", estimateUsd: 0.75 },
      count: 1,
    })
    t.succeeded()
    t.check(
      await biggerModelRuns(),
      satisfies((n: number) => n === 1, "the bigger-model step ran once, after approval"),
    )

    // The turn ended and its hold was settled at the estimate (the scripted model reports no cost).
    // The turn resolves before the spend hook has settled: wait for the hook's last step.
    await latestFinishedRun()
    const settled = await allowance()
    t.check(
      settled.reservedUsd,
      satisfies((n: number) => n === 0, "nothing is left held"),
    )
    t.check(
      settled.spentUsd,
      satisfies((n: number) => n > 0, "the turn's cost was recorded"),
    )
  },
})
