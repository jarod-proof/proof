// scripts/seed-work.mjs against hq's real app on PGlite: the seed writes the pipeline through /v1
// only (a founder's session cookie, a trusted Origin, no database), and a second run is a no-op.
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
  cookieHeaderFrom,
  isLoopback,
  MERGE_MINUTES_AGO,
  SEED_ISSUES,
  type SeedResult,
  seedWork,
} from "../scripts/seed-work.mjs"
import { workBoardSchema, workItemDetailSchema } from "../web/src/api/schemas"
import { urlOf } from "../web/src/test/fake-hq"
import { createHqHarness } from "./app.test.helpers"

const BASE = "http://localhost:3100"
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "seed-work.mjs")

type Harness = Awaited<ReturnType<typeof createHqHarness>>

/** What a script on another machine does: fetch the app over HTTP (here, in process). */
const appFetch =
  (hq: Harness): typeof fetch =>
  async (input, init) =>
    hq.app.request(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      init,
    )

describe("seed-work.mjs", () => {
  let hq: Harness
  let cookie: string
  let first: SeedResult
  let afterFirst: unknown

  const getJson = async (path: string): Promise<unknown> => {
    const res = await hq.app.request(`${BASE}${path}`, { headers: { cookie } })
    expect(res.status, path).toBe(200)
    return res.json()
  }

  beforeAll(async () => {
    hq = await createHqHarness({ founderEmails: ["founder@example.com"] })
    cookie = (await hq.signUp("founder@example.com")).cookie
    first = await seedWork({ baseUrl: BASE, cookie, fetch: appFetch(hq) })
    afterFirst = await getJson("/v1/work/board")
  })
  afterAll(async () => {
    await hq.close()
  })

  const board = () => workBoardSchema.parse(afterFirst)
  const stateOf = (role: keyof typeof SEED_ISSUES) => {
    const cards = board().columns.flatMap((c) => c.items)
    return cards.find((card) => card.displayId === first.ids[role])
  }

  it("the seed produces an item in every board column, a pending merge approval, an open question, an exhausted item, a verify item with 134 minutes left (still in verify) and a reopened item (the second verify item, reopened by a recurring signal), through /v1 only", async () => {
    expect(first.built).toHaveLength(10)
    expect(first.found).toEqual([])
    const b = board()
    expect(b.columns.map((c) => [c.key, c.count > 0])).toEqual([
      ["triage", true],
      ["fixing", true],
      ["in_review", true],
      ["verifying", true],
      ["done_today", true],
    ])
    expect(b.needsYou.map((n) => n.kind).sort()).toEqual([
      "agent_question",
      "attempt_budget",
      "merge_approval",
    ])
    expect(b.needsYou.find((n) => n.kind === "merge_approval")?.displayId).toBe(
      first.ids.pendingMerge,
    )
    expect(b.needsYou.find((n) => n.kind === "agent_question")?.displayId).toBe(first.ids.asking)

    // the exhausted item: three failed fixes of three
    expect(stateOf("exhausted")?.attempts).toMatchObject({ used: 3, limit: 3, running: false })
    expect(b.needsYou.find((n) => n.kind === "attempt_budget")?.displayId).toBe(first.ids.exhausted)

    // the merge a few minutes ago is still deploying; the 241 minute one verifies with 134 left
    expect(stateOf("deploying")?.state).toBe("deploy")
    expect(stateOf("verifyingLate")?.state).toBe("verify")
    expect(MERGE_MINUTES_AGO.verifyingLate).toBe(241)
    const late = workItemDetailSchema.parse(
      await getJson(`/v1/work-items/${first.ids.verifyingLate}`),
    )
    expect(late.window).toMatchObject({ status: "running", remainingMinutes: 134 })
    expect(late.window?.buckets.length).toBeGreaterThan(0)
    // the 7 hour merge passed in the one sweep; the 200 minute one was reopened by its recurrence
    expect(stateOf("done")?.state).toBe("done")
    expect(stateOf("reopened")?.state).toBe("reopened")
    expect(first.sweep?.passed).toHaveLength(1)
    expect(first.sweep?.reopened).toEqual([])

    // an item in every one of the seven stages the board folds into five columns
    const states = new Set(b.columns.flatMap((c) => c.items.map((i) => i.state)))
    for (const state of ["triage", "plan", "attempt", "review", "deploy", "verify", "done"]) {
      expect(states.has(state as never), state).toBe(true)
    }
    expect(states.has("reopened")).toBe(true)
  })

  it("writes only through /v1: no auth call, no database, no sleep", () => {
    expect(first.touched.length).toBeGreaterThan(40)
    for (const call of first.touched) expect(call, call).toMatch(/^(GET|POST) \/v1\//)
    const text = readFileSync(SCRIPT, "utf8")
    const imports = [...text.matchAll(/^import[\s\S]*?from "([^"]+)"/gm)].map((m) => m[1])
    expect([...imports].sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
      "node:fs",
      "node:url",
    ])
    expect(text).not.toMatch(/drizzle|postgres|pglite|\bsql\b|setTimeout|api\/auth/i)
    expect(text).not.toMatch(/\bconsole\./)
  })

  it("never prints the cookie", () => {
    expect(JSON.stringify(first)).not.toContain(cookie)
  })

  it("running the script twice leaves the first run's items and adds none that break the columns", async () => {
    const writes = (await getJson("/v1/work-items?limit=100")) as { items: { id: string }[] }
    const second = await seedWork({ baseUrl: BASE, cookie, fetch: appFetch(hq) })
    expect(second.built).toEqual([])
    expect(second.found).toHaveLength(10)
    expect(second.ids).toEqual(first.ids)
    expect(second.sweep).toBeNull()
    // nothing but reads: no write was sent, so nothing the first run made moved
    expect(second.touched.every((call) => call.startsWith("GET "))).toBe(true)
    expect(await getJson("/v1/work/board")).toEqual(afterFirst)
    expect(await getJson("/v1/work-items?limit=100")).toEqual(writes)
  })

  it("warns in the last 10 minutes of a UTC day, from hq's clock", async () => {
    const lateFetch: typeof fetch = async (input) => {
      const url = urlOf(input)
      if (url.includes("/v1/work/board")) {
        return new Response(JSON.stringify({ now: "2026-11-17T23:55:00.000Z" }))
      }
      return new Response(JSON.stringify({ items: [{ displayId: "FAC-1" }] }))
    }
    const result = await seedWork({ baseUrl: BASE, cookie: "a=b", fetch: lateFetch })
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain("midnight")
    const early: typeof fetch = async (input, init) =>
      urlOf(input).includes("/v1/work/board")
        ? new Response(JSON.stringify({ now: "2026-11-17T23:49:00.000Z" }))
        : lateFetch(input, init)
    expect((await seedWork({ baseUrl: BASE, cookie: "a=b", fetch: early })).warnings).toEqual([])
  })

  it("a refusal stops the seed with the status and hq's message", async () => {
    await expect(seedWork({ baseUrl: BASE, cookie: "", fetch: appFetch(hq) })).rejects.toThrow(
      /GET \/v1\/work\/board answered 401/,
    )
  })

  it("reads a cookie file as a Cookie header or as a Netscape jar", () => {
    expect(cookieHeaderFrom("better-auth.session_token=abc; other=1\n")).toBe(
      "better-auth.session_token=abc; other=1",
    )
    expect(cookieHeaderFrom("Cookie: a=b\n")).toBe("a=b")
    const jar = [
      "# Netscape HTTP Cookie File",
      "#HttpOnly_localhost\tFALSE\t/\tFALSE\t0\tsession\txyz",
      "localhost\tFALSE\t/\tFALSE\t0\tother\t1",
    ].join("\n")
    expect(cookieHeaderFrom(jar)).toBe("session=xyz; other=1")
    expect(() => cookieHeaderFrom("# nothing\n")).toThrow("no cookie")
  })

  it("refuses a base url that is not this machine unless --allow-remote is passed, and writes nothing", async () => {
    const calls: string[] = []
    const spy: typeof fetch = async (input) => {
      calls.push(urlOf(input))
      return new Response(JSON.stringify({ now: "2026-11-17T12:00:00.000Z", items: [] }))
    }
    for (const remote of [
      "https://hq.example.com",
      "https://hq.acme.dev/app",
      "http://192.168.1.20:3100",
      "http://10.0.0.5",
      "https://notlocalhost.com",
      "http://localhost.evil.com",
    ]) {
      await expect(
        seedWork({ baseUrl: remote, cookie: "a=b", fetch: spy }),
        remote,
      ).rejects.toThrow(/--allow-remote/)
    }
    expect(calls).toEqual([])
    // with the flag it goes ahead (here every item is already "found", so it only reads)
    const found: typeof fetch = async (input) =>
      urlOf(input).includes("/v1/work/board")
        ? new Response(JSON.stringify({ now: "2026-11-17T12:00:00.000Z" }))
        : new Response(JSON.stringify({ items: [{ displayId: "FAC-1" }] }))
    const result = await seedWork({
      baseUrl: "https://hq.example.com",
      cookie: "a=b",
      fetch: found,
      allowRemote: true,
    })
    expect(result.built).toEqual([])
    for (const local of [
      "http://localhost:3100",
      "https://w15-web-client.app.proof.localhost",
      "http://127.0.0.1:3100",
      "http://127.1.2.3",
      "http://[::1]:3100",
    ]) {
      expect(isLoopback(local), local).toBe(true)
    }
    expect(isLoopback("https://hq.example.com")).toBe(false)
    expect(isLoopback("http://localhost.evil.com")).toBe(false)
  })

  it("the command line passes --allow-remote through and the usage line names it", () => {
    const text = readFileSync(SCRIPT, "utf8")
    expect(text).toContain('args.includes("--allow-remote")')
    expect(text).toContain("[owner/name] [--allow-remote]")
  })
})
