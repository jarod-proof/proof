// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { QueryClient } from "@tanstack/react-query"
import { act, fireEvent, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { Proposal } from "../api/schemas"
import { createFakeHq, type FakeHq } from "../test/fake-hq"
import { proposalFixture } from "../test/fixtures"
import { renderApp } from "../test/render"

const ALREADY = "Already decided. Refresh to see the result."

const seeded = (count: number): Proposal[] =>
  Array.from({ length: count }, (_, index) =>
    proposalFixture({
      id: `proposal-${String(index + 1).padStart(3, "0")}`,
      title: `Proposal ${index + 1}`,
      // Newest first by createdAt: proposal 1 is the newest.
      createdAt: new Date(Date.UTC(2026, 10, 17, 9, 0, 0) - index * 60_000).toISOString(),
    }),
  )

const posts = (hq: FakeHq) => hq.sent.filter((s) => s.method !== "GET")
const listCalls = (hq: FakeHq) => hq.sent.filter((s) => s.path === "/v1/proposals")
const statusCalls = (hq: FakeHq) => hq.sent.filter((s) => s.path === "/v1/factory/status")

/** `count` proposals decided on a later day than any decision the fake makes itself. */
const decidedLater = (count: number): Proposal[] =>
  Array.from({ length: count }, (_, index) =>
    proposalFixture({
      id: `later-${String(index).padStart(2, "0")}`,
      title: `Later ${index}`,
      status: "approved",
      entryId: `entry-later-${index}`,
      createdAt: new Date(Date.UTC(2026, 10, 18, 9, index)).toISOString(),
      decidedAt: new Date(Date.UTC(2026, 10, 20, 9, index)).toISOString(),
    }),
  )

/** Hold every POST until `release()`, so a test can look at the screen mid-request. */
function holdPosts(hq: FakeHq): { release(): void } {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const real = hq.fetch
  hq.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() === "POST") await gate
    return real(input, init)
  }) as typeof fetch
  return { release }
}

const card = (view: Awaited<ReturnType<typeof renderApp>>, title: string) =>
  view.findByRole("article", { name: title })

