// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createFakeHq, urlOf } from "../test/fake-hq"
import {
  digestFixture,
  digestPipelineFixture,
  factoryStatusFixture,
  proposalFixture,
} from "../test/fixtures"
import { renderApp } from "../test/render"

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

const digestCalls = (hq: ReturnType<typeof createFakeHq>) =>
  hq.sent.filter((s) => s.path === "/v1/digest")

/** A hq whose digest read fails with `status`, everything else as the fake answers. */
function failingDigest(hq: ReturnType<typeof createFakeHq>, status: number) {
  let failing = true
  const refused: string[] = []
  return {
    ...hq,
    /** The digest reads this wrapper refused (the underlying fake never sees them). */
    refused,
    stop: () => {
      failing = false
    },
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      if (failing && urlOf(input).startsWith("/v1/digest")) refused.push(urlOf(input))
      return failing && urlOf(input).startsWith("/v1/digest")
        ? Promise.resolve(
            new Response(
              JSON.stringify({ error: { code: "RATE_LIMITED", message: "slow down" } }),
              {
                status,
                headers: { "content-type": "application/json", "retry-after": "7" },
              },
            ),
          )
        : hq.fetch(input, init)
    }) as typeof fetch,
  }
}

describe("the Digest screen", () => {
  it("shows the digest from get_digest and the cap from get_factory_status", async () => {
    const hq = createFakeHq({
      digest: digestFixture({
        summary: { tone: "attention", runsFinished: 2, runsFailed: 1, pendingProposals: 1 },
      }),
      factoryStatus: factoryStatusFixture(),
    })
    const app = await renderApp({ path: "/app/digest", hq })
    const banner = await app.findByRole("status", { name: "Digest summary" })
    expect(banner.textContent).toContain("2 runs finished, 1 failed")
    const health = app.getByRole("region", { name: "Factory health" })
    expect(await app.findByText("62% left")).toBeTruthy()
    expect(health.textContent).toContain("Eve spend cap")
    // No since on the first read: hq picks the default window.
    expect(digestCalls(hq)[0]?.search).toBe("")
  })

  it("shows the seeded proposals as decisions with a link to Approvals", async () => {
    const hq = createFakeHq({
      proposals: [proposalFixture()],
      digest: digestFixture({
        summary: { tone: "quiet", runsFinished: 1, runsFailed: 0, pendingProposals: 2 },
      }),
    })
    const app = await renderApp({ path: "/app/digest", hq })
    await app.findByText("Why: Stated in the founders call")
    const link = app.getByRole("link", { name: "See all 2 in Approvals" })
    await app.user.click(link)
    expect(app.router.history.location.pathname).toBe("/app/approvals")
  })

  it("Mark as read stores readAt and the next fetch sends since=<readAt>", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/digest", hq })
    await app.user.click(await app.findByRole("button", { name: "Mark as read" }))

    // hq's own clock (the digest's `until`), so a skewed browser clock cannot send a future since.
    const until = hq.state.digest.until
    expect(window.localStorage.getItem("hq.digest.readAt")).toBe(until)
    await app.findByRole("button", { name: "Marked as read" })
    await vi.waitFor(() => expect(digestCalls(hq)).toHaveLength(2))
    expect(digestCalls(hq)[1]?.search).toBe(`?since=${encodeURIComponent(until)}`)
  })

  it("a stored marker is sent as since on the first read", async () => {
    window.localStorage.setItem("hq.digest.readAt", "2026-11-17T06:00:00.000Z")
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/digest", hq })
    await app.findByRole("status", { name: "Digest summary" })
    expect(digestCalls(hq)[0]?.search).toBe("?since=2026-11-17T06%3A00%3A00.000Z")
  })

  it("a stored marker that hq refuses (400) is cleared and the default window is fetched", async () => {
    // After the fixture's `until` (2026-11-17T12:00Z): the fake answers 400 as hq does.
    window.localStorage.setItem("hq.digest.readAt", "2026-11-18T00:00:00.000Z")
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/digest", hq })
    expect(await app.findByRole("status", { name: "Digest summary" })).toBeTruthy()
    expect(app.queryByRole("alert")).toBeNull()
    expect(window.localStorage.getItem("hq.digest.readAt")).toBeNull()
    const searches = digestCalls(hq).map((s) => s.search)
    expect(searches).toEqual(["?since=2026-11-18T00%3A00%3A00.000Z", ""])
    expect(app.getByRole("button", { name: "Mark as read" })).toBeTruthy()
  })

  it("a 400 with no stored marker is shown as an error and clears nothing", async () => {
    const base = createFakeHq()
    const hq = failingDigest(base, 400)
    const app = await renderApp({ path: "/app/digest", hq })
    expect(await app.findByRole("alert")).toBeTruthy()
    // Exactly one read, with no since, and no second one: nothing was cleared or retried.
    expect(hq.refused).toEqual(["/v1/digest"])
  })

  it("with localStorage throwing, the page renders and Mark as read does not crash", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/digest", hq })
    await app.user.click(await app.findByRole("button", { name: "Mark as read" }))
    await app.findByRole("button", { name: "Marked as read" })
    expect(app.getByRole("heading", { name: "Digest" })).toBeTruthy()
  })

  it("loading, then an error with Retry that asks again", async () => {
    const base = createFakeHq()
    const hq = failingDigest(base, 429)
    const app = await renderApp({ path: "/app/digest", hq })
    expect(await app.findByRole("alert")).toBeTruthy()
    expect(app.getByRole("alert").textContent).toContain("Try again in 7 seconds")
    hq.stop()
    await app.user.click(app.getByRole("button", { name: "Retry" }))
    expect(await app.findByRole("status", { name: "Digest summary" })).toBeTruthy()
  })

  it("shows a loading block while the digest is on its way", async () => {
    const hq = createFakeHq()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow = {
      ...hq,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (urlOf(input).startsWith("/v1/digest")) await gate
        return hq.fetch(input, init)
      }) as typeof fetch,
    }
    const app = await renderApp({ path: "/app/digest", hq: slow })
    expect(await app.findByText("Loading the digest")).toBeTruthy()
    release()
    await app.findByRole("status", { name: "Digest summary" })
  })

  it("a refused hq shows the gate's refusal panel, not the digest", async () => {
    const hq = createFakeHq({ caller: "refused" })
    const app = await renderApp({ path: "/app/digest", hq })
    expect(await app.findByText("hq refused to start")).toBeTruthy()
    expect(app.queryByRole("button", { name: "Mark as read" })).toBeNull()
  })

  it("a cap that cannot be read does not hide the digest", async () => {
    const hq = createFakeHq()
    const wrapped = {
      ...hq,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
        urlOf(input).startsWith("/v1/factory/status")
          ? Promise.resolve(
              new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "no" } }), {
                status: 403,
                headers: { "content-type": "application/json" },
              }),
            )
          : hq.fetch(input, init)) as typeof fetch,
    }
    const app = await renderApp({ path: "/app/digest", hq: wrapped })
    await app.findByRole("status", { name: "Digest summary" })
    expect(app.getByRole("region", { name: "Factory health" }).textContent).toContain("Unavailable")
  })

  it("has no accessibility violations", async () => {
    const app = await renderApp({ path: "/app/digest" })
    await app.findByRole("status", { name: "Digest summary" })
    await expectNoA11yViolations(app.container.innerHTML)
  })
})

