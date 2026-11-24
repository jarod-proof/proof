// @vitest-environment jsdom
// Companions of the Phase 3 approvals tests whose arrangement W18 touched (a quiet pipeline was
// passed to the fake, because the default board's needs-you cards are articles too). Each repeats
// the Phase 3 assertion with the default, NON-quiet board: the pipeline's cards sit in their own
// section and landmark, so the proposals' behaviour does not depend on the board being empty.
import { QueryClient } from "@tanstack/react-query"
import { fireEvent, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { Proposal } from "../api/schemas"
import { createFakeHq, type FakeHq } from "../test/fake-hq"
import { failOnce } from "../test/fail-once"
import { proposalFixture } from "../test/fixtures"
import { renderApp } from "../test/render"

type App = Awaited<ReturnType<typeof renderApp>>

const seeded = (count: number): Proposal[] =>
  Array.from({ length: count }, (_, index) =>
    proposalFixture({
      id: `proposal-${String(index + 1).padStart(3, "0")}`,
      title: `Proposal ${index + 1}`,
      createdAt: new Date(Date.UTC(2026, 10, 17, 9, 0, 0) - index * 60_000).toISOString(),
    }),
  )

const posts = (hq: FakeHq) => hq.sent.filter((s) => s.method !== "GET")
const listCalls = (hq: FakeHq) => hq.sent.filter((s) => s.path === "/v1/proposals")
const proposalsRegion = (app: App) => app.findByRole("region", { name: /Needs you/ })
const pipelineRegion = async (app: App) => {
  const region = await app.findByRole("region", { name: /From the pipeline/ })
  await waitFor(() => expect(within(region).queryByText(/^Loading /)).toBeNull())
  return region
}

describe("Approvals with the default (non-quiet) pipeline board", () => {
  it("a proposal of <img onerror> and a markdown link is plain text in its own article", async () => {
    const hq = createFakeHq({
      proposals: [
        proposalFixture({
          id: "evil-1",
          title: '<img src=x onerror="document.title=1">',
          reason: '[approve me](https://evil.example) <a href="https://evil.example">now</a>',
          body: {
            text: "<script>document.title=2</script>\n# heading\n[x](https://evil.example/x.png)",
          },
        }),
      ],
    })
    const app = await renderApp({ path: "/app/approvals", hq })
    const region = await proposalsRegion(app)
    const article = await within(region).findByRole("article")
    expect(article.querySelector("img, a, script, h1, h2, iframe")).toBeNull()
    expect(article.textContent).toContain('<img src=x onerror="document.title=1">')
    expect(article.textContent).toContain("[approve me](https://evil.example)")
    expect(article.textContent).toContain("<script>document.title=2</script>")
    expect(document.title).not.toBe("1")
    expect(document.title).not.toBe("2")
    expect(within(article).getByRole("button", { name: "Approve" })).toBeTruthy()
    // The pipeline's three cards are there, in the other landmark.
    expect(within(await pipelineRegion(app)).getAllByRole("article")).toHaveLength(3)
  })

  it("a 40,000-character body stays inside its card and Approve stays visible", async () => {
    const hq = createFakeHq({
      proposals: [proposalFixture({ body: { text: "word ".repeat(8000) } })],
    })
    const app = await renderApp({ path: "/app/approvals", hq })
    const article = await within(await proposalsRegion(app)).findByRole("article")
    expect(article.textContent?.length).toBeLessThan(5000)
    expect(within(article).getByRole("button", { name: "Approve" })).toBeTruthy()
    expect(within(article).getByRole("button", { name: "Show all" })).toBeTruthy()
    expect(within(await pipelineRegion(app)).getAllByRole("article")).toHaveLength(3)
  })

  it("with no proposal pending, Needs you says 'Nothing needs you' and holds no article; the pipeline's cards are elsewhere", async () => {
    const hq = createFakeHq({
      proposals: [proposalFixture({ status: "approved", decidedAt: "2026-11-17T10:00:00.000Z" })],
    })
    // Hold the proposals' pending list, so loading can be looked at (the pipeline's own
    // "Loading the pipeline" would satisfy a page-wide read, so it is scoped).
    const real = hq.fetch
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    hq.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith("/v1/proposals?status=pending")) await gate
      return real(input, init)
    }) as typeof fetch
    const app = await renderApp({ path: "/app/approvals", hq })
    expect(await within(await proposalsRegion(app)).findByText(/^Loading proposals/)).toBeTruthy()
    release()
    const region = await proposalsRegion(app)
    expect(await within(region).findByText("Nothing needs you")).toBeTruthy()
    expect(within(region).queryByRole("article")).toBeNull()
    expect(within(await pipelineRegion(app)).getAllByRole("article")).toHaveLength(3)
  })

  it("25 proposals and Load more: the proposals' region counts 25 then 30 articles, the header badge 25+ then 30", async () => {
    const hq = createFakeHq({ proposals: seeded(30) })
    const app = await renderApp({ path: "/app/approvals", hq })
    await within(await proposalsRegion(app)).findByRole("article", { name: "Proposal 1" })
    const region = await proposalsRegion(app)
    expect(within(region).getAllByRole("article")).toHaveLength(25)
    expect(region.querySelector("h2 span")?.textContent).toBe("25+")
    const firstPage = listCalls(hq).find((c) => c.search.includes("status=pending"))
    expect(firstPage?.search).toContain("limit=25")
    expect(firstPage?.search).not.toContain("cursor")
    expect(within(await pipelineRegion(app)).getAllByRole("article")).toHaveLength(3)
    await app.user.click(app.getByRole("button", { name: "Load more" }))
    await within(region).findByRole("article", { name: "Proposal 30" })
    expect(within(region).getAllByRole("article")).toHaveLength(30)
    expect(region.querySelector("h2 span")?.textContent).toBe("30")
    expect(app.queryByRole("button", { name: "Load more" })).toBeNull()
    expect(
      listCalls(hq).some(
        (c) => c.search.includes("status=pending") && c.search.includes("cursor="),
      ),
    ).toBe(true)
    expect(posts(hq)).toEqual([])
  })

  it("never calls a write on load, focus, visibility or retry: 3 proposals, 3 pipeline cards, every request a GET", async () => {
    const hq = createFakeHq({ proposals: seeded(3) })
    const app = await renderApp({ path: "/app/approvals", hq })
    await within(await proposalsRegion(app)).findByRole("article", { name: "Proposal 1" })
    await pipelineRegion(app)
    fireEvent.focus(window)
    fireEvent(document, new Event("visibilitychange"))
    fireEvent(window, new Event("online"))
    await app.queryClient.invalidateQueries({ queryKey: ["proposals"] })
    await app.queryClient.invalidateQueries({ queryKey: ["work"] })
    expect(within(await proposalsRegion(app)).getAllByRole("article")).toHaveLength(3)
    expect(within(await pipelineRegion(app)).getAllByRole("article")).toHaveLength(3)
    expect(posts(hq)).toEqual([])
    expect(hq.sent.every((s) => s.method === "GET")).toBe(true)
  })

  it("the screen's own reads are the proposals' lists and the work board, and the shell's three (the render.test.tsx list, with the board)", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/approvals", hq })
    await app.findByText("eve · last run 4h ago")
    await pipelineRegion(app)
    const paths = hq.sent.map((s) => s.path)
    expect(paths.filter((p) => p === "/v1/work/board")).toHaveLength(1)
    expect(paths.filter((p) => p !== "/v1/proposals" && p !== "/v1/work/board").sort()).toEqual([
      "/api/auth/get-session",
      "/v1/factory/status",
      "/v1/status",
    ])
  })

  it("a failed proposals list puts the alert in the proposals' Needs you section only; Retry brings the card back and sends no POST", async () => {
    const hq = createFakeHq({ proposals: seeded(1) })
    // Scoped to the proposals' list: a one-shot nextError would go to the board read first.
    failOnce(hq, "/v1/proposals?status=pending")
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const app = await renderApp({ path: "/app/digest", hq, queryClient })
    await app.findByRole("navigation", { name: "Primary" })
    await app.router.navigate({ to: "/approvals" })
    const region = await proposalsRegion(app)
    const alert = await within(region).findByRole("alert")
    expect(alert.textContent).toContain("hq had a problem")
    // The pipeline's section loaded on its own and holds no alert.
    const pipeline = await pipelineRegion(app)
    expect(within(pipeline).queryByRole("alert")).toBeNull()
    expect(within(pipeline).getAllByRole("article")).toHaveLength(3)
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }))
    expect(await within(region).findByRole("article", { name: "Proposal 1" })).toBeTruthy()
    expect(within(region).queryByRole("alert")).toBeNull()
    expect(posts(hq)).toEqual([])
  })
})
