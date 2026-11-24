import { test } from "@e2e-dev/web"
import { expect } from "e2e"

import {
  acceptanceSkip,
  appBase,
  assertAppIsHq,
  assertPageIsOnHq,
  claimRun,
  hqBase,
  need,
  runTag,
  signInThroughApp,
} from "./support"

// Phase 3 acceptance on a deployed org: the hq app's shell. The page is served by static files with
// its security headers (and a refused hq would still serve it), a visitor with no session lands on
// the app's own sign-in form, a wrong password says so, and the right one returns to the page that
// was asked for. Deterministic, no model, writes nothing: it signs in for itself (two sign-ins, see
// SIGN-INS in support.ts) and signs out at the end, so it never touches the session the other
// journeys share.
test("/app/digest signed out lands on the sign-in form, the sign-in returns to /app/digest, and the shell is served by static files with its security headers", {
  // The password is typed into the page: no trace, no video, so it is not recorded.
  timeout: 240_000,
  skip: acceptanceSkip,
  trace: "off",
  video: "off",
}, async ({ app, browser, screen }) => {
  claimRun("app-shell")
  assertAppIsHq(app)

  // The shell is a static file that refuses framing, and every path of the app answers with it.
  const shell = await fetch(`${appBase()}/approvals`)
  expect(shell.status).toBe(200)
  expect(shell.headers.get("content-type")).toMatch(/^text\/html/)
  expect(shell.headers.get("x-frame-options")).toBe("DENY")
  expect(shell.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
  expect(shell.headers.get("x-content-type-options")).toBe("nosniff")
  expect(shell.headers.get("referrer-policy")).toBe("same-origin")
  // hq's function is up behind it. The app is same-origin, so what /v1 answers to a page on another
  // origin carries no CORS header (a policy that echoes the origin sends nothing without one).
  const health = await fetch(`${hqBase()}/health`)
  expect(health.status).toBe(200)
  const status = await fetch(`${hqBase()}/v1/status`, {
    headers: { origin: "https://evil.example" },
  })
  expect(status.status).toBe(401)
  expect(status.headers.get("access-control-allow-origin")).toBeNull()
  expect(status.headers.get("access-control-allow-credentials")).toBeNull()

  // Signed out, the app asks for sign-in and remembers where the visitor was going.
  await app.open("/app/digest")
  await expect(browser).toHaveURL(/\/app\/sign-in\?next=%2Fdigest/)

  // A wrong password is refused in the form, which stays.
  await expect(screen.getByLabel("Email")).toBeVisible()
  await assertPageIsOnHq(browser)
  await screen.getByLabel("Email").fill(need("FOUNDER_EMAIL"))
  await screen.getByLabel("Password").fill(`not-the-password-${runTag()}`)
  await screen.getByRole("button", "Sign in").tap()
  await expect(screen.getByRole("alert")).toContainText("Wrong email or password.")
  await expect(browser).toHaveURL(/\/app\/sign-in\?next=%2Fdigest/)

  // The right one goes back to the page that was asked for.
  await signInThroughApp(screen, app, browser)
  await expect(screen.getByRole("heading", "Digest")).toBeVisible()
  await expect(browser).toHaveURL(/\/app\/digest$/)

  // Signing out returns to the form (this is the browser's own session, not the shared one).
  await screen.getByRole("button", "Sign out").tap()
  await expect(screen.getByLabel("Email")).toBeVisible()
  await expect(browser).toHaveURL(/\/app\/sign-in$/)
})
