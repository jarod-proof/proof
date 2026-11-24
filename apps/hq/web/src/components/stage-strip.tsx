import type { WorkItemDetail } from "../api/schemas"

const LABEL: Record<WorkItemDetail["stages"][number]["stage"], string> = {
  signal: "Signal",
  triage: "Triage",
  plan: "Plan",
  attempt: "Attempt",
  review: "Review",
  deploy: "Deploy",
  verify: "Verify",
}
const ORDER = Object.keys(LABEL)

const STATUS_CLASS = {
  done: "border-border bg-muted text-soft",
  now: "border-ok-border bg-ok-surface text-success",
  todo: "border-border bg-muted text-faint",
} as const

/**
 * The mock's `Progress` list: the stages hq sends, numbered by their place in the pipeline. A
 * stage hq marks `done` is "done", except Deploy: no deploy source is connected, so its "done" is
 * the 15-minute assumption of the verification window and is tagged "assumed". A later cycle (a
 * reopened item) says "cycle <n>" on the current stage.
 */
export function StageStrip({ stages, cycle }: { stages: WorkItemDetail["stages"]; cycle: number }) {
  return (
    <ol aria-label="Progress" className="m-0 flex list-none flex-wrap gap-2 p-0">
      {stages.map(({ stage, status }) => {
        const assumed = stage === "deploy" && status === "done"
        return (
          <li
            key={stage}
            aria-current={status === "now" ? "step" : undefined}
            className={`box-border flex min-h-touch min-w-0 flex-[1_1_120px] flex-wrap items-center gap-x-2 gap-y-0.5 rounded-control border px-3 py-1 text-[13px] ${STATUS_CLASS[status]}`}
          >
            <span className="font-mono text-[11px]">
              {String(ORDER.indexOf(stage) + 1).padStart(2, "0")}
            </span>
            <span className="font-medium">{LABEL[stage]}</span>
            <span className="ml-auto flex flex-wrap gap-x-2 font-mono text-[10px]">
              {assumed ? (
                <>
                  <span aria-hidden="true">assumed</span>
                  <span className="sr-only">
                    done is assumed: deploy not observed, no deploy source is connected
                  </span>
                </>
              ) : status === "todo" ? null : (
                <span>{status}</span>
              )}
              {status === "now" && cycle > 1 ? <span>cycle {cycle}</span> : null}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
