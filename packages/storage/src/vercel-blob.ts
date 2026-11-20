import { AppError } from "@proof/errors"

import {
  assertFileKey,
  assertFilesPrefix,
  assertNextPage,
  type FileStore,
  keyUnder,
  sweepable,
} from "./store"

export interface VercelBlobConfig {
  driver: "vercel-blob"
  /** The store's read-write token (`vercel_blob_rw_<storeId>_...`), BLOB_READ_WRITE_TOKEN. */
  token: string
}

type BlobSdk = Pick<typeof import("@vercel/blob"), "put" | "del" | "list">

/** The store id inside a read-write token, which names the store's public host. */
function storeIdOf(token: string): string {
  const [vercel, blob, rw, storeId] = token.split("_")
  if (vercel !== "vercel" || blob !== "blob" || rw !== "rw" || !storeId) {
    throw new Error("BLOB_READ_WRITE_TOKEN is not a Vercel Blob read-write token")
  }
  return storeId.toLowerCase()
}

/**
 * Vercel Blob, through `@vercel/blob`. The SDK is imported on first use, so deployments on another
 * store never load it. `sdk` is for tests.
 */
export function createVercelBlobStore(config: VercelBlobConfig, sdk?: BlobSdk): FileStore {
  const publicUrl = `https://${storeIdOf(config.token)}.public.blob.vercel-storage.com`
  let loaded: Promise<BlobSdk> | undefined
  const blob = () => {
    loaded ??= sdk ? Promise.resolve(sdk) : import("@vercel/blob")
    return loaded
  }
  /** The key behind one of this store's URLs, else null. */
  const keyOf = (url: string) => {
    // The host may come back in another case than the token's store id: `new URL` lowercases it.
    try {
      return keyUnder(publicUrl, new URL(url).href)
    } catch {
      return null
    }
  }
  const failed = (method: string, error: unknown) =>
    new AppError("INTERNAL", `The file store refused a ${method}`, {
      cause: error,
      context: { driver: "vercel-blob" },
    })

  return {
    driver: "vercel-blob",
    origin: publicUrl,
    async put(key, body, contentType) {
      assertFileKey(key)
      const { put } = await blob()
      try {
        const stored = await put(key, Buffer.from(body), {
          access: "public",
          contentType,
          token: config.token,
          // The key is already random and new per upload (newFileKey).
          addRandomSuffix: false,
          cacheControlMaxAge: 31_536_000,
        })
        return stored.url
      } catch (error) {
        throw failed("PUT", error)
      }
    },
    async delete(url) {
      if (keyOf(url) === null) return false
      const { del } = await blob()
      try {
        await del(url, { token: config.token })
      } catch (error) {
        throw failed("DELETE", error)
      }
      return true
    },
    async deletePrefix(prefix) {
      assertFilesPrefix(prefix)
      const { list, del } = await blob()
      let deleted = 0
      let skipped = 0
      let cursor: string | undefined
      // A cursor that repeats, or pages that never end, can't hold the deletion open.
      const seen = new Set<string>()
      try {
        do {
          if (cursor !== undefined) assertNextPage(seen, cursor, "vercel-blob")
          const page = await list({ prefix, cursor, token: config.token })
          // The listing is not trusted blindly: only this store's URLs whose key is a plain file key
          // under the prefix are deleted (the URL is what `del` removes, so it is what is checked).
          const mine = page.blobs.filter((b) => {
            const key = keyOf(b.url)
            return key !== null && sweepable(key, prefix)
          })
          skipped += page.blobs.length - mine.length
          if (mine.length > 0) {
            await del(
              mine.map((b) => b.url),
              { token: config.token },
            )
            deleted += mine.length
          }
          cursor = page.hasMore ? page.cursor : undefined
        } while (cursor !== undefined)
      } catch (error) {
        throw failed("DELETE", error)
      }
      return { deleted, skipped }
    },
  }
}
