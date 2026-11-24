import { useCallback, useState } from "react"

/** The one localStorage key of the digest's read marker (this browser only, never sent to hq). */
export const READ_MARKER_KEY = "hq.digest.readAt"

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

function isIsoTime(value: string): boolean {
  return ISO.test(value) && !Number.isNaN(Date.parse(value))
}

// Storage can be missing, blocked or full (private windows, cleared site data): every access is
// guarded, and the page works without it.
function load(): string | null {
  try {
    const value = window.localStorage.getItem(READ_MARKER_KEY)
    return value !== null && isIsoTime(value) ? value : null
  } catch {
    return null
  }
}

function save(value: string): void {
  try {
    window.localStorage.setItem(READ_MARKER_KEY, value)
  } catch {
    // Not remembered; the marker still holds until the page is closed.
  }
}

function remove(): void {
  try {
    window.localStorage.removeItem(READ_MARKER_KEY)
  } catch {
    // Nothing to forget, or storage is blocked.
  }
}

/**
 * The digest's "read up to here" time, remembered in this browser only. It is used only as the
 * `since` of the next get_digest call. `markRead(at)` takes hq's own clock (the digest's `until`)
 * so a skewed browser clock can never ask for a window in hq's future; with no argument it marks
 * the browser's now. `clear()` forgets the marker (the default window again).
 */
export function useReadMarker(): {
  readAt: string | null
  markRead(at?: string): void
  clear(): void
} {
  const [readAt, setReadAt] = useState<string | null>(load)
  const markRead = useCallback((at?: string) => {
    const value = at !== undefined && isIsoTime(at) ? at : new Date().toISOString()
    save(value)
    setReadAt(value)
  }, [])
  const clear = useCallback(() => {
    remove()
    setReadAt(null)
  }, [])
  return { readAt, markRead, clear }
}
