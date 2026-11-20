import { test } from "@e2e-dev/web"
import { expect } from "e2e"

import { HQ_FOUNDER_EMAIL, HQ_FOUNDER_PASSWORD } from "./support/hq-stack"

// An API test of apps/hq (the `hq` target in e2e.config.ts): no model, no page. The other targets
// serve the product's web app and API, so the test does nothing there.
test("hq answers GET /v1/status for a signed-in founder", async ({ app }) => {
  if (!app.baseUrl) throw new Error("the app has no base URL")
  // The desktop and phone targets serve the product API, which has /v1/whoami (hq has no such
  // route): nothing to check there. Anything else is taken for hq, so an hq that breaks fails
  // below instead of passing here.
  const product = await fetch(new URL("/v1/whoami", app.baseUrl))
  if (product.status === 401) return

  // The hq stack seeds one founder (scripts/e2e-hq-stack.mjs); a fresh sign-up is no founder.
  const signIn = await fetch(new URL("/api/auth/sign-in/email", app.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", origin: app.baseUrl },
    body: JSON.stringify({ email: HQ_FOUNDER_EMAIL, password: HQ_FOUNDER_PASSWORD }),
  })
  expect(signIn.status).toBe(200)
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ")

  const response = await fetch(new URL("/v1/status", app.baseUrl), { headers: { cookie } })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, version: expect.any(String) })
})