describe("the Digest screen with the pipeline", () => {
  it("shows the pipeline's needs, merges and health from get_digest, with one GET and no write", async () => {
    const hq = createFakeHq({
      digest: digestFixture({
        summary: { tone: "quiet", runsFinished: 1, runsFailed: 0, pendingProposals: 1 },
        pipeline: digestPipelineFixture(),
      }),
    })
    const app = await renderApp({ path: "/app/digest", hq })
    const banner = await app.findByRole("status", { name: "Digest summary" })
    // 1 proposal plus the pipeline's 3
    expect(banner.textContent).toContain("4 need a decision")
    expect(app.getByRole("region", { name: "What changed in production" }).textContent).toContain(
      "Merged by the factory (deploy not observed)",
    )
    expect(app.getByRole("region", { name: "Factory health" }).textContent).toContain(
      "Stuck attempts0",
    )
    expect(digestCalls(hq)).toHaveLength(1)
    expect(hq.sent.every((s) => s.method === "GET")).toBe(true)
  })

  it("a hq without the work tables (pipeline null) shows the Phase 3 Digest", async () => {
    const hq = createFakeHq({ digest: digestFixture({ pipeline: null }) })
    const app = await renderApp({ path: "/app/digest", hq })
    await app.findByRole("status", { name: "Digest summary" })
    expect(app.queryByText("Stuck attempts")).toBeNull()
    expect(app.queryByText(/Merged by the factory/)).toBeNull()
  })
})
