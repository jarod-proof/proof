import { describe, expect, it } from "vitest"
import { ProofError } from "./errors"
import { paginate } from "./paginate"

interface Page {
  projects: string[]
  nextCursor: string | null
}

describe("paginate", () => {
  it("walks every page in order, passing each cursor back", async () => {
    const pages: Record<string, Page> = {
      start: { projects: ["a", "b"], nextCursor: "c1" },
      c1: { projects: ["c"], nextCursor: "c2" },
      c2: { projects: [], nextCursor: null },
    }
    const requested: (string | undefined)[] = []
    const items: string[] = []
    for await (const item of paginate(
      async (cursor) => {
        requested.push(cursor)
        return pages[cursor ?? "start"] as Page
      },
      (page) => page.projects,
    )) {
      items.push(item)
    }
    expect(items).toEqual(["a", "b", "c"])
    expect(requested).toEqual([undefined, "c1", "c2"])
  })

  it("yields nothing for an empty first page", async () => {
    const items: string[] = []
    for await (const item of paginate(
      async () => ({ projects: [], nextCursor: null }) as Page,
      (page) => page.projects,
    )) {
      items.push(item)
    }
    expect(items).toEqual([])
  })

  it("stops with an error when the server repeats a cursor", async () => {
    const seen: string[] = []
    const iterate = async () => {
      for await (const _ of paginate(
        async (cursor) => {
          if (cursor !== undefined) seen.push(cursor)
          return { projects: ["x"], nextCursor: "same" } as Page
        },
        (page) => page.projects,
      )) {
        // drain
      }
    }
    await expect(iterate()).rejects.toMatchObject({ code: "PAGINATION_LOOP" })
    await expect(iterate()).rejects.toBeInstanceOf(ProofError)
    // The first run fetched "same" once, then the second run did the same from a fresh start.
    expect(seen).toEqual(["same", "same"])
  })

  it("can be stopped early by the caller", async () => {
    let fetches = 0
    for await (const item of paginate(
      async () => {
        fetches++
        return { projects: ["a", "b"], nextCursor: "more" } as Page
      },
      (page) => page.projects,
    )) {
      if (item === "a") break
    }
    expect(fetches).toBe(1)
  })
})
