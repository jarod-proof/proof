import { test } from "@e2e-dev/web"
import { expect } from "e2e"

import { HQ_FOUNDER_EMAIL, HQ_FOUNDER_PASSWORD } from "./support/hq-stack"

// The hq app (apps/hq/web, served at /app by the `hq` target in e2e.config.ts), in a browser: a
// signed-out visit is sent to the sign-in form and back, the founder lands on the Digest, opens
// Approvals and signs out to the form. Deterministic, no model. The other targets serve the product,
// so the test does nothing there. This file is not in `e2e:hq` (its script lives in a patch target):
// run it by name, `pnpm exec e2e run e2e/hq-app.e2e.ts --target hq`.
test("a founder signs in at /app, sees Digest, opens Approvals and signs out", async ({
  app,
  browser,
  screen,
}) => {
  if (!app.baseUrl) throw new Error("the app has no base URL")
  const product = await fetch(new URL("/v1/whoami", app.baseUrl))
  if (product.status === 401) return

  // Signed out, the app asks for sign-in and remembers where the visitor was going.
  await app.open("/app/digest")
  await expect(browser).toHaveURL(/\/app\/sign-in\?next=%2Fdigest/)
  await screen.getByLabel("Email").fill(HQ_FOUNDER_EMAIL)
  await screen.getByLabel("Password").fill(HQ_FOUNDER_PASSWORD)
  await screen.getByRole("button", "Sign in").tap()

  await expect(screen.getByRole("heading", "Digest")).toBeVisible()
  await expect(browser).toHaveURL(/\/app\/digest$/)
  await screen.getByRole("link", "Approvals").tap()
  await expect(screen.getByRole("heading", "Approvals")).toBeVisible()
  await expect(browser).toHaveURL(/\/app\/approvals$/)

  await screen.getByRole("button", "Sign out").tap()
  await expect(screen.getByLabel("Email")).toBeVisible()
  await expect(browser).toHaveURL(/\/app\/sign-in$/)
})
