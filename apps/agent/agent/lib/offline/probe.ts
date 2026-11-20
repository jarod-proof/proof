import { agentEnv } from "@proof/env/agent"
import { offlineMode } from "./mode.js"

/**
 * Tells the offline probe (the eval harness, `scripts/run.ts`) that something happened: a scripted
 * model call, a bigger-model run. A no-op unless AGENT_PROBE_URL is set, which only the harness
 * does. The probe only watches; a failure to reach it never changes what the agent does.
 */
export async function traceToProbe(event: string, detail: unknown): Promise<void> {
  // Only the offline harness has a probe: in a real deploy nothing is ever sent to it.
  const probe = offlineMode() ? agentEnv("AGENT_PROBE_URL") : undefined
  if (!probe) {
    return
  }
  try {
    await fetch(`${probe.replace(/\/+$/, "")}/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event, detail }),
      signal: AbortSignal.timeout(2000),
    })
  } catch {
    // Watching only.
  }
}
