import { defineEval } from "eve/evals"
import { satisfies } from "eve/evals/expect"
import { allowance, freshDay, hq, latestFinishedRun, OFFLINE_TAG, probeEvents } from "../offline.js"

export default defineEval({
  description:
    "With the day's allowance spent, a question is refused before any model call, and nothing is held.",
  tags: [OFFLINE_TAG],
  async test(t) {
    await freshDay()
    // The day is at exactly 10.00 spent: the cap is reached.
    await hq().recordSpend({ source: "eve", amountUsd: 10, model: "setup" })

    await t.send("What is our price?")

    // The spend hook cancelled the turn: not a failure, no reply, no model call.
    t.event("turn.settled", { count: 1, data: { outcome: "cancelled" } })
    t.notEvent("model.started")
    // So no tool ran either: a refused turn cannot call the decision model (triage), a station or
    // anything else that costs money.
    t.notEvent("call.requested")
    t.notEvent("call.started")
    const modelCalls = (await probeEvents()).filter((entry) => entry.event === "model-call")
    t.check(
      modelCalls.length,
      satisfies((n: number) => n === 0, "the scripted model was never called"),
    )

    // hq holds nothing for the refused turn, has spent nothing more, and logged why it stopped.
    // The refusal cancels the turn before the hook has finished the run: wait for that last step.
    const run = await latestFinishedRun()
    const today = await allowance()
    t.check(
      today.reservedUsd,
      satisfies((n: number) => n === 0, "nothing is reserved"),
    )
    t.check(
      today.spentUsd,
      satisfies((n: number) => n === 10, "the day stays at 10.00"),
    )
    t.check(
      run?.outcome,
      satisfies((o) => o === "stopped", "the refused run is logged stopped"),
    )
    t.check(
      run?.summary?.stop.join(" "),
      satisfies(
        (s) => typeof s === "string" && s.includes("spend cap"),
        "with the cap as the reason",
      ),
    )
  },
})