describe("the Approvals screen", () => {
  it("lists pending proposals as Needs you cards with id, kind, title, reason, Approve and Reject", async () => {
    const hq = createFakeHq({
      proposals: [
        proposalFixture({ id: "abcdef0123456789", kind: "voice", title: "Tone of voice" }),
      ],
    })
    const app = await renderApp({ path: "/app/approvals", hq })
    const article = await card(app, "Tone of voice")
    expect(within(article).getByText("abcdef01 · proposal · voice")).toBeTruthy()
    expect(within(article).getByText("Stated in the founders call")).toBeTruthy()
    expect(within(article).getByText("Free, then $20 per seat.")).toBeTruthy()
    expect(within(article).getByRole("button", { name: "Approve" })).toBeTruthy()
    expect(within(article).getByRole("button", { name: "Reject" })).toBeTruthy()
    expect(app.getByRole("region", { name: /Needs you/ })).toBeTruthy()
    // Only reads on load.
    expect(posts(hq)).toEqual([])
  })

  it("approving sends exactly one POST /v1/proposals/<id>/decision and the card moves to Recently decided", async () => {
    const hq = createFakeHq({ proposals: seeded(2) })
    const app = await renderApp({ path: "/app/approvals", hq })
    const first = await card(app, "Proposal 1")
    await app.user.click(within(first).getByRole("button", { name: "Approve" }))

    const decided = await app.findByRole("region", { name: /Recently decided/ })
    expect(await within(decided).findByText("Proposal 1")).toBeTruthy()
    expect(within(decided).getByText("Approved")).toBeTruthy()
    expect(app.queryByRole("article", { name: "Proposal 1" })).toBeNull()
    expect(app.getByRole("article", { name: "Proposal 2" })).toBeTruthy()

    expect(posts(hq)).toEqual([
      {
        method: "POST",
        path: "/v1/proposals/proposal-001/decision",
        search: "",
        body: { decision: "approve" },
        credentials: "same-origin",
      },
    ])
    expect(
      within(decided)
        .getByRole("link", { name: /History/ })
        .getAttribute("href"),
    ).toBe("/admin/entries/entry-proposal-001")
  })

  it("rejecting with a note sends the note", async () => {
    const hq = createFakeHq({ proposals: seeded(1) })
    const app = await renderApp({ path: "/app/approvals", hq })
    const first = await card(app, "Proposal 1")
    await app.user.type(within(first).getByLabelText("Note (optional)"), "not now")
    await app.user.click(within(first).getByRole("button", { name: "Reject" }))

    const decided = await app.findByRole("region", { name: /Recently decided/ })
    expect(await within(decided).findByText("Rejected")).toBeTruthy()
    expect(posts(hq).map((s) => s.body)).toEqual([{ decision: "reject", note: "not now" }])
    expect(within(decided).queryByRole("link", { name: /History/ })).toBeNull()
  })

  it("two quick clicks on Approve send one request and the buttons are disabled while it runs", async () => {
    const hq = createFakeHq({ proposals: seeded(1) })
    const hold = holdPosts(hq)
    const app = await renderApp({ path: "/app/approvals", hq })
    const first = await card(app, "Proposal 1")
    const approve = within(first).getByRole("button", { name: "Approve" })
    await app.user.dblClick(approve)

    expect((approve as HTMLButtonElement).disabled).toBe(true)
    expect(
      (within(first).getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(first.getAttribute("aria-busy")).toBe("true")
    await app.user.click(approve)
    hold.release()

    await within(await app.findByRole("region", { name: /Recently decided/ })).findByText(
      "Proposal 1",
    )
    expect(posts(hq)).toHaveLength(1)
  })

  it("decisions on two cards are independent: each has its own pending state and request", async () => {
    const hq = createFakeHq({ proposals: seeded(2) })
    const hold = holdPosts(hq)
    const app = await renderApp({ path: "/app/approvals", hq })
    const one = await card(app, "Proposal 1")
    const two = await card(app, "Proposal 2")
    await app.user.click(within(one).getByRole("button", { name: "Approve" }))
    expect(
      (within(two).getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled,
    ).toBe(false)
    await app.user.click(within(two).getByRole("button", { name: "Reject" }))
    hold.release()

    const decided = await app.findByRole("region", { name: /Recently decided/ })
    await within(decided).findByText("Proposal 2")
    await within(decided).findByText("Proposal 1")
    expect(posts(hq).map((s) => `${s.path} ${JSON.stringify(s.body)}`)).toEqual([
      '/v1/proposals/proposal-001/decision {"decision":"approve"}',
      '/v1/proposals/proposal-002/decision {"decision":"reject"}',
    ])
  })

  it("a 409 on a proposal someone else decided says 'Already decided. Refresh to see the result.' and refetches", async () => {
    const hq = createFakeHq({ proposals: seeded(1) })
    const app = await renderApp({ path: "/app/approvals", hq })
    const first = await card(app, "Proposal 1")
    // Decided elsewhere (Slack, /admin) after this screen loaded: the card is stale.
    const stored = hq.state.proposals[0] as Proposal
    stored.status = "approved"
    stored.decidedAt = "2026-11-17T10:00:00.000Z"
    stored.entryId = "entry-1"
    const before = listCalls(hq).length
    await app.user.click(within(first).getByRole("button", { name: "Reject" }))

    const decided = await app.findByRole("region", { name: /Recently decided/ })
    expect(await within(decided).findByText("Proposal 1")).toBeTruthy()
    expect((await within(decided).findByRole("alert")).textContent).toBe(ALREADY)
    expect(listCalls(hq).length).toBeGreaterThan(before)
    expect(posts(hq)).toHaveLength(1)
    expect(app.queryByRole("article", { name: "Proposal 1" })).toBeNull()
  })

  it("a 409 for a moved-on entry shows hq's own message, not 'Already decided', and refetches", async () => {
    const hq = createFakeHq({ proposals: seeded(1) })
    const app = await renderApp({ path: "/app/approvals", hq })
    const first = await card(app, "Proposal 1")
    hq.state.nextError = {
      status: 409,
      body: {
        error: {
          code: "CONFLICT",
          message:
            "The entry is at version 3 but the proposal was made against 2: nothing was written",
          hint: "Reject it, or ask the proposer to propose again against the current version.",
        },
      },
    }
    const before = listCalls(hq).length
    await app.user.click(within(first).getByRole("button", { name: "Approve" }))

    const alert = await within(first).findByRole("alert")
    expect(alert.textContent).toContain("The entry is at version 3")
    expect(alert.textContent).not.toContain("Already decided")
    expect(listCalls(hq).length).toBeGreaterThan(before)
    expect(
      (within(first).getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it("a 409 for a stale card whose decided row is not on the page still says so, on the page", async () => {
    const hq = createFakeHq({ proposals: [...seeded(1), ...decidedLater(21)] })
    const app = await renderApp({ path: "/app/approvals", hq })
    const first = await card(app, "Proposal 1")
    const stored = hq.state.proposals.find((p) => p.id === "proposal-001") as Proposal
    stored.status = "approved"
    stored.decidedAt = "2026-11-17T10:00:00.000Z"
    stored.entryId = "entry-1"
    await app.user.click(within(first).getByRole("button", { name: "Reject" }))

    const notice = await app.findByRole("alert")
    expect(notice.textContent).toContain("Already decided. Refresh to see the result.")
    expect(notice.textContent).toContain("Proposal 1")
    // The card is gone and the stale proposal is not among the 20 newest decisions.
    expect(app.queryByRole("article", { name: "Proposal 1" })).toBeNull()
    const decided = app.getByRole("region", { name: /Recently decided/ })
    expect(within(decided).queryByText("Proposal 1")).toBeNull()
    expect(within(decided).getAllByRole("listitem")).toHaveLength(20)

    await app.user.click(within(notice).getByRole("button", { name: "Dismiss" }))
    expect(app.queryByRole("alert")).toBeNull()
  })

  it("a decision made on a card that has no decided row afterwards is confirmed on the page", async () => {
    const hq = createFakeHq({ proposals: [...seeded(1), ...decidedLater(21)] })
    const app = await renderApp({ path: "/app/approvals", hq })
    const first = await card(app, "Proposal 1")
    await app.user.click(within(first).getByRole("button", { name: "Approve" }))

    const needs = await app.findByRole("region", { name: /Needs you/ })
    expect((await within(needs).findByRole("status")).textContent).toBe(
      "Proposal 1: Approved.Dismiss",
    )
    expect(app.queryByRole("article", { name: "Proposal 1" })).toBeNull()
  })

  it("a 409 because the new entry's slug was taken shows hq's own message", async () => {
    const hq = createFakeHq({ proposals: seeded(1) })
    const app = await renderApp({ path: "/app/approvals", hq })
    const first = await card(app, "Proposal 1")
    hq.state.nextError = {
      status: 409,
      body: {
        error: {
          code: "CONFLICT",
          message: 'A fact entry "pricing" already exists',
          hint: "Propose a change to the existing entry with its current baseVersion instead.",
        },
      },
    }
    await app.user.click(within(first).getByRole("button", { name: "Approve" }))
    const alert = await within(first).findByRole("alert")
    expect(alert.textContent).toBe('A fact entry "pricing" already exists')
    expect(alert.textContent).not.toContain("Already decided")
  })

  it("two clicks in the same tick send one request (the guard does not wait for a re-render)", async () => {
    const hq = createFakeHq({ proposals: seeded(1) })
    const hold = holdPosts(hq)
    const app = await renderApp({ path: "/app/approvals", hq })
    const first = await card(app, "Proposal 1")
    const approve = within(first).getByRole("button", { name: "Approve" })
    const reject = within(first).getByRole("button", { name: "Reject" })
    // One act: React re-renders (and disables the buttons) only after all three have landed.
    act(() => {
      fireEvent.click(approve)
      fireEvent.click(approve)
      fireEvent.click(reject)
    })
    hold.release()
    await within(await app.findByRole("region", { name: /Recently decided/ })).findByText(
      "Proposal 1",
    )
    expect(posts(hq)).toHaveLength(1)
    expect(posts(hq)[0]?.body).toEqual({ decision: "approve" })
  })

  it("a 403 shows the server's message and leaves the card", async () => {
    const hq = createFakeHq({ proposals: seeded(1) })
    const app = await renderApp({ path: "/app/approvals", hq })
    const first = await card(app, "Proposal 1")
    // The account lost founder status after the screen loaded: hq's own refusal comes back.
    hq.state.caller = "non-founder"
    const before = listCalls(hq).length
    await app.user.click(within(first).getByRole("button", { name: "Approve" }))

    expect((await within(first).findByRole("alert")).textContent).toBe(
      "This brain is for the organization's founders",
    )
    expect(app.getByRole("article", { name: "Proposal 1" })).toBeTruthy()
    expect(listCalls(hq).length).toBe(before)
    expect(posts(hq)).toHaveLength(1)
    // The card is usable again: the server decides, never the client.
    expect(
      (within(first).getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })

  it("a write from a non-canonical host says to open the app on the canonical host", async () => {
    const hq = createFakeHq({ proposals: seeded(1) })
    const app = await renderApp({ path: "/app/approvals", hq })
    const first = await card(app, "Proposal 1")
    hq.state.nextError = {
      status: 403,
      body: {
        error: {
          code: "FORBIDDEN",
          message: "A signed-in write must come from a trusted origin",
          hint: "Agents and scripts authenticate with an API key or OAuth access token.",
        },
      },
    }
    await app.user.click(within(first).getByRole("button", { name: "Approve" }))
    expect((await within(first).findByRole("alert")).textContent).toContain("canonical host")
  })

  it("a 404, a 5xx and an unreachable hq each say so on the card, and nothing is retried", async () => {
    const hq = createFakeHq({ proposals: seeded(1) })
    let offline = false
    const real = hq.fetch
    hq.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      offline ? Promise.reject(new TypeError("offline")) : real(input, init)) as typeof fetch
    const app = await renderApp({ path: "/app/approvals", hq })
    const first = await card(app, "Proposal 1")
    const approve = () => within(first).getByRole("button", { name: "Approve" })

    hq.state.nextError = {
      status: 404,
      body: { error: { code: "NOT_FOUND", message: "Proposal not found" } },
    }
    await app.user.click(approve())
    expect((await within(first).findByRole("alert")).textContent).toContain("Not found")

    hq.state.nextError = {
      status: 500,
      body: { error: { code: "INTERNAL", message: "Internal error" } },
    }
    await app.user.click(approve())
    await within(first).findByText(/hq had a problem/)

    // The 5xx was sent once: no automatic second POST.
    expect(posts(hq)).toHaveLength(2)

    offline = true
    await app.user.click(approve())
    await within(first).findByText(/Could not reach the server/)
    expect(posts(hq)).toHaveLength(2)
  })

  it("a 401 on a decision sends the app to sign-in", async () => {
    const hq = createFakeHq({ proposals: seeded(1) })
    const app = await renderApp({ path: "/app/approvals", hq })
    const first = await card(app, "Proposal 1")
    hq.state.caller = "signed-out"
    await app.user.click(within(first).getByRole("button", { name: "Approve" }))
    expect(await app.findByLabelText("Email")).toBeTruthy()
    expect(posts(hq)).toHaveLength(1)
  })

  it("renders a proposal whose title, reason and body are <img onerror> and a markdown link as plain text", async () => {
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
    const article = await app.findByRole("article")
    expect(article.querySelector("img, a, script, h1, h2, iframe")).toBeNull()
    expect(article.textContent).toContain('<img src=x onerror="document.title=1">')
    expect(article.textContent).toContain("[approve me](https://evil.example)")
    expect(article.textContent).toContain("<script>document.title=2</script>")
    expect(document.title).not.toBe("1")
    expect(document.title).not.toBe("2")
    expect(within(article).getByRole("button", { name: "Approve" })).toBeTruthy()
  })

  it("a 40,000-character body stays inside its card and Approve stays visible", async () => {
    const hq = createFakeHq({
      proposals: [proposalFixture({ body: { text: "word ".repeat(8000) } })],
    })
    const app = await renderApp({ path: "/app/approvals", hq })
    const article = await app.findByRole("article")
    expect(article.textContent?.length).toBeLessThan(5000)
    expect(within(article).getByRole("button", { name: "Approve" })).toBeTruthy()
    expect(within(article).getByRole("button", { name: "Show all" })).toBeTruthy()
  })

  it("loading shows a LoadingBlock, then 'Nothing needs you' when no proposal is pending", async () => {
    const hq = createFakeHq({
      proposals: [proposalFixture({ status: "approved", decidedAt: "2026-11-17T10:00:00.000Z" })],
    })
    const app = await renderApp({ path: "/app/approvals", hq })
    expect(app.getAllByText(/^Loading /).length).toBeGreaterThan(0)
    expect(await app.findByText("Nothing needs you")).toBeTruthy()
    expect(app.queryByRole("article")).toBeNull()
  })

  it("a failed list shows the ErrorBlock with Retry, which asks again and sends no POST", async () => {
    const hq = createFakeHq({ proposals: seeded(1) })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const app = await renderApp({ path: "/app/digest", hq, queryClient })
    await app.findByRole("navigation", { name: "Primary" })
    hq.state.nextError = {
      status: 500,
      body: { error: { code: "INTERNAL", message: "Internal error" } },
    }
    await app.router.navigate({ to: "/approvals" })
    const alert = await app.findByRole("alert")
    expect(alert.textContent).toContain("hq had a problem")
    await app.user.click(within(alert).getByRole("button", { name: "Retry" }))
    expect(await app.findByRole("article", { name: "Proposal 1" })).toBeTruthy()
    expect(posts(hq)).toEqual([])
  })

  it("nextCursor shows Load more and fetches the next page with the cursor", async () => {
    const hq = createFakeHq({ proposals: seeded(30) })
    const app = await renderApp({ path: "/app/approvals", hq })
    await card(app, "Proposal 1")
    expect(app.getAllByRole("article")).toHaveLength(25)
    const firstPage = listCalls(hq).find((s) => s.search.includes("status=pending"))
    expect(firstPage?.search).toContain("limit=25")
    expect(firstPage?.search).not.toContain("cursor")
    // The badge counts what is loaded: with a next page it says so instead of undercounting.
    expect(
      app.getByRole("region", { name: /Needs you/ }).querySelector("h2 span")?.textContent,
    ).toBe("25+")

    await app.user.click(app.getByRole("button", { name: "Load more" }))
    await card(app, "Proposal 30")
    expect(app.getAllByRole("article")).toHaveLength(30)
    expect(
      app.getByRole("region", { name: /Needs you/ }).querySelector("h2 span")?.textContent,
    ).toBe("30")
    expect(app.queryByRole("button", { name: "Load more" })).toBeNull()
    expect(
      listCalls(hq).some(
        (s) => s.search.includes("status=pending") && s.search.includes("cursor="),
      ),
    ).toBe(true)
    expect(posts(hq)).toEqual([])
  })

  it("deciding invalidates proposals and factoryStatus: both are fetched again", async () => {
    const hq = createFakeHq({ proposals: seeded(1) })
    const app = await renderApp({ path: "/app/approvals", hq })
    const first = await card(app, "Proposal 1")
    // The sidebar's runner card observes factoryStatus: wait for its first read.
    await waitFor(() => expect(statusCalls(hq).length).toBeGreaterThan(0))
    const listsBefore = listCalls(hq).length
    const statusBefore = statusCalls(hq).length

    await app.user.click(within(first).getByRole("button", { name: "Approve" }))
    await within(await app.findByRole("region", { name: /Recently decided/ })).findByText(
      "Proposal 1",
    )
    await waitFor(() => expect(statusCalls(hq).length).toBeGreaterThan(statusBefore))
    expect(listCalls(hq).length).toBeGreaterThan(listsBefore)
  })

  it("never calls decide on load, focus, visibility or retry", async () => {
    const hq = createFakeHq({ proposals: seeded(3) })
    const app = await renderApp({ path: "/app/approvals", hq })
    await card(app, "Proposal 1")
    fireEvent.focus(window)
    fireEvent(document, new Event("visibilitychange"))
    fireEvent(window, new Event("online"))
    await app.queryClient.invalidateQueries({ queryKey: ["proposals"] })
    expect(app.getAllByRole("article")).toHaveLength(3)
    expect(posts(hq)).toEqual([])
    // Every request the screen made is a GET.
    expect(hq.sent.every((s) => s.method === "GET")).toBe(true)
  })

  it("Recently decided shows the last 20 decided, newest decision first", async () => {
    const decided = Array.from({ length: 24 }, (_, index) =>
      proposalFixture({
        id: `done-${String(index).padStart(2, "0")}`,
        title: `Done ${index}`,
        status: index % 2 === 0 ? "approved" : "rejected",
        entryId: index % 2 === 0 ? `entry-${index}` : null,
        createdAt: new Date(Date.UTC(2026, 10, 1, 9, index)).toISOString(),
        decidedAt: new Date(Date.UTC(2026, 10, 10, 9, index)).toISOString(),
      }),
    )
    const hq = createFakeHq({ proposals: decided })
    const app = await renderApp({ path: "/app/approvals", hq })
    const region = await app.findByRole("region", { name: /Recently decided/ })
    const rows = await within(region).findAllByRole("listitem")
    expect(rows).toHaveLength(20)
    expect(rows[0]?.textContent).toContain("Done 23")
    expect(rows[19]?.textContent).toContain("Done 4")
    expect(within(region).queryByText("Done 3")).toBeNull()
  })

  it("renders no inline style, no Pause all agents, and no a11y violations", async () => {
    const hq = createFakeHq({
      proposals: [
        ...seeded(2),
        proposalFixture({
          id: "done-1",
          title: "Old",
          status: "approved",
          entryId: "e1",
          decidedAt: "2026-11-10T09:00:00.000Z",
        }),
      ],
    })
    const app = await renderApp({ path: "/app/approvals", hq })
    await card(app, "Proposal 1")
    await within(await app.findByRole("region", { name: /Recently decided/ })).findByText("Old")
    expect(app.container.querySelector("[style]")).toBeNull()
    expect(app.container.textContent).not.toMatch(/pause all/i)
    await expectNoA11yViolations(app.container.innerHTML)
  })
})
