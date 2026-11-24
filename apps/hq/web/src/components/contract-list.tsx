import type { ContractItemView } from "../api/schemas"
import { ClampedText } from "./clamped-text"

/**
 * Verifier kinds hq cannot evaluate yet (`sentry`, `posthog`; hq's `CONNECTED_VERIFIER_KINDS`
 * lives in its data layer, which the browser cannot import, so a test pins this list to it).
 * A pending row of one of these is "Not connected": nothing is checking it, so it is neither
 * waiting nor progressing.
 */
export const NOT_CONNECTED_VERIFIERS: readonly ContractItemView["verifier"]["kind"][] = [
  "sentry",
  "posthog",
]

function statusOf(item: ContractItemView): { label: string; className: string } {
  if (item.status === "passing") return { label: "Passing", className: "text-success" }
  if (item.status === "failing") return { label: "Failing", className: "text-destructive" }
  if (NOT_CONNECTED_VERIFIERS.includes(item.verifier.kind)) {
    return { label: "Not connected", className: "text-faint" }
  }
  return { label: "Pending", className: "text-faint" }
}

/**
 * The contract of the item, one row per check: its text, who verifies it (hq's own label), its
 * status and, when hq has it, the evidence. Everything but the status is plain text; the evidence
 * is cut with a "Show all" when it is long.
 */
export function ContractList({ items }: { items: ContractItemView[] }) {
  if (items.length === 0) {
    return <p className="m-0 text-xs text-faint">No contract is recorded yet.</p>
  }
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {items.map((item) => {
        const status = statusOf(item)
        return (
          <li
            key={item.id}
            className="flex min-w-0 flex-col gap-1.5 overflow-hidden rounded-control border border-border bg-muted px-3 py-2.5 text-[13px]"
          >
            <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="min-w-0 flex-[1_1_260px] leading-snug wrap-anywhere">
                {item.text}
              </span>
              <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="font-mono text-[11px] text-faint wrap-anywhere">
                  {item.verifier.label}
                </span>
                <span className={`text-xs font-medium ${status.className}`}>{status.label}</span>
              </span>
            </div>
            {item.evidence ? (
              <ClampedText
                text={item.evidence}
                what="the evidence"
                className="text-xs leading-relaxed text-muted-foreground"
              />
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
