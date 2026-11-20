import { AppError } from "@proof/errors"

/** Which file store holds uploads. `memory` is for tests. */
export type StorageDriver = "local" | "s3" | "r2" | "vercel-blob" | "memory"

/**
 * Where uploaded files live. Files are public: the URL `put` returns is what an `<img>` loads, so a
 * key must be unguessable (`newFileKey`) and must never hold anything private.
 */
export interface FileStore {
  readonly driver: StorageDriver
  /** The origin the files are served from. The web app's CSP lists it under `img-src`. */
  readonly origin: string
  /** Stores the bytes under `key`, publicly readable, and returns the URL they are served at. */
  put(key: string, body: Uint8Array<ArrayBuffer>, contentType: string): Promise<string>
  /**
   * Removes the file behind `url`. A URL this store did not issue (a GitHub avatar from social
   * sign-in, another store's file) is left alone, and the answer is false.
   */
  delete(url: string): Promise<boolean>
  /**
   * Removes every file under `prefix` (`organizationFilesPrefix`, `personFilesPrefix`), including
   * ones no row points at. Refuses any other prefix before touching the store. A listed key that is
   * not under the prefix or not a file key is left alone and counted in `skipped`.
   */
  deletePrefix(prefix: string): Promise<PrefixDeletion>
  /** Only on stores the API serves itself (`local`, `memory`): the file at `key`, or null. */
  read?(key: string): Promise<StoredFile | null>
}

/** What `deletePrefix` did: files removed, and listed keys it refused to remove. */
export interface PrefixDeletion {
  deleted: number
  skipped: number
}

export interface StoredFile {
  body: Uint8Array<ArrayBuffer>
  contentType: string
}

/** Keys are path segments of letters, digits, `-` and `_`, then one extension: no `..`, no `//`. */
const KEY = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.[a-z0-9]+$/

export function isFileKey(key: string): boolean {
  return KEY.test(key)
}

export function assertFileKey(key: string): void {
  if (!isFileKey(key)) throw new Error(`Not a file key: ${JSON.stringify(key)}`)
}

/**
 * Where an organization's files live: every key for it (its logo) starts with this. Uploads build
 * their keys on it and the sweep on deletion removes everything under it, so the two can't drift.
 */
export const organizationFilesPrefix = (organizationId: string) => `org/${organizationId}/`

/** Where a person's files live (their avatar). See `organizationFilesPrefix`. */
export const personFilesPrefix = (userId: string) => `user/${userId}/`

/** A prefix `deletePrefix` accepts: one organization's or person's directory, slash included. */
const FILES_PREFIX = /^(org|user)\/[A-Za-z0-9_-]+\/$/

/**
 * Throws unless `prefix` is exactly one organization's or person's directory. The trailing slash
 * keeps `org/ab/` from matching `org/abc/`. A bad prefix is a programming error.
 */
export function assertFilesPrefix(prefix: string): void {
  if (!FILES_PREFIX.test(prefix)) throw new Error(`Not a files prefix: ${JSON.stringify(prefix)}`)
}

/**
 * The most listing pages a sweep reads (1,000 keys or blobs a page). An organization or person has
 * a file or two, so reaching it means the listing is wrong, not that the prefix is that big.
 */
export const MAX_LIST_PAGES = 1000

/**
 * Throws when a listing would page forever: a cursor it has already followed, or more pages than
 * `MAX_LIST_PAGES`. `seen` holds the cursors followed so far; the new one is added.
 */
export function assertNextPage(seen: Set<string>, cursor: string, driver: StorageDriver): void {
  // The page this cursor asks for: the first page took none.
  const page = seen.size + 2
  if (seen.has(cursor) || page > MAX_LIST_PAGES) {
    throw new AppError("INTERNAL", "The file store's listing does not end", {
      context: { driver, page, repeated: seen.has(cursor) },
    })
  }
  seen.add(cursor)
}

/** Whether a key a store listed may be removed by a sweep of `prefix`: under it, and a file key. */
export const sweepable = (key: string, prefix: string) => key.startsWith(prefix) && isFileKey(key)

/** The key behind `url` when it is one of `base`'s files, else null. */
export function keyUnder(base: string, url: string): string | null {
  const prefix = `${base.replace(/\/+$/, "")}/`
  if (!url.startsWith(prefix)) return null
  let key: string
  try {
    key = decodeURIComponent(url.slice(prefix.length))
  } catch {
    return null
  }
  return isFileKey(key) ? key : null
}

/** `key` as a URL path, each segment encoded. */
export const encodeKey = (key: string) => key.split("/").map(encodeURIComponent).join("/")

/** Content types by the extensions `newFileKey` gives, for stores that serve files themselves. */
const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
}

export const EXTENSIONS: Record<string, string> = Object.fromEntries(
  Object.entries(TYPES).map(([ext, type]) => [type, ext]),
)

export function contentTypeOfKey(key: string): string {
  return TYPES[key.slice(key.lastIndexOf(".") + 1)] ?? "application/octet-stream"
}

/**
 * A fresh key under `prefix` (e.g. `org/<id>/logo`) for a file of `contentType`. The random part
 * makes the URL unguessable and new on every upload, so files can be cached forever.
 */
export function newFileKey(prefix: string, contentType: string): string {
  const ext = EXTENSIONS[contentType]
  if (!ext) throw new Error(`No extension for ${contentType}`)
  const random = crypto.randomUUID().replaceAll("-", "")
  const key = `${prefix}-${random}.${ext}`
  assertFileKey(key)
  return key
}

/** Cache headers for a stored file: a key is never reused, so it never changes. */
export const IMMUTABLE = "public, max-age=31536000, immutable"
