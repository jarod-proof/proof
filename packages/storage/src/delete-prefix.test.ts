import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it, vi } from "vitest"

import {
  createFileStore,
  createLocalStore,
  createMemoryStore,
  createS3Store,
  createVercelBlobStore,
  type FileStore,
  organizationFilesPrefix,
  personFilesPrefix,
} from "./index"
import { dirUnder } from "./local"
import { parseListPage, unescapeXml } from "./s3"
import { MAX_LIST_PAGES } from "./store"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const BAD_PREFIXES = [
  "",
  "org/abc",
  "../",
  "/",
  "org//",
  "org/../",
  "org/a/b/",
  "team/abc/",
  "org/a b/",
]

describe("prefix helpers", () => {
  it("name an organization's and a person's directory", () => {
    expect(organizationFilesPrefix("o1")).toBe("org/o1/")
    expect(personFilesPrefix("u1")).toBe("user/u1/")
  })
})

describe("memory deletePrefix", () => {
  it("removes only the keys under the prefix", async () => {
    const store = createMemoryStore({ driver: "memory", publicUrl: "http://test/files" })
    await store.put("org/ab/logo-1.png", PNG, "image/png")
    await store.put("org/ab/logo-2.png", PNG, "image/png")
    await store.put("org/abc/logo-1.png", PNG, "image/png")
    await store.put("user/ab/avatar-1.png", PNG, "image/png")
    expect(await store.deletePrefix("org/ab/")).toEqual({ deleted: 2, skipped: 0 })
    expect([...store.files.keys()].sort()).toEqual(["org/abc/logo-1.png", "user/ab/avatar-1.png"])
    expect(await store.deletePrefix("org/ab/")).toEqual({ deleted: 0, skipped: 0 })
  })

  it("refuses a prefix that is not one organization's or person's directory", async () => {
    const store = createMemoryStore({ driver: "memory", publicUrl: "http://test/files" })
    await store.put("org/ab/logo-1.png", PNG, "image/png")
    for (const bad of BAD_PREFIXES) {
      await expect(store.deletePrefix(bad), bad).rejects.toThrow(/Not a files prefix/)
    }
    expect(store.files.size).toBe(1)
  })
})

describe("local deletePrefix", () => {
  const dirs: string[] = []
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  })
  const tempDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), "proof-sweep-"))
    dirs.push(dir)
    return dir
  }

  it("removes the directory and counts its files, leaving its neighbours", async () => {
    const dir = await tempDir()
    const store = createLocalStore({ driver: "local", dir, publicUrl: "http://localhost/files" })
    await store.put("org/ab/logo-1.png", PNG, "image/png")
    await store.put("org/ab/logo-2.png", PNG, "image/png")
    await store.put("org/abc/logo-1.png", PNG, "image/png")
    expect(await store.deletePrefix("org/ab/")).toEqual({ deleted: 2, skipped: 0 })
    expect(await readdir(join(dir, "org"))).toEqual(["abc"])
    expect(await store.read?.("org/abc/logo-1.png")).not.toBeNull()
  })

  it("counts a missing directory as nothing to delete", async () => {
    const dir = await tempDir()
    const store = createLocalStore({ driver: "local", dir, publicUrl: "http://localhost/files" })
    expect(await store.deletePrefix("user/nobody/")).toEqual({ deleted: 0, skipped: 0 })
  })

  it("refuses a bad prefix before touching the disk", async () => {
    const dir = await tempDir()
    await mkdir(join(dir, "org"), { recursive: true })
    await writeFile(join(dir, "org", "keep.png"), PNG)
    const store = createLocalStore({ driver: "local", dir, publicUrl: "http://localhost/files" })
    for (const bad of BAD_PREFIXES) {
      await expect(store.deletePrefix(bad), bad).rejects.toThrow(/Not a files prefix/)
    }
    expect(await readdir(join(dir, "org"))).toEqual(["keep.png"])
  })

  it("refuses a path that resolves outside its directory", () => {
    expect(dirUnder("/srv/files", "org/ab/")).toBe("/srv/files/org/ab")
    expect(() => dirUnder("/srv/files", "../etc/")).toThrow(/Outside the store/)
    expect(() => dirUnder("/srv/files", "/etc/")).toThrow(/Outside the store/)
    expect(() => dirUnder("/srv/files", "./")).toThrow(/Outside the store/)
  })
})

