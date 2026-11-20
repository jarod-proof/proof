import { test } from "@e2e-dev/web"
import { expect } from "e2e"

import { HQ_FOUNDER_EMAIL, HQ_FOUNDER_PASSWORD } from "./support/hq-stack"
import { uniqueId } from "./support/unique"

// An API test of apps/hq's brain on real Postgres (the `hq` target in e2e.config.ts): a founder
// proposes, approves and searches; a stale approval is a CONFLICT that changes nothing; a
// signed-in stranger is turned away. No model, no page. The other targets serve the product, so
// the test does nothing there.
/** The parts of hq's JSON replies this journey reads. */
interface Reply {
  error: { code: string }
  status: string
  proposalId: string
  entryId: string
  version: number
  latestVersion: number
  body: { text: string }
  hits: { id: string }[]
  versions: { version: number }[]
  proposals: { id: string }[]
}

test("a founder proposes, approves and searches; a stale approval is a CONFLICT", async ({
  app,
}) => {
  if (!app.baseUrl) throw new Error("the app has no base URL")
  const base = app.baseUrl
  const product = await fetch(new URL("/v1/whoami", base))
  if (product.status === 401) return

  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ")
  const call = async (cookie: string, method: "GET" | "POST", path: string, body?: unknown) => {
    const res = await fetch(new URL(path, base), {
      method,
      headers: {
        cookie,
        origin: base,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: (await res.json()) as Reply }
  }

  const signIn = await fetch(new URL("/api/auth/sign-in/email", base), {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email: HQ_FOUNDER_EMAIL, password: HQ_FOUNDER_PASSWORD }),
  })
  expect(signIn.status).toBe(200)
  const founder = cookieOf(signIn)

  // A word the search can only find in this run's entries.
  const word = `quokka${uniqueId()
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()}`
  const slug = `pricing-${word}`
  const propose = (text: string, baseVersion?: number) =>
    call(founder, "POST", "/v1/proposals", {
      kind: "fact",
      slug,
      title: "Pricing",
      body: { text },
      reason: "e2e",
      ...(baseVersion === undefined ? {} : { baseVersion }),
    })
  const decide = (proposalId: string, decision: "approve" | "reject") =>
    call(founder, "POST", `/v1/proposals/${proposalId}/decision`, { decision })

  // Propose, approve: version 1, found by search.
  const first = await propose(`Free, then $20 per seat. ${word}`)
  expect(first.status).toBe(200)
  expect(first.body.status).toBe("pending")
  const approved = await decide(first.body.proposalId, "approve")
  expect(approved.status).toBe(200)
  expect(approved.body).toMatchObject({ status: "approved", version: 1 })
  const entryId = approved.body.entryId as string
  const found = await call(founder, "POST", "/v1/search/entries", { query: word })
  expect(found.body.hits.map((h: { id: string }) => h.id)).toEqual([entryId])

  // An agent proposes against version 1; a founder edits to version 2 before looking at it.
  const stale = await propose(`Free, then $25 per seat. ${word}`, 1)
  expect(stale.status).toBe(200)
  const edit = await call(founder, "POST", `/v1/entries/${entryId}/versions`, {
    title: "Pricing",
    body: { text: `Free, then $30 per seat. ${word}` },
    baseVersion: 1,
  })
  expect(edit.status).toBe(200)
  expect(edit.body.version).toBe(2)

  // Approving the stale proposal fails on real Postgres, and writes nothing.
  const conflict = await decide(stale.body.proposalId, "approve")
  expect(conflict.status).toBe(409)
  expect(conflict.body.error.code).toBe("CONFLICT")
  const current = await call(founder, "GET", `/v1/entries/${entryId}`)
  expect(current.body).toMatchObject({ version: 2, latestVersion: 2 })
  expect(current.body.body.text).toContain("$30")
  const history = await call(founder, "GET", `/v1/entries/${entryId}/history`)
  expect(history.body.versions.map((v: { version: number }) => v.version)).toEqual([1, 2])
  const pending = await call(founder, "GET", "/v1/proposals?status=pending")
  expect(pending.body.proposals.map((p: { id: string }) => p.id)).toContain(stale.body.proposalId)
  // The search sees only the newest version.
  const newest = await call(founder, "POST", "/v1/search/entries", { query: "$30 seat" })
  expect(newest.body.hits.map((h: { id: string }) => h.id)).toContain(entryId)

  // A decided proposal is final; the stale one can still be rejected.
  expect((await decide(first.body.proposalId, "approve")).status).toBe(409)
  expect((await decide(stale.body.proposalId, "reject")).body).toEqual({ status: "rejected" })

  // Anyone can sign up, but a stranger is no founder: FORBIDDEN, reads included.
  const signUp = await fetch(new URL("/api/auth/sign-up/email", base), {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({
      name: "Stranger",
      email: `stranger.${Date.now()}@example.com`,
      password: "e2e stranger on the local stack",
    }),
  })
  expect(signUp.status).toBe(200)
  const stranger = cookieOf(signUp)
  for (const [method, path] of [
    ["GET", "/v1/entries"],
    ["GET", `/v1/entries/${entryId}`],
    ["GET", "/v1/proposals"],
  ] as const) {
    expect((await call(stranger, method, path)).status).toBe(403)
  }
})
