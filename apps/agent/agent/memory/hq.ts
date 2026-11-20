import { defineMemory } from "eve/memory"
import { hqFromEnv } from "../lib/hq/env.js"
import { hqMemory } from "../lib/memory/hq.js"
import { sessionSpendStore } from "../lib/spend/state.js"

/**
 * The `hq` memory slot: the org's brain. Recalled every turn from hq's search; written only through
 * `hq__propose_entry`, which creates a pending proposal for a founder (the trust rule). eve's
 * built-in file memory is not used.
 */
export default defineMemory({
  description:
    "The org's brain in hq: facts, voice, decisions, playbooks and customers. Read-only for you; " +
    "to change it, propose an entry and a founder decides.",
  provider: hqMemory({
    hq: hqFromEnv,
    runId: () => {
      try {
        return sessionSpendStore.get().runId ?? undefined
      } catch {
        return undefined
      }
    },
  }),
  scope: "org",
})
