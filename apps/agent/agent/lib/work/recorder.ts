import { agentEnv } from "@proof/env/agent"
import { createHqClient, type HqClient, HqError } from "../hq/client.js"
import { log } from "../log.js"

/**
 * How the agent's hooks reach hq without ever failing a turn.
 *
 * @remarks
 * A throwing GitHub hook means no dispatch at all (eve awaits it and treats a throw as "do
 * nothing"), so everything a hook writes to hq goes through {@link recordSafely}: it never throws,
 * it logs what it dropped under `work_record_dropped` (the event name is the metric a log drain
 * counts; the agent has no metrics backend) and it counts the drop in {@link recorderStats}, which
 * tests read. Nothing here retries: a dropped record is healed by the next event (every pull
 * request event carries the full record) or is a signal that never was.
 */

/** Per call, for the hooks: eve acknowledges the webhook first, but a slow hq delays the dispatch. */
export const HOOK_HQ_TIMEOUT_MS = 3000

/** Why a record was dropped. `unmappable` is the mapper's own: the payload lacked what hq needs. */
export type DropKind = "conflict" | "rejected" | "unavailable" | "unmappable"

export interface RecorderStats {
  /** Every drop, whatever its kind (the sum of the others plus the unmappable ones). */
  dropped: number
  conflicts: number
  rejected: number
  unavailable: number
}

const zero = (): RecorderStats => ({ dropped: 0, conflicts: 0, rejected: 0, unavailable: 0 })
let stats = zero()

/** The in-process counters of dropped records since the last reset. */
export function recorderStats(): RecorderStats {
  return { ...stats }
}

/** Resets the counters (tests). */
export function resetRecorderStats(): void {
  stats = zero()
}

/**
 * Counts and logs one dropped record. Only the label, the kind and hq's status and code are
 * logged: never an error message, which can carry the outside text that was being recorded.
 */
export function recordDropped(
  label: string,
  kind: DropKind,
  detail: { status?: number; code?: string } = {},
): void {
  stats.dropped += 1
  if (kind === "conflict") {
    stats.conflicts += 1
  } else if (kind === "rejected") {
    stats.rejected += 1
  } else if (kind === "unavailable") {
    stats.unavailable += 1
  }
  try {
    log.warn("work_record_dropped", { label, kind, status: detail.status, code: detail.code })
  } catch {
    // A logger that fails must not fail a hook.
  }
}

/** 409 is a conflict, another 4xx a refusal; a 5xx, no connection, a timeout or a bad reply is hq being unavailable. */
function classify(error: unknown): { kind: DropKind; status?: number; code?: string } {
  if (error instanceof HqError) {
    const { status, code } = error
    if (status === 409) {
      return { kind: "conflict", status, code }
    }
    if (status >= 400 && status < 500) {
      return { kind: "rejected", status, code }
    }
    return { kind: "unavailable", status, code }
  }
  return { kind: "unavailable" }
}

/**
 * Runs one recording call and never throws.
 *
 * @returns What the call returned, or null when it failed (logged and counted).
 */
export async function recordSafely<T>(label: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run()
  } catch (error) {
    const { kind, status, code } = classify(error)
    recordDropped(label, kind, { status, code })
    return null
  }
}

/**
 * The hq client the GitHub hooks use, or null (quietly) when HQ_BASE_URL or HQ_AGENT_API_KEY is
 * unset: the hook tests and any deploy without hq run exactly as before. Read from the environment
 * on every call, with a {@link HOOK_HQ_TIMEOUT_MS} timeout (the 10 second default stays for
 * stations and schedules).
 */
export function hookHq(): HqClient | null {
  const baseUrl = agentEnv("HQ_BASE_URL")?.trim()
  const apiKey = agentEnv("HQ_AGENT_API_KEY")?.trim()
  if (!baseUrl || !apiKey) {
    return null
  }
  return createHqClient({ baseUrl, apiKey, timeoutMs: HOOK_HQ_TIMEOUT_MS })
}