describe("the S3 list parser", () => {
  it("reads one page", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>uploads</Name><Prefix>org/o1/</Prefix><KeyCount>2</KeyCount><MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>
  <Contents><Key>org/o1/logo-a.png</Key><Size>4</Size></Contents>
  <Contents><Key>org/o1/logo-b.png</Key><Size>4</Size></Contents>
</ListBucketResult>`
    expect(parseListPage(xml)).toEqual({
      keys: ["org/o1/logo-a.png", "org/o1/logo-b.png"],
      truncated: false,
    })
  })

  it("reads a truncated page and its continuation token", () => {
    const xml =
      "<ListBucketResult><IsTruncated>true</IsTruncated>" +
      "<NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=+a</NextContinuationToken>" +
      "<Contents><Key>org/o1/logo-a.png</Key></Contents></ListBucketResult>"
    expect(parseListPage(xml)).toEqual({
      keys: ["org/o1/logo-a.png"],
      truncated: true,
      next: "1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=+a",
    })
  })

  it("unescapes named and numeric entities", () => {
    const xml =
      "<ListBucketResult><IsTruncated>false</IsTruncated>" +
      "<Contents><Key>org/o1/a&amp;b&#13;c&#x2F;d.png</Key></Contents></ListBucketResult>"
    expect(parseListPage(xml).keys).toEqual(["org/o1/a&b\rc/d.png"])
    expect(unescapeXml("&lt;&gt;&quot;&apos;&amp;amp;&unknown;")).toBe("<>\"'&amp;&unknown;")
  })

  it("leaves a numeric reference past the last code point as text", () => {
    expect(unescapeXml("a&#x110000;b&#99999999999;c&#x10FFFF;")).toBe(
      "a&#x110000;b&#99999999999;c\u{10FFFF}",
    )
    const xml =
      "<ListBucketResult><IsTruncated>false</IsTruncated>" +
      "<Contents><Key>org/o1/a&#x110000;.png</Key></Contents></ListBucketResult>"
    expect(parseListPage(xml).keys).toEqual(["org/o1/a&#x110000;.png"])
  })
})

/** A fake S3: answers list requests with the pages given, in order, and records every request. */
function fakeS3(pages: string[]) {
  const requests: Request[] = []
  const queue = [...pages]
  const fetch: typeof globalThis.fetch = async (request) => {
    const req = request as Request
    requests.push(req)
    if (req.method === "GET") return new Response(queue.shift() ?? "", { status: 200 })
    return new Response(null, { status: 204 })
  }
  return { fetch, requests }
}

const page = (keys: string[], next?: string) =>
  "<ListBucketResult>" +
  `<IsTruncated>${next ? "true" : "false"}</IsTruncated>` +
  (next ? `<NextContinuationToken>${next}</NextContinuationToken>` : "") +
  keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("") +
  "</ListBucketResult>"

describe("s3 deletePrefix", () => {
  const base = {
    driver: "s3",
    bucket: "uploads",
    region: "eu-west-1",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "secret", // gitleaks:allow
  } as const
  const TOKEN = "abc+def/ghi=="

  it("lists every page, then deletes each listed key under the prefix", async () => {
    const { fetch, requests } = fakeS3([
      page(["org/o1/logo-a.png", "org/o2/logo-x.png"], TOKEN),
      page(["org/o1/logo-b.png", "org/o1/../../user/u1/avatar-1.png"]),
    ])
    const store = createS3Store({ ...base, fetch })
    expect(await store.deletePrefix("org/o1/")).toEqual({ deleted: 2, skipped: 2 })
    expect(requests.map((r) => r.method)).toEqual(["GET", "GET", "DELETE", "DELETE"])

    const [first, second] = requests.map((r) => new URL(r.url))
    expect(`${first?.origin}${first?.pathname}`).toBe("https://uploads.s3.eu-west-1.amazonaws.com/")
    expect(Object.fromEntries(first?.searchParams ?? [])).toEqual({
      "list-type": "2",
      prefix: "org/o1/",
    })
    expect(second?.searchParams.get("continuation-token")).toBe(TOKEN)
    expect(requests[0]?.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /)

    // The listed key outside the prefix, and the one that climbs out of it, are never deleted.
    expect(requests.slice(2).map((r) => r.url)).toEqual([
      "https://uploads.s3.eu-west-1.amazonaws.com/org/o1/logo-a.png",
      "https://uploads.s3.eu-west-1.amazonaws.com/org/o1/logo-b.png",
    ])
  })

  it("lists path-style against a custom endpoint", async () => {
    const { fetch, requests } = fakeS3([page([])])
    const store = createS3Store({ ...base, endpoint: "http://localhost:9000/", fetch })
    expect(await store.deletePrefix("user/u1/")).toEqual({ deleted: 0, skipped: 0 })
    expect(requests).toHaveLength(1)
    const url = new URL(requests[0]?.url ?? "")
    expect(`${url.origin}${url.pathname}`).toBe("http://localhost:9000/uploads")
    expect(url.searchParams.get("prefix")).toBe("user/u1/")
    expect(url.searchParams.get("list-type")).toBe("2")
  })

  it("lists R2 at the account endpoint", async () => {
    const { fetch, requests } = fakeS3([page(["user/u1/avatar-a.webp"])])
    const store = createFileStore({
      driver: "r2",
      accountId: "acc123",
      bucket: "uploads",
      accessKeyId: "AKID",
      secretAccessKey: "secret", // gitleaks:allow
      publicUrl: "https://pub-xyz.r2.dev",
      fetch,
    })
    expect(await store.deletePrefix("user/u1/")).toEqual({ deleted: 1, skipped: 0 })
    const url = new URL(requests[0]?.url ?? "")
    expect(`${url.origin}${url.pathname}`).toBe("https://acc123.r2.cloudflarestorage.com/uploads")
    expect(url.searchParams.get("prefix")).toBe("user/u1/")
    expect(requests[0]?.headers.get("authorization")).toMatch(/\/auto\/s3\/aws4_request/)
    expect(requests[1]?.url).toBe(
      "https://acc123.r2.cloudflarestorage.com/uploads/user/u1/avatar-a.webp",
    )
  })

  it("stops on a continuation token it has already followed, deleting nothing", async () => {
    const { fetch, requests } = fakeS3([
      page(["org/o1/logo-a.png"], "again"),
      page(["org/o1/logo-b.png"], "again"),
      page(["org/o1/logo-c.png"], "again"),
    ])
    const store = createS3Store({ ...base, fetch })
    await expect(store.deletePrefix("org/o1/")).rejects.toMatchObject({
      code: "INTERNAL",
      context: { driver: "s3", repeated: true },
    })
    expect(requests.map((r) => r.method)).toEqual(["GET", "GET"])
  })

  it("turns a refused listing (a missing s3:ListBucket) into an INTERNAL error", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 })
    const store = createS3Store({ ...base, fetch })
    await expect(store.deletePrefix("org/o1/")).rejects.toMatchObject({
      code: "INTERNAL",
      context: { status: 403 },
    })
    const missing: typeof globalThis.fetch = async () => new Response("", { status: 404 })
    await expect(
      createS3Store({ ...base, fetch: missing }).deletePrefix("org/o1/"),
    ).rejects.toThrow(/refused a GET/)
  })
})

describe("vercel blob deletePrefix", () => {
  const token = "vercel_blob_rw_AbC123_secretpart" // gitleaks:allow
  const host = "https://abc123.public.blob.vercel-storage.com"
  const blob = (pathname: string, url = `${host}/${pathname}`) => ({ pathname, url })

  it("pages through the listing and deletes only this store's blobs under the prefix", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        blobs: [blob("org/o1/logo-a.png"), blob("org/o2/logo-x.png")],
        hasMore: true,
        cursor: "c1",
      })
      .mockResolvedValueOnce({ blobs: [], hasMore: true, cursor: "c2" })
      .mockResolvedValueOnce({
        blobs: [
          blob("org/o1/logo-b.png"),
          // Claims the prefix, but its URL is another blob's.
          blob("org/o1/logo-c.png", `${host}/user/u1/avatar-1.png`),
        ],
        hasMore: false,
      })
    const del = vi.fn(async () => undefined)
    const store = createVercelBlobStore({ driver: "vercel-blob", token }, {
      put: vi.fn(),
      del,
      list,
    } as never)
    expect(await store.deletePrefix("org/o1/")).toEqual({ deleted: 2, skipped: 2 })
    expect(list.mock.calls.map(([options]) => options)).toEqual([
      { prefix: "org/o1/", cursor: undefined, token },
      { prefix: "org/o1/", cursor: "c1", token },
      { prefix: "org/o1/", cursor: "c2", token },
    ])
    // The empty page deletes nothing.
    expect(del.mock.calls).toEqual([
      [[`${host}/org/o1/logo-a.png`], { token }],
      [[`${host}/org/o1/logo-b.png`], { token }],
    ])
  })

  it("stops on a repeated cursor, and after MAX_LIST_PAGES pages", async () => {
    const del = vi.fn(async () => undefined)
    const repeating = vi.fn(async () => ({ blobs: [], hasMore: true, cursor: "same" }))
    const looping = createVercelBlobStore({ driver: "vercel-blob", token }, {
      put: vi.fn(),
      del,
      list: repeating,
    } as never)
    await expect(looping.deletePrefix("org/o1/")).rejects.toMatchObject({
      code: "INTERNAL",
      cause: { context: { repeated: true } },
    })
    expect(repeating).toHaveBeenCalledTimes(2)

    let n = 0
    const endless = vi.fn(async () => ({ blobs: [], hasMore: true, cursor: `c${++n}` }))
    const store = createVercelBlobStore({ driver: "vercel-blob", token }, {
      put: vi.fn(),
      del,
      list: endless,
    } as never)
    await expect(store.deletePrefix("org/o1/")).rejects.toMatchObject({
      code: "INTERNAL",
      cause: { context: { page: MAX_LIST_PAGES + 1, repeated: false } },
    })
    expect(endless).toHaveBeenCalledTimes(MAX_LIST_PAGES)
    expect(del).not.toHaveBeenCalled()
  })

  it("wraps a failed listing", async () => {
    const list = vi.fn(async () => {
      throw new Error("BlobAccessError")
    })
    const store = createVercelBlobStore({ driver: "vercel-blob", token }, {
      put: vi.fn(),
      del: vi.fn(),
      list,
    } as never)
    await expect(store.deletePrefix("org/o1/")).rejects.toMatchObject({ code: "INTERNAL" })
  })
})

describe("every driver", () => {
  it("refuses a bad prefix before any network call or file-system access", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const blob = { put: vi.fn(), del: vi.fn(), list: vi.fn() }
    const dir = join(tmpdir(), "proof-sweep-never-created")
    const stores: FileStore[] = [
      createS3Store({
        driver: "s3",
        bucket: "b",
        region: "r",
        accessKeyId: "a",
        secretAccessKey: "s", // gitleaks:allow
        fetch,
      }),
      createVercelBlobStore(
        { driver: "vercel-blob", token: "vercel_blob_rw_x_y" }, // gitleaks:allow
        blob as never,
      ),
      createLocalStore({ driver: "local", dir, publicUrl: "http://localhost/files" }),
      createMemoryStore({ driver: "memory", publicUrl: "http://test/files" }),
    ]
    for (const store of stores) {
      for (const bad of BAD_PREFIXES) {
        await expect(store.deletePrefix(bad), `${store.driver} ${bad}`).rejects.toThrow(
          /Not a files prefix/,
        )
      }
    }
    expect(fetch).not.toHaveBeenCalled()
    expect(blob.list).not.toHaveBeenCalled()
    expect(blob.del).not.toHaveBeenCalled()
    await expect(readdir(dir)).rejects.toMatchObject({ code: "ENOENT" })
  })
})
