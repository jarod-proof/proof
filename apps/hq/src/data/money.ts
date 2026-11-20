// Money in hq is exact: integer units of $0.0001 (the scale of numeric(10,4)). No decimal library
// and no float arithmetic: an amount comes in as a JS number (JSON), is read once as a decimal
// string, and from there is whole numbers. The database does its sums in numeric and hands them
// back as text, which `parseUnits` reads.
import { AppError } from "@proof/errors"

/** Integer units of $0.0001. 10_0000 units is $10.00. */
export type Units = number

const SCALE = 4
/** The largest amount numeric(10,4) holds. */
const MAX_UNITS = 999_999_9999

/** The daily cap on Eve chat and schedules: $10.00. */
export const DAILY_CAP: Units = 10_0000

/**
 * A dollar amount as units, rounded UP to the next $0.0001: a cost is never undercounted. Reads
 * the number's decimal text (toFixed(10), exact enough for any real cost), so no multiplication.
 */
export function toUnits(usd: number, what = "amount"): Units {
  if (!Number.isFinite(usd) || usd < 0 || usd > 999_999) {
    throw new AppError("BAD_REQUEST", `${what} must be between 0 and 999999 dollars`)
  }
  const [whole = "0", fraction = ""] = usd.toFixed(10).split(".")
  const kept = fraction.slice(0, SCALE)
  const rest = fraction.slice(SCALE)
  const units = Number(whole) * 10 ** SCALE + Number(kept.padEnd(SCALE, "0"))
  return /[1-9]/.test(rest) ? units + 1 : units
}

/** Like `toUnits`, but a positive amount is at least one unit (an estimate of 0 reserves nothing). */
export function toPositiveUnits(usd: number, what = "amount"): Units {
  const units = toUnits(usd, what)
  if (units === 0) throw new AppError("BAD_REQUEST", `${what} must be more than 0`)
  return units
}

/**
 * Units as decimal text for DISPLAY and arithmetic results: 99000 is "9.9000". Sums of many rows can
 * run past what one column holds, and a report of them must still answer, so this has no upper
 * bound but the safe-integer range. Use `columnText` for a value that is written to a column.
 */
export function formatUnits(units: Units): string {
  if (!Number.isSafeInteger(units) || units < 0) {
    throw new AppError("INTERNAL", "money out of range")
  }
  const digits = String(units).padStart(SCALE + 1, "0")
  return `${digits.slice(0, -SCALE)}.${digits.slice(-SCALE)}`
}

/** Units as the text for one numeric(10,4) cell: the same, refused above what the column holds. */
export function columnText(units: Units): string {
  if (units > MAX_UNITS) {
    throw new AppError("BAD_REQUEST", "That amount is more than one record can hold")
  }
  return formatUnits(units)
}

/** A numeric(10,4) value, as Postgres returns it as text ("9.9000", "10", "0"), as units. */
export function parseUnits(text: string): Units {
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(text.trim())
  if (!match) throw new AppError("INTERNAL", `not a decimal: ${text}`)
  const [, sign, whole = "0", fraction = ""] = match
  const units = Number(whole) * 10 ** SCALE + Number(fraction.slice(0, SCALE).padEnd(SCALE, "0"))
  return sign ? -units : units
}

/** Units as a JSON number of dollars (through the decimal text, so no division). */
export function unitsToUsd(units: Units): number {
  const negative = units < 0
  const text = formatUnits(Math.abs(units))
  return Number(negative ? `-${text}` : text)
}
