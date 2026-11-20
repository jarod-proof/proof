// Pure helpers for the run view and the org's run list. No network, no React.
import { z } from "zod"

import type { StatusState } from "@proof/ui/dplus/status"

import type { ApprovalDecision, RunStatus, RunStep, RunSummary } from "./runs-api"

/** Shape + word for a run or step status. `needs_you` is the solar "needs you" state. */
export const RUN_STATUS_STATE: Record<RunStatus, StatusState> = {
  queued: "queued",
  running: "running",
  needs_you: "needs-you",
  done: "done",
  failed: "failed",
}

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  needs_you: "Needs you",
  done: "Done",
  failed: "Failed",
}

/** Runs the page keeps up to date: their status can still change. */
export function isLiveStatus(status: RunStatus): boolean {
  return status === "queued" || status === "running" || status === "needs_you"
}

/** "Step 4 of 6": the first step that is not done, or the last step once all are. Null with no steps. */
export function currentStep(steps: RunStep[]): { index: number; total: number } | null {
  if (steps.length === 0) return null
  const open = steps.findIndex((step) => step.status !== "done")
  const index = open === -1 ? steps.length : open + 1
  return { index, total: steps.length }
}

/** Whole seconds left in an undo window, from the server's end time and the server's current time. */
export function secondsLeft(untilIso: string, serverNowMs: number): number {
  const untilMs = Date.parse(untilIso)
  if (Number.isNaN(untilMs)) return 0
  return Math.max(0, Math.ceil((untilMs - serverNowMs) / 1000))
}

/** "1 second" or "29 seconds". */
export function secondsCopy(seconds: number): string {
  return seconds === 1 ? "1 second" : `${seconds} seconds`
}

/** The decision's line for a person, in words: "You approved." when the viewer decided it. */
export function decisionCopy(
  status: "pending" | "approved" | "denied",
  decision: ApprovalDecision | null,
  viewerId?: string,
): string {
  if (status === "pending" || !decision) return "Waiting for a decision."
  if (viewerId && decision.decidedBy === viewerId) {
    return status === "approved" ? "You approved." : "You denied."
  }
  const verb = status === "approved" ? "Approved" : "Denied"
  return decision.decidedBy ? `${verb} by a teammate.` : `${verb}.`
}

/** Whole watt-hours and small numbers read as the board does: "0.6 Wh", "2 Wh". */
export function formatWh(value: number): string {
  return `${Number(value.toFixed(2))} Wh`
}

/**
 * "18k tokens", "950 tokens", "1.2M tokens". Thousands are rounded first, so 999,500 and up reads as
 * "1M tokens" rather than "1000k tokens".
 */
export function formatTokens(value: number): string {
  const thousands = Math.round(value / 1000)
  if (thousands >= 1000) return `${Number((value / 1_000_000).toFixed(1))}M tokens`
  if (value >= 1_000) return `${thousands}k tokens`
  return `${value} tokens`
}

export function formatCount(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`
}

/** The footprint line: energy against the budget (when set), tokens and tool calls. */
export function footprintCopy(
  footprint: { energyWh: number; tokens: number; toolCalls: number },
  energyBudgetWh: number | null,
): string {
  const energy =
    energyBudgetWh === null
      ? `${formatWh(footprint.energyWh)} used · no budget set`
      : `${formatWh(footprint.energyWh)} of ${formatWh(energyBudgetWh)} run budget`
  return `${energy} · ${formatTokens(footprint.tokens)} · ${formatCount(footprint.toolCalls, "tool call")}`
}

/**
 * The footprint meter's cells: used ones are the share of the budget spent, out of 10. No budget
 * means no cells are filled, since there is nothing to measure against.
 */
export function footprintCells(energyWh: number, energyBudgetWh: number | null, cells = 10) {
  if (energyBudgetWh === null || energyBudgetWh <= 0) return { value: 0, max: cells }
  const share = Math.min(1, Math.max(0, energyWh / energyBudgetWh))
  return { value: Math.round(share * cells), max: cells }
}

/** The time in the reader's locale: "16 Oct, 14:30". Invalid input reads as "unknown time". */
export function formatWhen(iso: string | null): string {
  if (!iso) return "unknown time"
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "unknown time"
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/** The run's header meta: "started 4 min ago by Jordan" as far as the API tells it. */
export function runMetaCopy(run: Pick<RunSummary, "startedAt" | "createdAt" | "status">): string {
  const started = run.startedAt ?? run.createdAt
  return run.status === "queued"
    ? `queued since ${formatWhen(started)}`
    : `started ${formatWhen(started)}`
}

/** The defer picker: a local date and time in `datetime-local` form, which must be in the future. */
export const deferSchema = z.object({
  until: z
    .string()
    .min(1, "Pick a date and time.")
    .refine((value) => {
      const time = new Date(value).getTime()
      return !Number.isNaN(time)
    }, "Pick a valid date and time.")
    .refine((value) => new Date(value).getTime() > Date.now(), "Pick a time in the future."),
})

export type DeferValues = z.infer<typeof deferSchema>

/** The ISO time the server takes, from the picker's local value. */
export function deferIso(local: string): string {
  return new Date(local).toISOString()
}

/** The steer message: trimmed, one to 5000 characters. */
export const steerSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, "Write a message for the agent.")
    .max(5000, "Use 5000 characters or fewer."),
})

export type SteerValues = z.infer<typeof steerSchema>

/** Ordering for the org's list: runs needing a person first, then the rest in the order received. */
export function needsYouFirst<T extends { status: RunStatus }>(runs: T[]): T[] {
  return [
    ...runs.filter((run) => run.status === "needs_you"),
    ...runs.filter((run) => run.status !== "needs_you"),
  ]
}

export const RUN_FILTERS: { id: RunStatus | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "needs_you", label: "Needs you" },
  { id: "running", label: "Running" },
  { id: "queued", label: "Queued" },
  { id: "done", label: "Done" },
  { id: "failed", label: "Failed" },
]

export function runFilterOf(value: unknown): RunStatus | "all" {
  return RUN_FILTERS.find((filter) => filter.id === value)?.id ?? "all"
}
