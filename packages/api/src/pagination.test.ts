import { AppError } from "@proof/errors"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { decodeCursor, encodeCursor, paginated, paginationInput } from "./pagination"

describe("paginationInput", () => {
  it("defaults limit to 50 and coerces query strings", () => {
    expect(paginationInput.parse({})).toEqual({ limit: 50 })
    expect(paginationInput.parse({ cursor: "abc", limit: "20" })).toEqual({
      cursor: "abc",
      limit: 20,
    })
  })

  it("rejects limits outside 1..100", () => {
    expect(paginationInput.safeParse({ limit: "0" }).success).toBe(false)
    expect(paginationInput.safeParse({ limit: "101" }).success).toBe(false)
    expect(paginationInput.safeParse({ limit: "2.5" }).success).toBe(false)
    expect(paginationInput.safeParse({ limit: "100" }).success).toBe(true)
  })
})

describe("paginated", () => {
  const page = paginated("projects", z.object({ id: z.string() }))

  it("validates the items under the key and the next cursor", () => {
    expect(page.parse({ projects: [{ id: "p1" }], nextCursor: null })).toEqual({
      projects: [{ id: "p1" }],
      nextCursor: null,
    })
    expect(page.safeParse({ projects: [{ id: 1 }], nextCursor: null }).success).toBe(false)
    expect(page.safeParse({ projects: [], nextCursor: undefined }).success).toBe(false)
    expect(page.shape.projects).toBeDefined()
  })
})

describe("cursors", () => {
  it("round-trips a position through encode and decode", () => {
    const cursor = encodeCursor({ at: "2026-01-02T03:04:05.000Z", id: "row-é ✓", n: 7 })
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeCursor(cursor)).toEqual({ at: "2026-01-02T03:04:05.000Z", id: "row-é ✓", n: 7 })
  })

  it("rejects garbage with BAD_REQUEST and a hint", () => {
    const truncated = encodeCursor({ id: "abc" }).slice(0, -4)
    for (const bad of ["!!!", "not base64", truncated, btoa("[1,2]"), btoa("null")]) {
      let thrown: unknown
      try {
        decodeCursor(bad)
      } catch (e) {
        thrown = e
      }
      expect(thrown).toBeInstanceOf(AppError)
      expect(thrown).toMatchObject({ code: "BAD_REQUEST", message: "Invalid cursor" })
      expect((thrown as AppError).hint).toContain("nextCursor")
    }
  })

  it("rejects a cursor that is valid base64 but not UTF-8 JSON", () => {
    expect(() => decodeCursor(btoa("ÿþ not json"))).toThrow(AppError)
  })
})
