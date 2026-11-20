import { defineEval } from "eve/evals"
import { satisfies } from "eve/evals/expect"
import { freshDay, hq, OFFLINE_TAG, pendingProposals } from "../offline.js"

export default defineEval({
  description:
    "Asked to remember a fact, the agent proposes it: a pending proposal in hq, and nothing in the brain.",
  tags: [OFFLINE_TAG],
  async test(t) {
    await freshDay()

    await t.send("remember that our price is $49")

    t.succeeded()
    t.calledTool("hq__propose_entry", { count: 1, status: "completed" })

    // hq has it as a pending proposal, and the brain itself is untouched.
    const pending = await pendingProposals()
    t.check(
      pending.filter((p) => p.title.includes("$49") || p.title.includes("49")).length,
      satisfies((n: number) => n === 1, "one pending proposal about the price"),
    )
    t.check(
      (await hq().searchEntries({ query: "price" })).length,
      satisfies((n: number) => n === 0, "no entry was written"),
    )
  },
})
