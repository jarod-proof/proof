import { describe, expect, it } from "vitest"

import {
  columnText,
  DAILY_CAP,
  formatUnits,
  parseUnits,
  toPositiveUnits,
  toUnits,
  unitsToUsd,
} from "./money"

describe("money", () => {
  it("converts dollars to integer units of $0.0001 without float drift", () => {
    expect(toUnits(0)).toBe(0)
    expect(toUnits(9.9)).toBe(9_9000)
    expect(toUnits(0.1 + 0.2)).toBe(3000) // 0.30000000000000004 is $0.30
    expect(toUnits(10)).toBe(DAILY_CAP)
    expect(toUnits(1234.5678)).toBe(1234_5678)
  })

  it("rounds a finer cost up, so a cost is never undercounted", () => {
    expect(toUnits(0.000412)).toBe(5)
    expect(toUnits(0.00001)).toBe(1)
    expect(toUnits(0.0001)).toBe(1)
    expect(toUnits(0.00010001)).toBe(2)
  })

  it("refuses a negative, non-finite or absurd amount, and a zero where one is needed", () => {
    for (const bad of [-0.01, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000]) {
      expect(() => toUnits(bad)).toThrow()
    }
    expect(() => toPositiveUnits(0)).toThrow()
  })

  it("formats and parses the decimal text numeric(10,4) uses", () => {
    expect(formatUnits(9_9000)).toBe("9.9000")
    expect(formatUnits(5)).toBe("0.0005")
    expect(formatUnits(0)).toBe("0.0000")
    expect(parseUnits("9.9000")).toBe(9_9000)
    expect(parseUnits("10")).toBe(10_0000)
    expect(parseUnits("0")).toBe(0)
    expect(parseUnits("0.5")).toBe(5000)
    expect(parseUnits("-0.2500")).toBe(-2500)
    expect(() => parseUnits("abc")).toThrow()
  })

  it("formats a sum past one column's maximum for display, and refuses it for a column", () => {
    const sum = 2 * 999_999_9999 // two maximum cells
    expect(formatUnits(sum)).toBe("1999999.9998")
    expect(unitsToUsd(sum)).toBe(1999999.9998)
    expect(unitsToUsd(-sum)).toBe(-1999999.9998)
    expect(() => columnText(sum)).toThrow(/more than one record/)
    expect(columnText(999_999_9999)).toBe("999999.9999")
    expect(() => formatUnits(Number.MAX_SAFE_INTEGER + 2)).toThrow()
  })

  it("reports units as a JSON number through the decimal text", () => {
    expect(unitsToUsd(9_9000)).toBe(9.9)
    expect(unitsToUsd(3000)).toBe(0.3)
    expect(unitsToUsd(-1000)).toBe(-0.1)
  })
})
