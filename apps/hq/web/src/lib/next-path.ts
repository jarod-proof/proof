const DEFAULT_NEXT = "/digest"
// A path inside the app: one leading slash (never `//host`), and no whitespace, backslash or colon
// (`/\evil`, `/https://evil` and `javascript:` all fail). `?` and `#` may follow.
const INSIDE_THE_APP = /^\/(?!\/)[^\s\\:]*$/

/** `.` or `..`, raw or percent-encoded: the history API would resolve it out of /app. */
function isDotSegment(segment: string): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    return true
  }
  return decoded === "." || decoded === ".."
}

/**
 * Where to go after sign-in: `next` when it is a path inside the app, else the Digest. The plan's
 * pattern lets `/../admin` through (the browser resolves `/app/../admin` to `/admin`, outside the
 * app), so a `.` or `..` segment in the path part (before `?` or `#`) is refused too.
 */
export function safeNext(next: string | undefined): string {
  if (typeof next !== "string" || !INSIDE_THE_APP.test(next)) return DEFAULT_NEXT
  const path = next.split(/[?#]/, 1)[0] ?? ""
  return path.split("/").some(isDotSegment) ? DEFAULT_NEXT : next
}
