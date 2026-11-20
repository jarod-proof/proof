import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AppError } from "@proof/errors"
import { afterAll, describe, expect, it, vi } from "vitest"

import {
  contentTypeOfKey,
  createFileStore,
  createVercelBlobStore,
  decodeImage,
  imageTypeOf,
  isFileKey,
  MAX_IMAGE_BYTES,
  newFileKey,
} from "./index"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const png64 = Buffer.from(PNG).toString("base64")

describe("images", () => {
  it("reads the type from the bytes", () => {
    expect(imageTypeOf(PNG)).toBe("image/png")
    expect(imageTypeOf(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg")
    expect(imageTypeOf(new TextEncoder().encode("GIF89a..."))).toBe("image/gif")
    expect(imageTypeOf(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp")
    expect(imageTypeOf(new TextEncoder().encode("<svg xmlns="))).toBeNull()
  })

  it("decodes base64 and data: URLs", () => {
    expect(decodeImage(png64)).toEqual({ bytes: PNG, contentType: "image/png" })
    expect(decodeImage(`data:image/png;base64,${png64}`).contentType).toBe("image/png")
  })

  it("refuses what is not a small raster image", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64")
    expect(() => decodeImage(svg)).toThrow(/not a PNG/)
    expect(() => decodeImage("not base64!")).toThrow(/must be base64/)
    const big = Buffer.concat([Buffer.from(PNG), Buffer.alloc(MAX_IMAGE_BYTES)]).toString("base64")
    expect(() => decodeImage(big)).toThrow(/over 1 MB/)
    try {
      decodeImage(svg)
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe("BAD_REQUEST")
    }
  })
})

describe("keys", () => {
  it("are fresh, typed and safe", () => {
    const key = newFileKey("org/org_1/logo", "image/png")
    expect(key).toMatch(/^org\/org_1\/logo-[0-9a-f]{32}\.png$/)
    expect(newFileKey("org/org_1/logo", "image/png")).not.toBe(key)
    expect(contentTypeOfKey(key)).toBe("image/png")
    expect(contentTypeOfKey("a/b.exe")).toBe("application/octet-stream")
    for (const bad of ["../x.png", "a//b.png", "/a.png", "a/../b.png", "a.png/", "a"]) {
      expect(isFileKey(bad), bad).toBe(false)
    }
    expect(() => newFileKey("x", "image/svg+xml")).toThrow()
  })
})

function recordingFetch(status = 200) {
  const requests: Request[] = []
  // The store only ever passes a signed Request.
  const fetch: typeof globalThis.fetch = async (request) => {
    requests.push(request as Request)
    return new Response(status === 200 ? "" : "<Error/>", { status })
  }
  return { fetch, requests }
}

describe("s3", () => {
  const base = {
    driver: "s3",
    bucket: "uploads",
    region: "eu-west-1",
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "secret", // gitleaks:allow
  } as const

  it("puts signed, immutable objects and returns the bucket URL", async () => {
    const { fetch, requests } = recordingFetch()
    const store = createFileStore({ ...base, fetch })
    const url = await store.put("org/o1/logo-abc.png", PNG, "image/png")
    expect(url).toBe("https://uploads.s3.eu-west-1.amazonaws.com/org/o1/logo-abc.png")
    expect(store.origin).toBe("https://uploads.s3.eu-west-1.amazonaws.com")
    const [put] = requests
    expect(put?.method).toBe("PUT")
    expect(put?.url).toBe(url)
    expect(put?.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/s3\/aws4_request/,
    )
    expect(put?.headers.get("content-type")).toBe("image/png")
    expect(put?.headers.get("cache-control")).toContain("immutable")
    expect(new Uint8Array((await put?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(PNG)
  })

  it("serves from a public URL and deletes only its own files", async () => {
    const { fetch, requests } = recordingFetch()
    const store = createFileStore({ ...base, publicUrl: "https://cdn.example.com/", fetch })
    const url = await store.put("user/u1/avatar-abc.webp", PNG, "image/webp")
    expect(url).toBe("https://cdn.example.com/user/u1/avatar-abc.webp")
    expect(await store.delete("https://avatars.githubusercontent.com/u/1")).toBe(false)
    expect(await store.delete(url)).toBe(true)
    expect(requests.at(-1)?.method).toBe("DELETE")
    expect(requests.at(-1)?.url).toBe(
      "https://uploads.s3.eu-west-1.amazonaws.com/user/u1/avatar-abc.webp",
    )
  })

  it("speaks path-style to a custom endpoint", async () => {
    const { fetch, requests } = recordingFetch()
    const store = createFileStore({ ...base, endpoint: "http://localhost:9000/", fetch })
    expect(await store.put("a/b.png", PNG, "image/png")).toBe(
      "http://localhost:9000/uploads/a/b.png",
    )
    expect(requests[0]?.url).toBe("http://localhost:9000/uploads/a/b.png")
  })

  it("turns a refusal into an unexposed INTERNAL error", async () => {
    const { fetch } = recordingFetch(403)
    const store = createFileStore({ ...base, fetch })
    const failure = store.put("a/b.png", PNG, "image/png")
    await expect(failure).rejects.toMatchObject({ code: "INTERNAL", expose: false })
    await expect(failure).rejects.toMatchObject({ context: { status: 403, body: "<Error/>" } })
  })

  it("treats a missing object as deleted", async () => {
    const { fetch } = recordingFetch(404)
    const store = createFileStore({ ...base, fetch })
    expect(await store.delete("https://uploads.s3.eu-west-1.amazonaws.com/a/b.png")).toBe(true)
  })

  it("refuses an unsafe key", async () => {
    const store = createFileStore({ ...base, fetch: recordingFetch().fetch })
    await expect(store.put("../etc/passwd.png", PNG, "image/png")).rejects.toThrow(/Not a file key/)
  })
})

describe("r2", () => {
  it("signs for region auto against the account endpoint and serves from the public URL", async () => {
    const { fetch, requests } = recordingFetch()
    const store = createFileStore({
      driver: "r2",
      accountId: "acc123",
      bucket: "uploads",
      accessKeyId: "AKID",
      secretAccessKey: "secret", // gitleaks:allow
      publicUrl: "https://pub-xyz.r2.dev",
      fetch,
    })
    expect(await store.put("a/b.png", PNG, "image/png")).toBe("https://pub-xyz.r2.dev/a/b.png")
    expect(store.origin).toBe("https://pub-xyz.r2.dev")
    expect(requests[0]?.url).toBe("https://acc123.r2.cloudflarestorage.com/uploads/a/b.png")
    expect(requests[0]?.headers.get("authorization")).toMatch(/\/auto\/s3\/aws4_request/)
    expect(await store.delete("https://pub-xyz.r2.dev/a/b.png")).toBe(true)
    expect(requests[1]?.method).toBe("DELETE")
  })
})

describe("vercel blob", () => {
  const token = "vercel_blob_rw_AbC123_secretpart" // gitleaks:allow
  const host = "https://abc123.public.blob.vercel-storage.com"

  it("puts public blobs with the token and deletes only its own", async () => {
    const put = vi.fn(async (pathname: string) => ({ url: `${host}/${pathname}` }))
    const del = vi.fn(async () => undefined)
    const store = createVercelBlobStore({ driver: "vercel-blob", token }, {
      put,
      del,
    } as never)
    expect(store.origin).toBe(host)
    const url = await store.put("org/o1/logo-abc.png", PNG, "image/png")
    expect(url).toBe(`${host}/org/o1/logo-abc.png`)
    expect(put).toHaveBeenCalledWith(
      "org/o1/logo-abc.png",
      expect.any(Buffer),
      expect.objectContaining({ access: "public", contentType: "image/png", token }),
    )
    expect(await store.delete("https://lh3.googleusercontent.com/a/x")).toBe(false)
    expect(await store.delete(url)).toBe(true)
    expect(del).toHaveBeenCalledWith(url, { token })
  })

  it("wraps SDK failures", async () => {
    const put = vi.fn(async () => {
      throw new Error("BlobAccessError")
    })
    const store = createVercelBlobStore({ driver: "vercel-blob", token }, {
      put,
      del: put,
    } as never)
    await expect(store.put("a/b.png", PNG, "image/png")).rejects.toMatchObject({ code: "INTERNAL" })
    await expect(store.delete(`${host}/a/b.png`)).rejects.toMatchObject({ code: "INTERNAL" })
  })

  it("deletes a URL whose host came back in another case", async () => {
    const put = vi.fn(async () => undefined)
    const del = vi.fn(async () => undefined)
    const store = createVercelBlobStore({ driver: "vercel-blob", token }, { put, del } as never)
    const upper = "https://ABC123.PUBLIC.blob.vercel-storage.com/org/o1/logo-abc.png"
    expect(await store.delete(upper)).toBe(true)
    expect(del).toHaveBeenCalledWith(upper, { token })
    expect(await store.delete("not a url")).toBe(false)
    expect(del).toHaveBeenCalledTimes(1)
  })

  it("refuses a token that is not a read-write token", () => {
    expect(() => createFileStore({ driver: "vercel-blob", token: "nope" })).toThrow(
      /not a Vercel Blob read-write token/,
    )
  })
})

describe("local", () => {
  const dirs: string[] = []
  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true })
  })

  it("writes, reads and deletes files under its directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "proof-storage-"))
    dirs.push(dir)
    const store = createFileStore({
      driver: "local",
      dir,
      publicUrl: "http://localhost:3000/files",
    })
    const url = await store.put("org/o1/logo-abc.png", PNG, "image/png")
    expect(url).toBe("http://localhost:3000/files/org/o1/logo-abc.png")
    expect(await store.read?.("org/o1/logo-abc.png")).toEqual({
      body: PNG,
      contentType: "image/png",
    })
    expect(await store.read?.("org/o1/missing.png")).toBeNull()
    expect(await store.read?.("../x.png")).toBeNull()
    expect(await store.delete("http://elsewhere/files/org/o1/logo-abc.png")).toBe(false)
    expect(await store.delete(url)).toBe(true)
    expect(await readdir(join(dir, "org", "o1"))).toEqual([])
    expect(await store.delete(url)).toBe(true)
  })
})

describe("memory", () => {
  it("keeps files in a map", async () => {
    const store = createFileStore({ driver: "memory", publicUrl: "http://test/files" })
    const url = await store.put("a/b.gif", PNG, "image/gif")
    expect(await store.read?.("a/b.gif")).toEqual({ body: PNG, contentType: "image/gif" })
    expect(await store.delete(url)).toBe(true)
    expect(await store.read?.("a/b.gif")).toBeNull()
    expect(await store.delete("http://test/files/%E0%A4%A.png")).toBe(false)
  })
})
