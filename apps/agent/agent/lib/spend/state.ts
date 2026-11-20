import { defineState } from "eve/context"
import { EMPTY_SPEND_STATE, type SpendState, type SpendStore } from "./hooks.js"

/**
 * The spend ledger's per-session memory: the open hold, the turn's summed cost and the keys already
 * handled. `defineState` survives crashes and redeploys, which is what lets a turn that pauses for
 * an approval keep its hold and settle it when it ends.
 */
const spendState = defineState<SpendState>("proof-agent.spend", () => ({ ...EMPTY_SPEND_STATE }))

/** The store the hooks use inside eve; tests pass an in-memory one instead. */
export const sessionSpendStore: SpendStore = {
  get: () => spendState.get(),
  update: (fn) => {
    spendState.update(fn)
  },
}
