import { AppError } from "@proof/errors"
import { AwsClient } from "aws4fetch"

import {
  assertFileKey,
  assertFilesPrefix,
  assertNextPage,
  encodeKey,
  type FileStore,
  IMMUTABLE,
  keyUnder,
  sweepable,
} from "./store"

export interface S3Config {
  driver: "s3"
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** Temporary credentials (an assumed role) carry one. */
  sessionToken?: string
  /**
   * An S3-compatible endpoint (MinIO, LocalStack), addressed path-style as `<endpoint>/<bucket>`.
   * Unset, AWS itself: `https://<bucket>.s3.<region>.amazonaws.com`.
   */
  endpoint?: string
  /** Where the files are read from (a CloudFront or custom domain). Unset, the bucket's own URL. */
  publicUrl?: string
  /** Tests pass one. */
  fetch?: typeof fetch
}

export interface R2Config {
  driver: "r2"
  /** The Cloudflare account id: R2's endpoint is `https://<accountId>.r2.cloudflarestorage.com`. */
  accountId: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /**
   * The bucket's public URL: its r2.dev address or a custom domain. Required: public access is
   * only through those, not the signed S3 endpoint.
   */
  publicUrl: string
  fetch?: typeof fetch
}

const trim = (url: string) => url.replace(/\/+$/, "")

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

/** XML text with its five named entities and numeric references (`&#13;`, `&#x2F;`) unescaped. */
export function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (entity, name: string) => {
    if (!name.startsWith("#")) return ENTITIES[name] ?? entity
    const code = name.startsWith("#x") ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1))
    // Past the last code point, fromCodePoint throws: such a reference is left as text, and the key
    // that holds it fails isFileKey, so it is skipped rather than aborting the sweep.
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity
  })
}

/** One page of a ListObjectsV2 answer. */
export interface ListPage {
  keys: string[]
  truncated: boolean
  /** The `continuation-token` for the next page, when `truncated`. */
  next?: string
}

/**
 * Reads the keys and the paging fields of a ListObjectsV2 answer. S3 names `<Key>` only inside
 * `<Contents>`, so a flat scan is enough and no XML dependency is needed.
 */
export function parseListPage(xml: string): ListPage {
  const values = (tag: string) =>
    Array.from(xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g")), (m) =>
      unescapeXml(m[1] ?? ""),
    )
  const [next] = values("NextContinuationToken")
  return {
    keys: values("Key"),
    truncated: values("IsTruncated")[0] === "true",
    ...(next !== undefined && { next }),
  }
}

/** S3, and anything that speaks its API: R2 is the same driver with Cloudflare's endpoint. */
export function createS3Store(config: S3Config | R2Config): FileStore {
  const r2 = config.driver === "r2"
  const region = r2 ? "auto" : config.region
  const bucketUrl = r2
    ? `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}`
    : config.endpoint
      ? `${trim(config.endpoint)}/${config.bucket}`
      : `https://${config.bucket}.s3.${config.region}.amazonaws.com`
  const publicUrl = trim(config.publicUrl ?? bucketUrl)
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    sessionToken: r2 ? undefined : config.sessionToken,
    service: "s3",
    region,
  })
  const send = config.fetch ?? fetch

  const refused = async (method: string, res: Response) =>
    new AppError("INTERNAL", `The file store refused a ${method}`, {
      context: {
        driver: config.driver,
        status: res.status,
        body: (await res.text()).slice(0, 500),
      },
    })

  async function call(method: "PUT" | "DELETE", key: string, init: RequestInit = {}) {
    const request = await client.sign(`${bucketUrl}/${encodeKey(key)}`, { method, ...init })
    const res = await send(request)
    // A DELETE that finds the key already gone (404) counts as done.
    if (res.ok || (method === "DELETE" && res.status === 404)) return
    throw await refused(method, res)
  }

  /**
   * One ListObjectsV2 page of the keys under `prefix`. The query goes through searchParams: a
   * continuation token holds `+`, `/` and `=`. Every refusal throws, a 404 included (no bucket).
   */
  async function listPage(prefix: string, token?: string): Promise<ListPage> {
    const url = new URL(bucketUrl)
    url.searchParams.set("list-type", "2")
    url.searchParams.set("prefix", prefix)
    if (token !== undefined) url.searchParams.set("continuation-token", token)
    const res = await send(await client.sign(url.href, { method: "GET" }))
    if (!res.ok) throw await refused("GET", res)
    return parseListPage(await res.text())
  }

  return {
    driver: config.driver,
    origin: new URL(publicUrl).origin,
    async put(key, body, contentType) {
      assertFileKey(key)
      await call("PUT", key, {
        body,
        headers: {
          "content-type": contentType,
          "content-length": String(body.byteLength),
          "cache-control": IMMUTABLE,
        },
      })
      return `${publicUrl}/${encodeKey(key)}`
    },
    async delete(url) {
      const key = keyUnder(publicUrl, url)
      if (key === null) return false
      await call("DELETE", key)
      return true
    },
    async deletePrefix(prefix) {
      assertFilesPrefix(prefix)
      const keys: string[] = []
      // A server that repeats its token, or never stops paging, can't hold the deletion open.
      const seen = new Set<string>()
      let token: string | undefined
      do {
        if (token !== undefined) assertNextPage(seen, token, config.driver)
        const page = await listPage(prefix, token)
        keys.push(...page.keys)
        token = page.truncated ? page.next : undefined
      } while (token !== undefined)
      // The listing comes from whatever S3_ENDPOINT points at: only keys under the prefix that are
      // plain file keys (no `..`, which a URL would resolve elsewhere) are deleted.
      const mine = keys.filter((key) => sweepable(key, prefix))
      // One DELETE each: DeleteObjects needs a Content-MD5 header, and a person has a file or two.
      for (const key of mine) await call("DELETE", key)
      return { deleted: mine.length, skipped: keys.length - mine.length }
    },
  }
}
