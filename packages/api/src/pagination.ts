import { AppError } from "@proof/errors"
import { z } from "zod"

/**
 * Query input for a paginated list: `?cursor=...&limit=20`. Use `z.coerce` (query values arrive as
 * strings); `limit` defaults to 50 and is capped at 100.
 */
export const paginationInput = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

/** Output for a paginated list: the items under `key`, and the cursor for the next page (null at the end). */
export function paginated<K extends string, T extends z.ZodType>(key: K, item: T) {
  // A computed key widens to a string index; `key` is exactly K.
  const items = { [key]: z.array(item) } as { [P in K]: z.ZodArray<T> }
  return z.object({ ...items, nextCursor: z.string().nullable() })
}

const toBase64Url = (text: string) =>
  btoa(Array.from(new TextEncoder().encode(text), (b) => String.fromCharCode(b)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

const fromBase64Url = (text: string) => {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/")
  const bytes = Uint8Array.from(atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "=")), (c) =>
    c.charCodeAt(0),
  )
  return new TextDecoder().decode(bytes)
}

/** An opaque cursor for the position after `value` (base64url JSON). Clients must not parse it. */
export function encodeCursor(value: Record<string, string | number>): string {
  return toBase64Url(JSON.stringify(value))
}

/**
 * Read a cursor made by `encodeCursor`. Anything else is BAD_REQUEST with a hint on how to recover.
 */
export function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(fromBase64Url(cursor))
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    // fall through to the same error as a well-formed but non-object cursor
  }
  throw new AppError("BAD_REQUEST", "Invalid cursor", {
    hint: "Pass nextCursor from the previous page unchanged, or omit cursor to start from the first page.",
  })
}
