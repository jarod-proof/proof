import { readFileSync } from "node:fs"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createHqHarness, type TestPerson } from "../app.test.helpers"

const BASE = "http://localhost:3100"

describe("the admin pages (PGlite)", () => {
  let hq: Awaited<ReturnType<typeof createHqHarness>>
  let founder: TestPerson
  let stranger: TestPerson
  let agent: { key: string }

  beforeAll(async () => {
    hq = await createHqHarness({ founderEmails: ["founder@example.com"] })
    founder = await hq.signUp("founder@example.com")
    stranger = await hq.signUp("stranger@example.com")
    agent = {
      key: await hq.keyFor(founder, {
        hq_proposal: ["create", "read"],
        hq_entry: ["read"],
        hq_spend: ["read", "record"],
      }),
    }
  })
  afterAll(() => hq.close())

  type Credential = { cookie: string } | { key: string } | null
  const headersOf = (as: Credential, extra: Record<string, string> = {}) => ({
    ...(as && "cookie" in as ? { cookie: as.cookie } : {}),
    ...(as && "key" in as ? { "x-api-key": as.key } : {}),
    ...extra,
  })
  const get = (path: string, as: Credential) =>
    hq.app.request(`${BASE}/admin${path}`, { headers: headersOf(as) })
  const decide = (
    id: string,
    as: Credential,
    fields: Record<string, string>,
    origin: string | null = BASE,
  ) =>
    hq.app.request(`${BASE}/admin/proposals/${id}/decision`, {
      method: "POST",
      headers: headersOf(as, {
        "content-type": "application/x-www-form-urlencoded",
        ...(origin === null ? {} : { origin }),
      }),
      body: new URLSearchParams(fields).toString(),
    })

  const propose = async (slug: string, text: string, title = "Pricing") => {
    const res = await hq.app.request(`${BASE}/v1/proposals`, {
      method: "POST",
      headers: headersOf(agent, { "content-type": "application/json" }),
      body: JSON.stringify({ kind: "fact", slug, title, body: { text }, reason: "heard it" }),
    })
    return ((await res.json()) as { proposalId: string }).proposalId
  }
  const pendingIds = async () => {
    const res = await hq.app.request(`${BASE}/v1/proposals?status=pending`, {
      headers: headersOf({ cookie: founder.cookie }),
    })
    return ((await res.json()) as { proposals: { id: string }[] }).proposals.map((p) => p.id)
  }

  it("serves a sign-in page, its script and stylesheet without a session, framed by no one", async () => {
    const page = await get("/login?next=%2Fadmin%2Fspend", null)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('data-next="/admin/spend"')
    expect(page.headers.get("x-frame-options")).toBe("DENY")
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    expect(page.headers.get("cache-control")).toBe("no-store")
    // A browser sends `Origin: null` on a form POST under no-referrer, which the CSRF check refuses.
    expect(page.headers.get("referrer-policy")).toBe("same-origin")
    const script = await get("/login.js", null)
    expect(script.headers.get("content-type")).toContain("javascript")
    expect(await script.text()).toContain("/api/auth/sign-in/email")
    expect((await get("/admin.css", null)).headers.get("content-type")).toContain("text/css")
  })

  it("sends a signed-out visitor to sign in, and comes back to the page they asked for", async () => {
    for (const path of ["/proposals", "/spend", "/entries/x"]) {
      const res = await get(path, null)
      expect(res.status, path).toBe(303)
      expect(res.headers.get("location")).toBe(
        `${BASE}/admin/login?next=${encodeURIComponent(`/admin${path}`)}`,
      )
    }
  })

  it("turns away an API key, and a signed-in person who is not a founder", async () => {
    const id = await propose("keys-no", "A fact.")
    for (const as of [agent, { cookie: stranger.cookie }]) {
      for (const path of ["/proposals", "/spend", "/entries/x"]) {
        expect((await get(path, as)).status, path).toBe(403)
      }
      expect((await decide(id, as, { decision: "approve" })).status).toBe(403)
    }
    expect(await pendingIds()).toContain(id)
  })

  it("a key never decides through the admin, even one carrying hq_proposal decide", async () => {
    const minted = { key: await hq.keyFor(founder, { hq_proposal: ["decide", "read"] }) }
    const id = await propose("minted-key", "A fact.")
    expect((await decide(id, minted, { decision: "approve" })).status).toBe(403)
    expect(await pendingIds()).toContain(id)
  })

  it("lists pending proposals with the proposed text escaped, never as markup", async () => {
    const id = await propose(
      "xss",
      '<script>alert("x")</script> & <img src=x onerror=alert(1)>',
      "<b>Bold</b>",
    )
    const html = await (await get("/proposals", { cookie: founder.cookie })).text()
    expect(html).toContain("&lt;script&gt;alert(")
    expect(html).not.toContain("<script>alert")
    expect(html).not.toContain("<img src=x")
    expect(html).not.toContain("<b>Bold</b>")
    expect(html).toContain(`/admin/proposals/${id}/decision`)
    expect(html).toContain("Approve")
    expect(html).toContain("Reject")
  })

  it("approve goes through decide_proposal: a new version by the proposer, approved by the founder, in the history", async () => {
    const id = await propose("pricing-ui", "Free, then $20.")
    const res = await decide(id, { cookie: founder.cookie }, { decision: "approve", note: "ok" })
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/admin/proposals")
    expect(await pendingIds()).not.toContain(id)

    const listed = await (await get("/proposals", { cookie: founder.cookie })).text()
    const link = /href="(\/admin\/entries\/[^"]+)"/.exec(listed)?.[1]
    if (!link) throw new Error("the decided proposal has no history link")
    const history = await (await get(link.replace("/admin", ""), { cookie: founder.cookie })).text()
    expect(history).toContain("Version 1")
    expect(history).toContain("Free, then $20.")
    expect(history).toContain(`from proposal:${id}`)
    expect(history).toContain("agent")
    const stored = await hq.app.request(`${BASE}/v1/proposals?status=approved`, {
      headers: headersOf({ cookie: founder.cookie }),
    })
    expect(
      ((await stored.json()) as { proposals: { id: string; decidedBy: string }[] }).proposals.find(
        (p) => p.id === id,
      )?.decidedBy,
    ).toBe(founder.userId)
  })

  it("reject leaves no entry; a decided proposal can't be decided again (the page says so)", async () => {
    const id = await propose("rejected-ui", "Nope.")
    expect((await decide(id, { cookie: founder.cookie }, { decision: "reject" })).status).toBe(303)
    const again = await decide(id, { cookie: founder.cookie }, { decision: "approve" })
    expect(again.status).toBe(409)
    expect(await again.text()).toContain("already rejected")
    const entries = await hq.app.request(`${BASE}/v1/entries?kind=fact`, {
      headers: headersOf({ cookie: founder.cookie }),
    })
    const slugs = ((await entries.json()) as { entries: { slug: string }[] }).entries.map(
      (e) => e.slug,
    )
    expect(slugs).not.toContain("rejected-ui")
  })

  it("a decision without a trusted Origin is refused and changes nothing (CSRF)", async () => {
    const id = await propose("csrf", "A fact.")
    for (const origin of [null, "https://evil.example", "null"]) {
      const res = await decide(id, { cookie: founder.cookie }, { decision: "approve" }, origin)
      expect(res.status, String(origin)).toBe(403)
    }
    expect(await pendingIds()).toContain(id)
  })

  it("an unknown decision value or proposal is refused, not guessed", async () => {
    const id = await propose("odd", "A fact.")
    expect((await decide(id, { cookie: founder.cookie }, { decision: "maybe" })).status).toBe(400)
    expect((await decide("nope", { cookie: founder.cookie }, { decision: "approve" })).status).toBe(
      404,
    )
    expect(await pendingIds()).toContain(id)
  })

  it("shows today's allowance and the last 30 days by source and task", async () => {
    const record = (body: object) =>
      hq.app.request(`${BASE}/v1/spend`, {
        method: "POST",
        headers: headersOf(agent, { "content-type": "application/json" }),
        body: JSON.stringify(body),
      })
    await record({ source: "eve", amountUsd: 1.25, model: "haiku" })
    await record({ source: "box", estimatedUsd: 0.5, model: "opus" })
    const html = await (await get("/spend", { cookie: founder.cookie })).text()
    expect(html).toContain("2026-11-17")
    expect(html).toContain("$10.0000")
    expect(html).toContain("$1.2500")
    expect(html).toContain("$8.7500")
    expect(html).toContain("box")
    expect(html).toContain("(no run)")
  })

  it("an unknown entry is a not-found page", async () => {
    expect((await get("/entries/nope", { cookie: founder.cookie })).status).toBe(404)
  })

  it("the page code never writes a decision itself: it calls the decide_proposal operation", () => {
    const source = readFileSync(new URL("./routes.tsx", import.meta.url), "utf8")
    expect(source).toContain('"decide_proposal"')
    expect(source).not.toContain("decideProposal")
  })
})
