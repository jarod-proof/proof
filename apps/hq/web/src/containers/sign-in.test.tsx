// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import { FAKE_PASSWORD, createFakeHq, urlOf } from "../test/fake-hq"
import { type RenderAppResult, renderApp } from "../test/render"

const EMAIL = "founder@example.com"

async function fill(app: RenderAppResult, password = FAKE_PASSWORD) {
  await app.user.type(await app.findByLabelText("Email"), EMAIL)
  await app.user.type(app.getByLabelText("Password"), password)
}

describe("the sign-in form", () => {
  it("wrong password shows 'Wrong email or password.'", async () => {
    const hq = createFakeHq({ caller: "signed-out" })
    const app = await renderApp({ path: "/app/sign-in", hq })
    await fill(app, "nope")
    await app.user.click(app.getByRole("button", { name: "Sign in" }))
    expect((await app.findByRole("alert")).textContent).toBe("Wrong email or password.")
    expect(app.router.history.location.pathname).toBe("/app/sign-in")
  })

  it("429 shows 'Too many attempts. Try again in 42 seconds.'", async () => {
    const hq = createFakeHq({ caller: "signed-out" })
    hq.state.nextError = {
      status: 429,
      body: { message: "Too many requests. Please try again later." },
    }
    const original = hq.fetch
    // The real limiter names the wait in a header; give the one-off error that header.
    hq.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await original(input, init)
      if (res.status !== 429) return res
      return new Response(await res.text(), {
        status: 429,
        headers: { "content-type": "application/json", "x-retry-after": "42" },
      })
    }) as typeof fetch
    const app = await renderApp({ path: "/app/sign-in", hq })
    await fill(app)
    await app.user.click(app.getByRole("button", { name: "Sign in" }))
    expect((await app.findByRole("alert")).textContent).toBe(
      "Too many attempts. Try again in 42 seconds.",
    )
  })

  it("a network failure shows 'Could not reach the server.'", async () => {
    const hq = createFakeHq({ caller: "signed-out" })
    const original = hq.fetch
    hq.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input)
      if (url.includes("/sign-in/email")) throw new TypeError("fetch failed")
      return original(input, init)
    }) as typeof fetch
    const app = await renderApp({ path: "/app/sign-in", hq })
    await fill(app)
    await app.user.click(app.getByRole("button", { name: "Sign in" }))
    expect((await app.findByRole("alert")).textContent).toContain("Could not reach the server.")
  })

  it("the submit button is disabled while pending and sends one request on a double click", async () => {
    const hq = createFakeHq({ caller: "signed-out" })
    const original = hq.fetch
    let signInCalls = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    hq.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (urlOf(input).includes("/sign-in/email")) {
        signInCalls += 1
        await gate
      }
      return original(input, init)
    }) as typeof fetch
    const app = await renderApp({ path: "/app/sign-in", hq })
    await fill(app)
    const button = app.getByRole("button", { name: "Sign in" }) as HTMLButtonElement
    await app.user.dblClick(button)
    expect(signInCalls).toBe(1)
    expect((app.getByRole("button", { name: /Sign(ing)? in/ }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    release()
    await app.findByRole("heading", { name: "Digest" })
    expect(hq.sent.filter((s) => s.path === "/api/auth/sign-in/email")).toHaveLength(1)
  })

  // Nothing clears the caches after a failed sign-in, so a password kept in a mutation's variables
  // or a query key would still be there: this is the dump that can fail.
  const dumpOf = (app: RenderAppResult) =>
    JSON.stringify([
      app.router.history.location.href,
      app.queryClient
        .getQueryCache()
        .getAll()
        .map((q) => [q.queryKey, q.state]),
      app.queryClient
        .getMutationCache()
        .getAll()
        .map((m) => [m.options.mutationKey, m.state]),
    ])

  it("password is never written to the URL or the query cache after a failed sign-in", async () => {
    const wrong = "a wrong password nobody uses"
    const hq = createFakeHq({ caller: "signed-out" })
    const app = await renderApp({ path: "/app/sign-in", hq })
    await fill(app, wrong)
    await app.user.click(app.getByRole("button", { name: "Sign in" }))
    expect((await app.findByRole("alert")).textContent).toBe("Wrong email or password.")
    expect(hq.sent.some((s) => s.path === "/api/auth/sign-in/email")).toBe(true)
    expect(dumpOf(app)).not.toContain(wrong)
    expect(app.router.history.location.search).not.toContain("password")
  })

  it("password is never written to the URL or the query cache after a signed-in sign-in", async () => {
    const hq = createFakeHq({ caller: "signed-out" })
    const app = await renderApp({ path: "/app/sign-in", hq })
    await fill(app)
    await app.user.click(app.getByRole("button", { name: "Sign in" }))
    await app.findByRole("heading", { name: "Digest" })
    expect(dumpOf(app)).not.toContain(FAKE_PASSWORD)
    expect(app.router.history.location.search).not.toContain("password")
  })

  it("lands on the path asked for, and ignores a next that leaves the app", async () => {
    const hq = createFakeHq({ caller: "signed-out" })
    const good = await renderApp({ path: "/app/sign-in?next=%2Frunner", hq })
    await fill(good)
    await good.user.click(good.getByRole("button", { name: "Sign in" }))
    await good.findByRole("heading", { level: 1, name: "Runner and policy" })
    expect(good.router.history.location.pathname).toBe("/app/runner")
    good.unmount()

    const bad = await renderApp({
      path: "/app/sign-in?next=%2F%2Fevil.example",
      hq: createFakeHq({ caller: "signed-out" }),
    })
    await fill(bad)
    await bad.user.click(bad.getByRole("button", { name: "Sign in" }))
    await bad.findByRole("heading", { name: "Digest" })
    expect(bad.router.history.location.pathname).toBe("/app/digest")
  })

  it("a non-founder who signs in sees the explanation, not the screens", async () => {
    const hq = createFakeHq({ caller: "signed-out", signInAs: "non-founder" })
    const app = await renderApp({ path: "/app/sign-in", hq })
    await fill(app)
    await app.user.click(app.getByRole("button", { name: "Sign in" }))
    expect(await app.findByText("Founders only")).toBeTruthy()
    expect(app.queryByRole("navigation", { name: "Primary" })).toBeNull()
  })

  it("sends the sign-in as JSON with same-origin credentials", async () => {
    const hq = createFakeHq({ caller: "signed-out" })
    const app = await renderApp({ path: "/app/sign-in", hq })
    await fill(app)
    await app.user.click(app.getByRole("button", { name: "Sign in" }))
    await app.findByRole("heading", { name: "Digest" })
    const sent = hq.sent.find((s) => s.path === "/api/auth/sign-in/email")
    expect(sent?.method).toBe("POST")
    expect(sent?.credentials).toBe("same-origin")
    expect(sent?.body).toEqual({ email: EMAIL, password: FAKE_PASSWORD })
  })
})
