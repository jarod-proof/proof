import { organization, user } from "@proof/db"
import { createMemoryStore } from "@proof/storage"
import { eq } from "drizzle-orm"
import { afterAll, describe, expect, it } from "vitest"

import { MAX_BODY_BYTES } from "./app"
import { BASE, createTestApp } from "./app.test.helpers"

// A real 1x1 PNG, and an SVG that must never be stored (it can carry script).
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>').toString(
  "base64",
)

const files = createMemoryStore({ driver: "memory", publicUrl: `${BASE}/files` })
const t = await createTestApp([], { files })
const off = await createTestApp([], { files: false })
afterAll(async () => {
  await t.close()
  await off.close()
})

type Json = Record<string, unknown> & { error?: { code: string; hint?: string } }
async function call(
  app: typeof t,
  credential: string,
  method: string,
  path: string,
  body?: unknown,
) {
  const res = await app.req(
    path,
    app.as(credential, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
  )
  return { status: res.status, body: (await res.json()) as Json }
}
const keyOf = (url: string) => url.slice(`${BASE}/files/`.length)

async function orgLogo(orgId: string) {
  const [row] = await t.db
    .select({ logo: organization.logo })
    .from(organization)
    .where(eq(organization.id, orgId))
  return row?.logo ?? null
}
async function userImage(userId: string) {
  const [row] = await t.db.select({ image: user.image }).from(user).where(eq(user.id, userId))
  return row?.image ?? null
}

describe("get_upload_limits", () => {
  it("says uploads are on, and what an image may be", async () => {
    const res = await call(t, t.fullKey, "GET", "/v1/uploads/limits")
    expect(res.body).toEqual({
      enabled: true,
      maxBytes: 1024 * 1024,
      contentTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
    })
  })

  it("says uploads are off without a file store", async () => {
    const res = await call(off, off.owner.cookie, "GET", "/v1/uploads/limits")
    expect(res.body).toMatchObject({ enabled: false })
  })
})

describe("organization logo", () => {
  it("stores the image, records it and serves it", async () => {
    const res = await call(t, t.owner.cookie, "PUT", "/v1/organization/logo", { image: PNG })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const logo = res.body.logo as string
    expect(logo).toMatch(new RegExp(`^${BASE}/files/org/${t.owner.orgId}/logo-[0-9a-f]{32}\\.png$`))
    expect(await orgLogo(t.owner.orgId)).toBe(logo)

    const served = await t.req(new URL(logo).pathname)
    expect(served.status).toBe(200)
    expect(served.headers.get("content-type")).toBe("image/png")
    expect(served.headers.get("x-content-type-options")).toBe("nosniff")
    expect(served.headers.get("cache-control")).toContain("immutable")
    expect(Buffer.from(await served.arrayBuffer()).toString("base64")).toBe(PNG)
  })

  it("replaces the old file, and removing clears both", async () => {
    const first = (await call(t, t.owner.cookie, "PUT", "/v1/organization/logo", { image: PNG }))
      .body.logo as string
    const second = (await call(t, t.owner.cookie, "PUT", "/v1/organization/logo", { image: PNG }))
      .body.logo as string
    expect(second).not.toBe(first)
    expect(files.files.has(keyOf(first))).toBe(false)
    expect(files.files.has(keyOf(second))).toBe(true)

    const removed = await call(t, t.owner.cookie, "DELETE", "/v1/organization/logo")
    expect(removed.body).toEqual({ logo: null })
    expect(await orgLogo(t.owner.orgId)).toBeNull()
    expect(files.files.has(keyOf(second))).toBe(false)
    expect((await t.req(new URL(second).pathname)).status).toBe(404)
  })

  it("acts only in the caller's organization", async () => {
    const before = await orgLogo(t.owner.orgId)
    const res = await call(t, t.other.cookie, "PUT", "/v1/organization/logo", { image: PNG })
    expect(res.body.logo).toContain(`/org/${t.other.orgId}/`)
    expect(await orgLogo(t.owner.orgId)).toBe(before)
  })

  it("refuses an SVG, junk and an oversized body without storing anything", async () => {
    const stored = files.files.size
    const svg = await call(t, t.owner.cookie, "PUT", "/v1/organization/logo", { image: SVG })
    expect(svg.status).toBe(400)
    expect(svg.body.error?.hint).toMatch(/SVG is not accepted/)
    const junk = await call(t, t.owner.cookie, "PUT", "/v1/organization/logo", { image: "%%%" })
    expect(junk.status).toBe(400)
    const huge = await call(t, t.owner.cookie, "PUT", "/v1/organization/logo", {
      image: "A".repeat(MAX_BODY_BYTES),
    })
    expect(huge.status).toBe(400)
    expect(huge.body.error?.code).toBe("BAD_REQUEST")
    expect(files.files.size).toBe(stored)
  })

  it("is CONFLICT, with a hint, when uploads are off", async () => {
    const res = await call(off, off.owner.cookie, "PUT", "/v1/organization/logo", { image: PNG })
    expect(res.status).toBe(409)
    expect(res.body.error?.hint).toMatch(/STORAGE_DRIVER/)
    expect((await off.req("/files/org/x/logo-a.png")).status).toBe(404)
  })

  it("lets a viewer read but not change it", async () => {
    const res = await call(t, t.viewer.cookie, "PUT", "/v1/organization/logo", { image: PNG })
    expect(res.status).toBe(403)
  })
})

describe("avatar", () => {
  it("is set and removed by the person, for themselves", async () => {
    const set = await call(t, t.viewer.cookie, "PUT", "/v1/me/avatar", { image: PNG })
    expect(set.status, JSON.stringify(set.body)).toBe(200)
    const image = set.body.image as string
    expect(image).toContain(`/files/user/${t.viewer.userId}/avatar-`)
    expect(await userImage(t.viewer.userId)).toBe(image)

    const removed = await call(t, t.viewer.cookie, "DELETE", "/v1/me/avatar")
    expect(removed.body).toEqual({ image: null })
    expect(await userImage(t.viewer.userId)).toBeNull()
    expect(files.files.has(keyOf(image))).toBe(false)
  })

  it("is refused to API keys", async () => {
    const res = await call(t, t.fullKey, "PUT", "/v1/me/avatar", { image: PNG })
    expect(res.status).toBe(403)
    expect(res.body.error?.hint).toMatch(/web app/)
  })

  it("leaves a social sign-in avatar it did not store alone", async () => {
    const github = "https://avatars.githubusercontent.com/u/1?v=4"
    await t.db.update(user).set({ image: github }).where(eq(user.id, t.owner.userId))
    const res = await call(t, t.owner.cookie, "PUT", "/v1/me/avatar", { image: PNG })
    expect(res.status).toBe(200)
    expect(await userImage(t.owner.userId)).toBe(res.body.image)
  })
})

// better-auth's organization update and user update take any `logo` or `image` string, so a row can
// hold another tenant's file URL. Replacing or removing it must not delete that file.
describe("another tenant's file", () => {
  it("is not deleted when an organization's logo row points at it", async () => {
    const victim = (await call(t, t.other.cookie, "PUT", "/v1/organization/logo", { image: PNG }))
      .body.logo as string
    await t.db.update(organization).set({ logo: victim }).where(eq(organization.id, t.owner.orgId))

    const res = await call(t, t.owner.cookie, "PUT", "/v1/organization/logo", { image: PNG })
    expect(res.status).toBe(200)
    expect(files.files.has(keyOf(victim))).toBe(true)

    await t.db.update(organization).set({ logo: victim }).where(eq(organization.id, t.owner.orgId))
    await call(t, t.owner.cookie, "DELETE", "/v1/organization/logo")
    expect(files.files.has(keyOf(victim))).toBe(true)
  })

  it("is not deleted when a person's avatar row points at it", async () => {
    const victim = (await call(t, t.other.cookie, "PUT", "/v1/me/avatar", { image: PNG })).body
      .image as string
    await t.db.update(user).set({ image: victim }).where(eq(user.id, t.owner.userId))

    const res = await call(t, t.owner.cookie, "DELETE", "/v1/me/avatar")
    expect(res.body).toEqual({ image: null })
    expect(files.files.has(keyOf(victim))).toBe(true)
  })
})
