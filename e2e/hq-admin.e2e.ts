import { test } from "@e2e-dev/web"
import { expect } from "e2e"

import { HQ_FOUNDER_EMAIL, HQ_FOUNDER_PASSWORD } from "./support/hq-stack"
import { uniqueId } from "./support/unique"

// hq's admin pages, in a browser (the `hq` target in e2e.config.ts): a founder signs in, approves a
// proposal in /admin/proposals, sees it leave the pending list, and finds the new version in the
// entry's history. Deterministic, no model. The other targets serve the product, so the test does
// nothing there.
test("a founder signs in, approves a proposal, and finds the version in the entry's history", async ({
  app,
  browser,
  screen,
}) => {
  if (!app.baseUrl) throw new Error("the app has no base URL")
  const base = app.baseUrl
  const product = await fetch(new URL("/v1/whoami", base))
  if (product.status === 401) return

  // Seed one pending proposal through the API, as an agent's would arrive (here: the founder's
  // session proposes; anyone may).
  const signIn = await fetch(new URL("/api/auth/sign-in/email", base), {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email: HQ_FOUNDER_EMAIL, password: HQ_FOUNDER_PASSWORD }),
  })
  expect(signIn.status).toBe(200)
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ")
  const word = uniqueId()
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
  const title = `Pricing ${word}`
  const text = `Free, then $20 per seat. ${word}`
  const proposed = await fetch(new URL("/v1/proposals", base), {
    method: "POST",
    headers: { cookie, origin: base, "content-type": "application/json" },
    body: JSON.stringify({
      kind: "fact",
      slug: `pricing-${word}`,
      title,
      body: { text },
      reason: "e2e",
    }),
  })
  expect(proposed.status).toBe(200)

  // Signed out, the page asks for sign-in and brings the founder back to it.
  await app.open("/admin/proposals")
  await expect(browser).toHaveURL(/\/admin\/login\?next=%2Fadmin%2Fproposals/)
  await screen.getByLabel("Email").fill(HQ_FOUNDER_EMAIL)
  await screen.getByLabel("Password").fill(HQ_FOUNDER_PASSWORD)
  await screen.getByRole("button", "Sign in").tap()
  await expect(screen.getByRole("heading", "Proposals")).toBeVisible()

  // Pending: the card has Approve and Reject; approving goes through decide_proposal.
  const card = screen.getByRole("article", `Proposal: ${title}`)
  await expect(card.getByText(text)).toBeVisible()
  await card.getByRole("button", "Approve").tap()

  // Gone from pending (no buttons left on it), decided, with a link to the history.
  await expect(screen.getByRole("heading", "Proposals")).toBeVisible()
  await expect(card.getByRole("button", "Approve")).not.toBeVisible()
  await expect(card).toContainText("approved")
  await card.getByRole("link", "History").tap()
  await expect(screen.getByRole("heading", title)).toBeVisible()
  await expect(screen.getByRole("article", "Version 1")).toContainText(text)
})
