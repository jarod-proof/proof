import { useId } from "react"

const HEIGHT = 56
const BAR_MAX = 52
const SLOT = 4
const BAR = 3
const HOUR_MS = 3_600_000

interface Bucket {
  at: string
  count: number
}

/** Hours between two instants, in whole hours when it is one, else with one decimal. */
function hoursBetween(from: number, to: number): string {
  const hours = (to - from) / HOUR_MS
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1)
}

/**
 * The signals of the item's recurrence key in 30-minute buckets, as one inline SVG made of tokens
 * only: bars are `<rect>`s with a token colour class and `fill="currentColor"` (no style attribute),
 * inside a `<figure>`: the svg is `aria-hidden` and a screen-reader-only `<figcaption>` carries the
 * totals, so no `role="img"` is needed (the lint rule that prefers `<img>` cannot be met by an svg
 * and may not be disabled). Bars are red before the merge and green from the bucket that starts at
 * the merge on. hq's range starts 12 hours before the merge and ends at now (or at the window's
 * end, `through="window end"`), so the first caption is derived from the data and the last says
 * which end it is. No buckets (an item without a recurrence key) draw no chart.
 */
export function VerificationChart({
  buckets,
  mergedAt,
  through = "now",
}: {
  buckets: Bucket[]
  mergedAt: string | null
  /** What the right edge is: "now" while the window runs, else "window end". */
  through?: "now" | "window end"
}) {
  const captionId = useId()
  if (buckets.length === 0) {
    return (
      <p className="m-0 text-xs text-faint">
        No occurrence counts: this item has no recurrence key.
      </p>
    )
  }
  const merge = mergedAt === null ? Number.NaN : new Date(mergedAt).getTime()
  const merged = !Number.isNaN(merge)
  const isBefore = (bucket: Bucket) => !merged || new Date(bucket.at).getTime() < merge
  const before = buckets.filter(isBefore).reduce((sum, b) => sum + b.count, 0)
  const total = buckets.reduce((sum, b) => sum + b.count, 0)
  const max = Math.max(...buckets.map((b) => b.count))
  const firstSince = buckets.findIndex((b) => !isBefore(b))
  const first = new Date(buckets[0]?.at ?? "").getTime()
  // A range that starts at or after the merge measured nothing before it: the text must not
  // report a zero for a stretch hq cut off (the items may have had many signals there).
  const startsAtMerge = merged && first === merge
  const startsAfterMerge = merged && first > merge
  // The left edge: 12 hours before the merge as hq sends it, the merge itself when the range
  // starts there, else the start of a range hq cut short, which may begin after the merge.
  const lead =
    merged && !Number.isNaN(first) && first < merge
      ? `${hoursBetween(first, merge)} h before the merge`
      : null
  const leftEdge = lead ?? (startsAtMerge ? "merged" : "start of range")
  const label = !merged
    ? `Signals per 30 minutes: ${total} so far, no merge yet`
    : startsAtMerge
      ? `Signals per 30 minutes: ${total} since the merge`
      : startsAfterMerge
        ? `Signals per 30 minutes: ${total} in this range, which starts after the merge`
        : `Signals per 30 minutes: ${before} before the merge, ${total - before} since`
  const alt = `${label}. Each bar is one half hour${
    merged && !startsAtMerge && !startsAfterMerge
      ? ": red before the merge, green from the merge on."
      : "."
  }`

  return (
    <figure aria-labelledby={captionId} className="m-0 flex min-w-0 flex-col gap-1.5">
      <figcaption id={captionId} className="sr-only">
        {alt}
      </figcaption>
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${buckets.length * SLOT} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-14 w-full"
      >
        {buckets.map((bucket, i) => {
          // A zero is a hairline; max is above 0 whenever a count is, so no division by 0.
          const height =
            bucket.count === 0 ? 1 : Math.max(2, Math.round((bucket.count / max) * BAR_MAX))
          return (
            <rect
              key={bucket.at}
              className={isBefore(bucket) ? "text-destructive" : "text-success"}
              fill="currentColor"
              x={i * SLOT + (SLOT - BAR) / 2}
              y={HEIGHT - height}
              width={BAR}
              height={height}
            />
          )
        })}
        {firstSince > 0 ? (
          <line
            className="text-faint"
            stroke="currentColor"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            x1={firstSince * SLOT}
            x2={firstSince * SLOT}
            y1={0}
            y2={HEIGHT}
          />
        ) : null}
      </svg>
      <div className="flex justify-between gap-2 font-mono text-[10.5px] text-faint">
        <span>{leftEdge}</span>
        {merged && lead ? <span>merged</span> : null}
        <span>{through}</span>
      </div>
      <p className="m-0 font-mono text-[10.5px] text-faint">
        {max === 0
          ? "No signals in this range"
          : `Tallest bar: ${max} ${max === 1 ? "signal" : "signals"} in 30 minutes`}
      </p>
    </figure>
  )
}
