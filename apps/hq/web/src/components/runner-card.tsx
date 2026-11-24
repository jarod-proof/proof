import { Link } from "@tanstack/react-router"

import type { FactoryStatus } from "../api/schemas"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Relative to hq's own clock (`status.now`), so the text never depends on the browser's. */
function ago(from: string, now: string): string {
  const ms = Math.max(0, Date.parse(now) - Date.parse(from))
  if (ms < MINUTE) return "just now"
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`
  return `${Math.floor(ms / DAY)}d ago`
}

function lastRunLine(status: FactoryStatus): string {
  let newest: { runner: string; at: string } | null = null
  for (const r of status.runners) {
    if (r.lastStartedAt && (!newest || Date.parse(r.lastStartedAt) > Date.parse(newest.at))) {
      newest = { runner: r.runner, at: r.lastStartedAt }
    }
  }
  return newest ? `${newest.runner} · last run ${ago(newest.at, status.now)}` : "no runs yet"
}

function capLeftPercent(allowance: FactoryStatus["allowance"]): number {
  const total = allowance.capUsd + allowance.grantedUsd
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((allowance.remainingUsd / total) * 100)))
}

/**
 * The sidebar's runner card. hq has no heartbeat, so it never says online or busy: the dot is
 * neutral and the line says so. The bar is the Eve spend cap, not the Claude plan.
 */
export function RunnerCard({
  status,
  state,
}: {
  status: FactoryStatus | undefined
  state: "loading" | "error" | "ready"
}) {
  const ready = state === "ready" && status !== undefined
  const percent = ready ? capLeftPercent(status.allowance) : 0
  return (
    <Link
      to="/runner"
      className="flex min-h-touch flex-col gap-2.5 rounded-control border border-border bg-muted p-3"
    >
      <span className="flex items-center gap-2 text-[13px] font-medium text-foreground">
        <span className="size-2 rounded-full bg-faint" aria-hidden="true" />
        Runner status not reported
      </span>
      {ready ? (
        <>
          <span className="font-mono text-[11px] text-faint">{lastRunLine(status)}</span>
          <progress
            aria-label="Eve spend cap left"
            value={percent}
            max={100}
            className="h-1.5 w-full appearance-none overflow-hidden rounded-[3px] bg-track [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-track [&::-webkit-progress-value]:bg-primary"
          />
          <span className="text-[11px] text-muted-foreground">Eve spend cap {percent}% left</span>
        </>
      ) : (
        <span className="text-[11px] text-muted-foreground">
          {state === "error" ? "Runner status unavailable" : "Loading runner status"}
        </span>
      )}
    </Link>
  )
}
