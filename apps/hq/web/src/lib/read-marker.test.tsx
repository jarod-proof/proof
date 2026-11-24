// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { READ_MARKER_KEY, useReadMarker } from "./read-marker"

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe("useReadMarker", () => {
  it("starts empty, and markRead stores the time under hq.digest.readAt", () => {
    const { result } = renderHook(() => useReadMarker())
    expect(READ_MARKER_KEY).toBe("hq.digest.readAt")
    expect(result.current.readAt).toBeNull()
    act(() => result.current.markRead("2026-11-17T12:00:00.000Z"))
    expect(result.current.readAt).toBe("2026-11-17T12:00:00.000Z")
    expect(window.localStorage.getItem("hq.digest.readAt")).toBe("2026-11-17T12:00:00.000Z")
  })

  it("markRead with no time marks now", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-20T08:00:00.000Z"))
    const { result } = renderHook(() => useReadMarker())
    act(() => result.current.markRead())
    expect(result.current.readAt).toBe("2026-11-20T08:00:00.000Z")
    vi.useRealTimers()
  })

  it("reads a stored time on mount", () => {
    window.localStorage.setItem(READ_MARKER_KEY, "2026-11-16T10:00:00.000Z")
    const { result } = renderHook(() => useReadMarker())
    expect(result.current.readAt).toBe("2026-11-16T10:00:00.000Z")
  })

  it("ignores a stored value that is not an ISO time", () => {
    window.localStorage.setItem(READ_MARKER_KEY, "yesterday-ish")
    const { result } = renderHook(() => useReadMarker())
    expect(result.current.readAt).toBeNull()
  })

  it("with localStorage throwing, nothing crashes and the marker still holds for the page", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    const { result } = renderHook(() => useReadMarker())
    expect(result.current.readAt).toBeNull()
    act(() => result.current.markRead("2026-11-17T12:00:00.000Z"))
    expect(result.current.readAt).toBe("2026-11-17T12:00:00.000Z")
  })

  it("clear forgets the marker in state and storage, even with storage throwing", () => {
    const { result } = renderHook(() => useReadMarker())
    act(() => result.current.markRead("2026-11-17T12:00:00.000Z"))
    act(() => result.current.clear())
    expect(result.current.readAt).toBeNull()
    expect(window.localStorage.getItem(READ_MARKER_KEY)).toBeNull()

    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    act(() => result.current.markRead("2026-11-17T12:00:00.000Z"))
    act(() => result.current.clear())
    expect(result.current.readAt).toBeNull()
  })
})
