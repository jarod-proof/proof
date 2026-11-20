import { agentEnv } from "@proof/env/agent"
import { createHqClient, type HqClient } from "../agent/lib/hq/client.js"

/**
 * What the offline evals share: the real hq the harness started (`scripts/run.ts`), the probe that
 * records what the scripted agent did, and the clock that gives each eval an empty ledger day.
 * These evals run only through `pnpm eval`, which sets all of it; they carry the `offline` tag.
 */

export const OFFLINE_TAG = "offline"

const need = (name: "HQ_BASE_URL" | "HQ_AGENT_API_KEY" | "AGENT_PROBE_URL"): string => {
  const value = agentEnv(name)
  if (!value) {
    throw new Error(
      `${name} is not set: run the offline evals with \`pnpm --filter @proof/agent eval\`.`,
    )
  }
  return value
}

/** hq, as the agent's key sees it: the same client and scope the deployed agent has. */
export const hq = (): HqClient =>
  createHqClient({ baseUrl: need("HQ_BASE_URL"), apiKey: need("HQ_AGENT_API_KEY") })

/** Starts a fresh UTC day in hq (an empty ledger) and clears the probe. */
export async function freshDay(): Promise<void> {
  await fetch(`${need("AGENT_PROBE_URL")}/day/next`, { method: "POST" })
}

/**
 * Puts hq on the real clock and clears the probe: a signed Slack click is checked by the agent and
 * by hq at the same real time. The next `freshDay` puts hq back on its scripted clock.
 */
export async function useRealClock(): Promise<void> {
  await fetch(`${need("AGENT_PROBE_URL")}/clock/real`, { method: "POST" })
}

/** The probe's address, for a click's `response_url` (where Slack would show the reply). */
export const probeUrl = (): string => need("AGENT_PROBE_URL")

export interface ProbeEvent {
  event: string
  detail: unknown
}

/** What the scripted agent reported since the last `freshDay`: model calls, bigger-model runs. */
export async function probeEvents(): Promise<ProbeEvent[]> {
  const reply = await fetch(`${need("AGENT_PROBE_URL")}/events`)
  return ((await reply.json()) as { events: ProbeEvent[] }).events
}

/** Today's eve spend as hq reports it. */
export const allowance = () => hq().getSpendAllowance()

export interface RunRow {
  task: string
  runner: string
  outcome: string | null
  costUsd: number
  costEstimated: boolean
  summary: { worked: string[]; failed: string[]; stop: string[] } | null
}

/** The newest run hq logged, read with the agent's key (the day's runs start empty). */
export async function latestRun(): Promise<RunRow | undefined> {
  const reply = await fetch(`${need("HQ_BASE_URL")}/v1/runs`, {
    headers: { "x-api-key": need("HQ_AGENT_API_KEY") },
  })
  return ((await reply.json()) as { runs: RunRow[] }).runs[0]
}

/**
 * Waits until the newest run is finished, then returns it. A turn resolves in the eval when eve
 * emits `turn.settled`, not when the spend hook that listens to it is done: that hook records the
 * turn's cost, settles the hold and only then finishes the run (`lib/spend/hooks.ts`). So the run's
 * outcome is the hook's last step, and an eval that reads the allowance before it can catch the
 * hold half way between the record and the settle. Throws, failing the eval with a clear message,
 * if the run is not finished within `timeoutMs`: the wait is never skipped and never a fixed sleep.
 */
export async function latestFinishedRun({
  timeoutMs = 10_000,
  pollMs = 25,
}: {
  timeoutMs?: number
  pollMs?: number
} = {}): Promise<RunRow> {
  const deadline = Date.now() + timeoutMs
  let run = await latestRun()
  while (run?.outcome == null) {
    if (Date.now() >= deadline) {
      throw new Error(
        `the turn's run was not finished in hq within ${timeoutMs}ms: the spend hook's ` +
          "turn.settled never reached finish_run, so the hold and the cost cannot be read",
      )
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    run = await latestRun()
  }
  return run
}

/** hq's pending proposals, read with the agent's key. */
export async function pendingProposals(): Promise<
  { title: string; status: string; entryId: string | null }[]
> {
  const reply = await fetch(`${need("HQ_BASE_URL")}/v1/proposals?status=pending`, {
    headers: { "x-api-key": need("HQ_AGENT_API_KEY") },
  })
  return (
    (await reply.json()) as {
      proposals: { title: string; status: string; entryId: string | null }[]
    }
  ).proposals
}

/**
 * Waits for the scripted agent to report an event to the probe (a Slack post, say), then returns
 * every event with that name. Schedules run after the dispatch route has answered, so a check has
 * to wait for them; this gives up after `timeoutMs` and returns what there is.
 */
export async function waitForProbeEvents(
  event: string,
  { timeoutMs = 15_000, settleMs = 1_000 }: { timeoutMs?: number; settleMs?: number } = {},
): Promise<ProbeEvent[]> {
  const deadline = Date.now() + timeoutMs
  let seen: ProbeEvent[] = []
  while (Date.now() < deadline) {
    seen = (await probeEvents()).filter((entry) => entry.event === event)
    if (seen.length > 0) {
      // Stay a moment: a second post, if the digest wrongly made one, must still be counted.
      await new Promise((resolve) => setTimeout(resolve, settleMs))
      return (await probeEvents()).filter((entry) => entry.event === event)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return seen
}
