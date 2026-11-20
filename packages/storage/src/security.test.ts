import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { AppError } from "@proof/errors"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createLocalStore } from "./local"
import { decodeImage, imageTypeOf, MAX_IMAGE_BYTES } from "./image"
import { isFileKey, keyUnder, newFileKey } from "./store"

const BASE = "https://api.example.com/files"
const KEY = "org/abc/logo-0123456789abcdef0123456789abcdef.png"

describe("keyUnder", () => {
  it("returns the key for a URL the store issued", () => {
    expect(keyUnder(BASE, `${BASE}/${KEY}`)).toBe(KEY)
  })

  it("refuses URLs that only look like the store's", () => {
    const refused = [
      `https://api.example.com/filesX/${KEY}`,
      `https://api.example.com/files/../${KEY}`,
      `https://api.example.com/files/%2e%2e/secret.png`,
      `https://api.example.com/files/..%2Fsecret.png`,
      `https://api.example.com/files/%252e%252e/secret.png`,
      `https://api.example.com/files/${KEY}?x=1`,
      `https://api.example.com/files/${KEY}#frag`,
      `https://api.example.com@evil.example/files/${KEY}`,
      `https://api.example.com.evil.example/files/${KEY}`,
      `https://api.example.com/files/org\\abc\\logo-0123456789abcdef0123456789abcdef.png`,
      `https://api.example.com/files/${KEY}/`,
      `https://api.example.com/files/`,
      `http://api.example.com/files/${KEY}`,
    ]
    for (const url of refused) expect(keyUnder(BASE, url), url).toBeNull()
  })

  it("refuses a key with a traversal segment, a trailing dot or a second extension", () => {
    expect(isFileKey("org/../logo-x.png")).toBe(false)
    expect(isFileKey("org/abc/logo.png.")).toBe(false)
    expect(isFileKey("org/abc/logo.tar.gz")).toBe(false)
    expect(isFileKey("/org/abc/logo.png")).toBe(false)
    expect(isFileKey("org/abc/logo.png\n")).toBe(false)
    expect(isFileKey("org/abc/logo.PNG")).toBe(false)
    expect(isFileKey("org/abc/.png")).toBe(false)
  })
})

describe("local store", () => {
  let sandbox = ""
  let outside = ""
  let store: ReturnType<typeof createLocalStore>
  beforeAll(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "storage-security-"))
    outside = join(sandbox, "secret.png")
    await writeFile(outside, "keep me")
    store = createLocalStore({ driver: "local", dir: join(sandbox, "files"), publicUrl: BASE })
  })
  afterAll(() => rm(sandbox, { recursive: true, force: true }))

  it("does not delete a file outside its directory through a traversal URL", async () => {
    const urls = [
      `${BASE}/../secret.png`,
      `${BASE}/%2e%2e/secret.png`,
      `${BASE}/..%2Fsecret.png`,
      `${BASE}/%252e%252e/secret.png`,
    ]
    for (const url of urls) expect(await store.delete(url), url).toBe(false)
    expect(await readFile(outside, "utf8")).toBe("keep me")
  })

  it("reads only keys it could have written", async () => {
    const url = await store.put(KEY, new Uint8Array([1, 2, 3]), "image/png")
    expect(url).toBe(`${BASE}/${KEY}`)
    expect(await store.read?.(KEY)).toMatchObject({ contentType: "image/png" })
    for (const key of ["../secret.png", "org/../../secret.png", "/etc/passwd", "org\\x.png"]) {
      expect(await store.read?.(key), key).toBeNull()
    }
    expect(await readFile(outside, "utf8")).toBe("keep me")
  })

  it("refuses to write a key outside its directory", async () => {
    await expect(store.put("../escape.png", new Uint8Array([1]), "image/png")).rejects.toThrow(
      /Not a file key/,
    )
  })
})

describe("decodeImage", () => {
  const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const png = Buffer.from([...PNG_HEAD, 0, 0, 0, 13]).toString("base64")

  it("accepts a data: URL and whitespace-broken base64 of a real image", () => {
    const wrapped = `data:image/png;base64,${png.slice(0, 8)}\n${png.slice(8)}`
    expect(decodeImage(wrapped).contentType).toBe("image/png")
  })

  it("takes the type from the bytes, so a claimed image/png prefix cannot pass an SVG", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>').toString(
      "base64",
    )
    expect(() => decodeImage(`data:image/png;base64,${svg}`)).toThrow(AppError)
  })

  it("refuses padding that does not fit base64", () => {
    expect(() => decodeImage(`${png}===`)).toThrow(AppError)
    expect(() => decodeImage("AA=A")).toThrow(AppError)
  })

  it("refuses an image over the limit by its decoded size", () => {
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1, 0)
    big.set(PNG_HEAD, 0)
    expect(() => decodeImage(big.toString("base64"))).toThrow(/over 1 MB/)
  })

  it("sniffs GIF and WebP by their full magic", () => {
    expect(imageTypeOf(new TextEncoder().encode("GIF87a"))).toBe("image/gif")
    expect(imageTypeOf(new TextEncoder().encode("RIFF\0\0\0\0WAVE"))).toBeNull()
    expect(imageTypeOf(new TextEncoder().encode("RIFF\0\0\0\0WEBP"))).toBe("image/webp")
  })

  it("names keys with the extension of the type they were sniffed as", () => {
    expect(newFileKey("org/abc/logo", "image/jpeg")).toMatch(/\.jpg$/)
    expect(() => newFileKey("org/abc/logo", "image/svg+xml")).toThrow()
  })
})
