// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query"
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { HqError } from "../api/errors"
import { hqKeys } from "../api/query-keys"
import { BUSY_MESSAGE, useOneWrite, writeMessage } from "./use-one-write"

const err = (kind: HqError["kind"], status: number, message: string) =>
  new HqError({ kind, status, message })

/** A query client whose invalidations are recorded, and held until `release()` when asked. */
function clientWith(options: { hold?: boolean } = {}) {
  const queryClient = new QueryClient()
  const invalidated: unknown[] = []
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  queryClient.invalidateQueries = (async (filters?: { queryKey?: unknown }) => {
    invalidated.push(filters?.queryKey)
    if (options.hold) await gate
  }) as typeof queryClient.invalidateQueries
  return { queryClient, invalidated, release }
}

describe("useOneWrite", () => {
  it("runs one write: pending while it is on its way, then the notice, then free", async () => {
    const { queryClient, invalidated } = clientWith()
    const view = renderHook(() => useOneWrite({ queryClient }))
    expect(view.result.current.pending).toBeNull()
    let done: boolean | undefined
    await act(async () => {
      done = await view.result.current.write("a", async () => "It worked.")
    })
    expect(done).toBe(true)
    expect(view.result.current.pending).toBeNull()
    expect(view.result.current.notice).toBe("It worked.")
    expect(view.result.current.errors).toEqual({})
    // The default screens' data is read again: every work query and the status counts.
    expect(invalidated).toEqual([hqKeys.work(), hqKeys.factoryStatus()])
  })

  it("re-reads the keys it is given instead of the defaults", async () => {
    const { queryClient, invalidated } = clientWith()
    const view = renderHook(() =>
      useOneWrite({ queryClient, invalidate: [["proposals"], hqKeys.work()] }),
    )
    await act(async () => {
      await view.result.current.write("a", async () => "ok")
    })
    expect(invalidated).toEqual([["proposals"], hqKeys.work()])
  })

  it("stays pending until the re-read has finished, not only until hq has answered", async () => {
    const { queryClient, release } = clientWith({ hold: true })
    const view = renderHook(() => useOneWrite({ queryClient }))
    let running: Promise<boolean> | undefined
    await act(async () => {
      running = view.result.current.write("a", async () => "ok")
    })
    // hq answered; the re-read is held: still locked, and no notice yet.
    expect(view.result.current.pending).toBe("a")
    expect(view.result.current.notice).toBeNull()
    await act(async () => {
      release()
      await running
    })
    expect(view.result.current.pending).toBeNull()
    expect(view.result.current.notice).toBe("ok")
  })

  it("two calls in one tick send once; the second says another change is in flight", async () => {
    const { queryClient } = clientWith()
    const view = renderHook(() => useOneWrite({ queryClient }))
    const send = vi.fn(async () => "ok")
    const results: boolean[] = []
    await act(async () => {
      const first = view.result.current.write("a", send)
      const second = view.result.current.write("b", send)
      results.push(await first, await second)
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(results).toEqual([true, false])
    expect(view.result.current.errors).toEqual({ b: BUSY_MESSAGE })
  })

  it("an error is kept under its key and frees the lock; sending the key again clears it", async () => {
    const { queryClient, invalidated } = clientWith()
    const view = renderHook(() => useOneWrite({ queryClient }))
    await act(async () => {
      await view.result.current.write("a", async () => {
        throw err("forbidden", 403, "Only a founder can do that.")
      })
    })
    expect(view.result.current.errors).toEqual({ a: "Only a founder can do that." })
    expect(view.result.current.pending).toBeNull()
    expect(view.result.current.notice).toBeNull()
    expect(invalidated).toEqual([])
    const send = vi.fn(async () => "ok")
    await act(async () => {
      await view.result.current.write("a", send)
    })
    expect(send).toHaveBeenCalledTimes(1)
    expect(view.result.current.errors).toEqual({})
  })

  it("a conflict reads the screen again; an unauthorized answer invalidates the status probe", async () => {
    const conflict = clientWith()
    const one = renderHook(() => useOneWrite({ queryClient: conflict.queryClient }))
    await act(async () => {
      await one.result.current.write("a", async () => {
        throw err("conflict", 409, "This merge is already approved.")
      })
    })
    expect(conflict.invalidated).toEqual([hqKeys.work(), hqKeys.factoryStatus()])

    const session = clientWith()
    const two = renderHook(() => useOneWrite({ queryClient: session.queryClient }))
    await act(async () => {
      await two.result.current.write("a", async () => {
        throw err("unauthorized", 401, "no")
      })
    })
    expect(session.invalidated).toEqual([hqKeys.status()])
  })

  it("never sends again by itself: one send per write call, whatever happens", async () => {
    const { queryClient } = clientWith()
    const view = renderHook(() => useOneWrite({ queryClient }))
    const send = vi.fn(async () => {
      throw err("server", 500, "boom")
    })
    await act(async () => {
      await view.result.current.write("a", send)
    })
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe("writeMessage", () => {
  it("restores the hint of a pull request that moved on", () => {
    expect(writeMessage(err("conflict", 409, "The pull request changed since you looked"))).toBe(
      "The pull request changed since you looked. Review it again.",
    )
  })

  it("keeps hq's own words for another 409, a 403 and a 400", () => {
    expect(writeMessage(err("conflict", 409, "This merge is already approved."))).toBe(
      "This merge is already approved.",
    )
    expect(writeMessage(err("forbidden", 403, "Only a founder."))).toBe("Only a founder.")
    expect(writeMessage(err("bad-request", 400, "note must not be empty"))).toBe(
      "note must not be empty",
    )
  })

  it("words every other error through the one table", () => {
    expect(writeMessage(err("unreachable", 0, "x"))).toBe(
      "Could not reach the server. Check your connection, then retry.",
    )
    expect(writeMessage(new Error("x"))).toBe(
      "hq had a problem. hq answered with a server error. Retry in a moment.",
    )
  })
})
