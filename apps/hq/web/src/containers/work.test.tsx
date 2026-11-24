// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { act, fireEvent, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { WorkBoard, WorkItemSummary } from "../api/schemas"
import { createFakeHq, type FakeHq } from "../test/fake-hq"
import { WORK_HEAD_SHA, WORK_IDS, workBoardFixture, workSummaryFixture } from "../test/fixtures"
import { renderApp } from "../test/render"

type App = Awaited<ReturnType<typeof renderApp>>

const posts = (hq: FakeHq) => hq.sent.filter((s) => s.method !== "GET")
const boardReads = (hq: FakeHq) => hq.sent.filter((s) => s.path === "/v1/work/board")
const listReads = (hq: FakeHq) => hq.sent.filter((s) => s.path === "/v1/work-items")

/** Hold every POST until `release()`, so a test can look at the screen mid-request. */
function holdPosts(hq: FakeHq): { release(): void; reached(): number } {
  let release = () => {}
  let reached = 0
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const real = hq.fetch
  hq.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? "GET").toUpperCase() === "POST") {
      reached += 1
      await gate
    }
    return real(input, init)
  }) as typeof fetch
  return { release, reached: () => reached }
}

const needsYou = (app: App) => app.findByRole("region", { name: /Needs you/ })
const card = async (app: App, title: string) =>
  within(await needsYou(app)).getByRole("article", { name: title })
/** The card has left Needs you (the board's own card for the item may still be in a column). */
const leaves = (app: App, title: string) =>
  waitFor(() =>
    expect(
      within(app.getByRole("region", { name: /Needs you/ })).queryByRole("article", {
        name: title,
      }),
    ).toBeNull(),
  )

const MERGE_TITLE = "Empty cart crashes the checkout"
const QUESTION_TITLE = "Invoices are rounded the wrong way"
const BUDGET_TITLE = "Export times out on large workspaces"

describe("the Work board", () => {
  it("shows the header, the four stats with the mock's labels and the five columns with counts", async () => {
    const app = await renderApp({ path: "/app/work" })
    expect(await app.findByRole("heading", { level: 1, name: "Work" })).toBeTruthy()
    expect(app.getByText("acme/web · 5 in flight")).toBeTruthy()
    const stats = app.getByRole("region", { name: "Pipeline summary" })
    for (const label of ["In flight", "Needs you", "Resolved today", "Reopened"]) {
      expect(within(stats).getByText(label)).toBeTruthy()
    }
    expect(within(stats).getByText("0 agents running now")).toBeTruthy()
    expect(within(stats).getByText("oldest waiting 0 min")).toBeTruthy()
    expect(within(stats).getByText("1 verified, 1 still watching")).toBeTruthy()
    expect(within(stats).getByText("none")).toBeTruthy()

    for (const [name, count] of [
      ["Triage", "2"],
      ["Fixing", "1"],
      ["In review", "1"],
      ["Verifying", "1"],
      ["Done today", "1"],
    ] as const) {
      const column = within(app.getByRole("region", { name: "Board" })).getByRole("region", {
        name,
      })
      expect(within(column).getByText(count)).toBeTruthy()
    }
    expect(app.getByRole("searchbox", { name: "Search work items" })).toBeTruthy()
    expect(app.getByRole("button", { name: "New item" })).toBeTruthy()
  })

  it("Needs you lists merge approval, agent question and attempt budget cards with the mock's buttons", async () => {
    const app = await renderApp({ path: "/app/work" })
    const merge = await card(app, MERGE_TITLE)
    expect(within(merge).getByText("FAC-6 · merge approval")).toBeTruthy()
    expect(within(merge).getByRole("link", { name: "Review diff" })).toBeTruthy()
    expect(within(merge).getByRole("button", { name: "Approve merge" })).toBeTruthy()
    const question = await card(app, QUESTION_TITLE)
    expect(within(question).getByText("FAC-2 · agent question")).toBeTruthy()
    expect(within(question).getAllByRole("button")).toHaveLength(2)
    const budget = await card(app, BUDGET_TITLE)
    expect(within(budget).getByText("FAC-5 · attempt budget")).toBeTruthy()
    expect(within(budget).getByRole("link", { name: "Take over" })).toBeTruthy()
    expect(within(budget).getByRole("button", { name: "Retry with notes" })).toBeTruthy()
  })

  it("Retry with notes and the New item form never stop anything; no Stop control exists on the board", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/work", hq })
    const budget = await card(app, BUDGET_TITLE)
    await app.user.click(within(budget).getByRole("button", { name: "Retry with notes" }))
    await app.user.click(app.getByRole("button", { name: "New item" }))
    expect(app.queryByRole("button", { name: /stop/i })).toBeNull()
    expect(app.queryByRole("link", { name: /stop/i })).toBeNull()
    expect(hq.sent.some((s) => s.path.endsWith("/stop"))).toBe(false)
    expect(posts(hq)).toEqual([])
  })

  it("Approve merge asks for confirmation naming the first 7 characters of the head sha, then sends exactly one POST and the card leaves Needs you", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/work", hq })
    const merge = await card(app, MERGE_TITLE)
    await app.user.click(within(merge).getByRole("button", { name: "Approve merge" }))
    // Asked, not sent.
    expect(posts(hq)).toEqual([])
    const group = within(merge).getByRole("group", { name: "Approve merge" })
    expect(group.textContent).toContain(WORK_HEAD_SHA.slice(0, 7))
    expect(group.textContent).toMatch(/does not merge/i)
    await app.user.click(within(group).getByRole("button", { name: "Confirm" }))

    await leaves(app, MERGE_TITLE)
    expect(posts(hq)).toEqual([
      {
        method: "POST",
        path: `/v1/work-items/${WORK_IDS.review}/merge-approval`,
        search: "",
        body: { headSha: WORK_HEAD_SHA },
        credentials: "same-origin",
      },
    ])
    // The other two cards are still there, and the founder is told what was and was not done.
    expect(within(await needsYou(app)).getAllByRole("article")).toHaveLength(2)
    expect((await app.findByRole("status", { name: "Last action" })).textContent).toBe(
      "Merge approved for FAC-6 at aaaaaaa. Nothing was merged: merge it on GitHub.",
    )
  })

  it("two quick clicks on Confirm send one request and the card's buttons are disabled meanwhile", async () => {
    const hq = createFakeHq()
    const hold = holdPosts(hq)
    const app = await renderApp({ path: "/app/work", hq })
    const merge = await card(app, MERGE_TITLE)
    await app.user.click(within(merge).getByRole("button", { name: "Approve merge" }))
    const confirm = within(merge).getByRole("button", { name: "Confirm" })
    await app.user.dblClick(confirm)
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    expect(merge.getAttribute("aria-busy")).toBe("true")
    // Every other card is held too: one write at a time.
    const question = await card(app, QUESTION_TITLE)
    for (const button of within(question).getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
    }
    hold.release()
    await leaves(app, MERGE_TITLE)
    expect(posts(hq)).toHaveLength(1)
  })

  describe("two clicks in one tick, before React has disabled anything, send one request", () => {
    const twice = (button: HTMLElement) =>
      act(async () => {
        button.click()
        button.click()
      })
    async function start() {
      const hq = createFakeHq()
      const hold = holdPosts(hq)
      const app = await renderApp({ path: "/app/work", hq })
      return { hq, hold, app }
    }

    it("approving a merge", async () => {
      const { hold, app } = await start()
      const merge = await card(app, MERGE_TITLE)
      await app.user.click(within(merge).getByRole("button", { name: "Approve merge" }))
      await twice(within(merge).getByRole("button", { name: "Confirm" }))
      expect(hold.reached()).toBe(1)
      hold.release()
      await leaves(app, MERGE_TITLE)
    })

    it("answering a question", async () => {
      const { hold, app } = await start()
      const question = await card(app, QUESTION_TITLE)
      await twice(within(question).getByRole("button", { name: "Half up (default)" }))
      expect(hold.reached()).toBe(1)
      hold.release()
      await leaves(app, QUESTION_TITLE)
    })

    it("two different cards in one tick: still one write", async () => {
      const { hold, app } = await start()
      const question = await card(app, QUESTION_TITLE)
      const budget = await card(app, BUDGET_TITLE)
      await app.user.click(within(budget).getByRole("button", { name: "Retry with notes" }))
      await app.user.type(within(budget).getByLabelText("Notes for the next attempt"), "again")
      const answer = within(question).getByRole("button", { name: "Half up (default)" })
      const retry = within(budget).getByRole("button", { name: "Allow one more attempt" })
      await act(async () => {
        answer.click()
        retry.click()
      })
      expect(hold.reached()).toBe(1)
      hold.release()
      await leaves(app, QUESTION_TITLE)
    })

    it("a retry with notes", async () => {
      const { hold, app } = await start()
      const budget = await card(app, BUDGET_TITLE)
      await app.user.click(within(budget).getByRole("button", { name: "Retry with notes" }))
      await app.user.type(within(budget).getByLabelText("Notes for the next attempt"), "again")
      await twice(within(budget).getByRole("button", { name: "Allow one more attempt" }))
      expect(hold.reached()).toBe(1)
      hold.release()
      await leaves(app, BUDGET_TITLE)
    })

    it("creating an item", async () => {
      const { hold, app } = await start()
      await app.user.click(await app.findByRole("button", { name: "New item" }))
      await app.user.type(app.getByLabelText("Title"), "One")
      await act(async () => {
        const form = app.getByRole("form", { name: "New work item" }) as HTMLFormElement
        form.requestSubmit()
        form.requestSubmit()
      })
      expect(hold.reached()).toBe(1)
      hold.release()
      await waitFor(() => expect(app.queryByLabelText("Title")).toBeNull())
    })
  })

  it("a card stays disabled until the board has been read again after a successful write", async () => {
    const hq = createFakeHq()
    const real = hq.fetch
    let posted = false
    let boardReached = 0
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    hq.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const method = (init?.method ?? "GET").toUpperCase()
      // Hold the board read that follows the write: hq has answered, the screen has not caught up.
      if (posted && method === "GET" && url.startsWith("/v1/work/board")) {
        boardReached += 1
        await gate
      }
      const reply = await real(input, init)
      if (method === "POST") posted = true
      return reply
    }) as typeof fetch
    const app = await renderApp({ path: "/app/work", hq })
    const merge = await card(app, MERGE_TITLE)
    await app.user.click(within(merge).getByRole("button", { name: "Approve merge" }))
    await app.user.click(within(merge).getByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(boardReached).toBe(1))
    // The write succeeded and its card is still on screen: nothing on the board can be clicked,
    // so no second approval can be sent for a head that is already approved.
    const region = await needsYou(app)
    expect(within(region).getAllByRole("article")).toHaveLength(3)
    for (const button of region.querySelectorAll("button")) {
      expect((button as HTMLButtonElement).disabled, button.textContent ?? "").toBe(true)
    }
    expect(merge.getAttribute("aria-busy")).toBe("true")
    expect(app.queryByRole("status", { name: "Last action" })).toBeNull()
    expect(posts(hq)).toHaveLength(1)
    release()
    await leaves(app, MERGE_TITLE)
    expect((await app.findByRole("status", { name: "Last action" })).textContent).toContain(
      "Merge approved",
    )
    for (const button of (await needsYou(app)).querySelectorAll("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(false)
    }
  })

  it("Create item says another change is in flight, and waits, while a write is pending", async () => {
    const hq = createFakeHq()
    const hold = holdPosts(hq)
    const app = await renderApp({ path: "/app/work", hq })
    await app.user.click(await app.findByRole("button", { name: "New item" }))
    await app.user.type(app.getByLabelText("Title"), "Waits its turn")
    expect(app.queryByText(/Another change is in flight/)).toBeNull()
    const merge = await card(app, MERGE_TITLE)
    await app.user.click(within(merge).getByRole("button", { name: "Approve merge" }))
    await app.user.click(within(merge).getByRole("button", { name: "Confirm" }))
    const create = app.getByRole("button", { name: "Create item" }) as HTMLButtonElement
    expect(create.disabled).toBe(true)
    expect(app.getByText(/Another change is in flight/)).toBeTruthy()
    // A submit that gets through anyway (Enter in the field) sends nothing either.
    fireEvent.submit(app.getByRole("form", { name: "New work item" }))
    expect(hold.reached()).toBe(1)
    hold.release()
    await leaves(app, MERGE_TITLE)
    await waitFor(() => expect(create.disabled).toBe(false))
    expect(app.queryByText(/Another change is in flight/)).toBeNull()
    expect(posts(hq)).toHaveLength(1)
  })

  it("a 409 shows 'The pull request changed since you looked. Review it again.' and refetches the board", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/work", hq })
    const merge = await card(app, MERGE_TITLE)
    await app.user.click(within(merge).getByRole("button", { name: "Approve merge" }))
    const readsBefore = boardReads(hq).length
    hq.state.nextError = {
      status: 409,
      body: {
        error: { code: "CONFLICT", message: "The pull request changed since you looked" },
      },
    }
    await app.user.click(within(merge).getByRole("button", { name: "Confirm" }))
    const alert = await within(merge).findByRole("alert")
    expect(alert.textContent).toBe("The pull request changed since you looked. Review it again.")
    await waitFor(() => expect(boardReads(hq).length).toBeGreaterThan(readsBefore))
    // The card is still there and can be tried again by hand; nothing was retried.
    expect(posts(hq)).toHaveLength(1)
    // Still asking: a founder can confirm again by hand, but nothing was sent a second time.
    const again = await card(app, MERGE_TITLE)
    expect(within(again).getByRole("button", { name: "Confirm" })).toBeTruthy()
  })

  it("any other 409 and a 403 show the server's own message", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/work", hq })
    const merge = await card(app, MERGE_TITLE)
    await app.user.click(within(merge).getByRole("button", { name: "Approve merge" }))
    hq.state.nextError = {
      status: 403,
      body: { error: { code: "FORBIDDEN", message: "Only a founder can decide this." } },
    }
    await app.user.click(within(merge).getByRole("button", { name: "Confirm" }))
    expect((await within(merge).findByRole("alert")).textContent).toBe(
      "Only a founder can decide this.",
    )

    hq.state.nextError = {
      status: 409,
      body: { error: { code: "CONFLICT", message: "This merge is already approved." } },
    }
    await app.user.click(within(merge).getByRole("button", { name: "Confirm" }))
    await waitFor(() =>
      expect(within(merge).getByRole("alert").textContent).toBe("This merge is already approved."),
    )
  })

  it("answering sends one POST with the option id; the default option is first and labelled (default)", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/work", hq })
    const question = await card(app, QUESTION_TITLE)
    const buttons = within(question).getAllByRole("button")
    expect(buttons.map((b) => b.textContent)).toEqual(["Half up (default)", "Half to even"])
    expect(question.textContent).toContain("Round half up, or half to even as the ledger does?")
    // The recommendation is shown, never applied.
    expect(posts(hq)).toEqual([])
    await app.user.dblClick(buttons[1] as HTMLElement)
    await leaves(app, QUESTION_TITLE)
    expect(posts(hq)).toEqual([
      {
        method: "POST",
        path: `/v1/questions/${WORK_IDS.question}/answer`,
        search: "",
        body: { optionId: "even" },
        credentials: "same-origin",
      },
    ])
  })

  it("Retry with notes needs a note and sends it once", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/work", hq })
    const budget = await card(app, BUDGET_TITLE)
    await app.user.click(within(budget).getByRole("button", { name: "Retry with notes" }))
    const send = within(budget).getByRole("button", { name: "Allow one more attempt" })
    expect((send as HTMLButtonElement).disabled).toBe(true)
    await app.user.type(within(budget).getByLabelText("Notes for the next attempt"), "   ")
    expect((send as HTMLButtonElement).disabled).toBe(true)
    await app.user.type(
      within(budget).getByLabelText("Notes for the next attempt"),
      "Try the cursor query",
    )
    await app.user.dblClick(send)
    await leaves(app, BUDGET_TITLE)
    expect(posts(hq)).toEqual([
      {
        method: "POST",
        path: `/v1/work-items/${WORK_IDS.exhausted}/retry`,
        search: "",
        body: { note: "Try the cursor query" },
        credentials: "same-origin",
      },
    ])
  })

  it("Review diff is a link to the pull request only when the url is https://github.com/<repo>/pull/<n>", async () => {
    const good = await renderApp({ path: "/app/work" })
    const link = within(await card(good, MERGE_TITLE)).getByRole("link", { name: "Review diff" })
    expect(link.getAttribute("href")).toBe("https://github.com/acme/web/pull/106")
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("rel")).toContain("noreferrer")
    good.unmount()

    for (const url of [
      "javascript:alert(1)",
      "https://evil.example/acme/web/pull/106",
      "https://github.com/acme/other/pull/106",
      "https://github.com/acme/web/pull/107",
      "https://github.com/acme/web/pull/106?x=1",
      "https://github.com.evil.example/acme/web/pull/106",
    ]) {
      const base = workBoardFixture()
      const board: WorkBoard = {
        ...base,
        needsYou: base.needsYou.map((n) =>
          n.kind === "merge_approval" && n.merge
            ? { ...n, merge: { ...n.merge, pullRequestUrl: url } }
            : n,
        ),
      }
      const bad = await renderApp({ path: "/app/work", hq: createFakeHq({ workBoard: board }) })
      const merge = await card(bad, MERGE_TITLE)
      expect(within(merge).queryByRole("link"), url).toBeNull()
      bad.unmount()
    }
  })

  it("a draft pull request says so beside the head sha", async () => {
    const base = workBoardFixture()
    const board: WorkBoard = {
      ...base,
      needsYou: base.needsYou.map((n) =>
        n.kind === "merge_approval" && n.merge ? { ...n, merge: { ...n.merge, isDraft: true } } : n,
      ),
    }
    const app = await renderApp({ path: "/app/work", hq: createFakeHq({ workBoard: board }) })
    const merge = await card(app, MERGE_TITLE)
    expect(merge.textContent).toContain(WORK_HEAD_SHA.slice(0, 7))
    expect(merge.textContent).toMatch(/draft/i)
  })

  it("an issue title, summary or question prompt of <img onerror> and a markdown link renders as plain text and stays clear of the buttons", async () => {
    const hostile = '<img src=x onerror="alert(1)"> [pay now](https://evil.example/pay)'
    const base = workBoardFixture()
    const board: WorkBoard = {
      ...base,
      columns: base.columns.map((c) => ({
        ...c,
        items: c.items.map((item) => ({ ...item, title: hostile, summary: hostile })),
      })),
      needsYou: base.needsYou.map((n) => ({
        ...n,
        title: hostile,
        ...(n.question
          ? {
              question: {
                ...n.question,
                prompt: hostile,
                options: n.question.options.map((o) => ({ ...o, label: hostile })),
              },
            }
          : {}),
      })),
    }
    const app = await renderApp({ path: "/app/work", hq: createFakeHq({ workBoard: board }) })
    const region = await needsYou(app)
    expect(app.container.querySelector("img")).toBeNull()
    expect(app.container.querySelector("a[href*='evil']")).toBeNull()
    expect(region.textContent).toContain('<img src=x onerror="alert(1)">')
    expect(region.textContent).toContain("[pay now](https://evil.example/pay)")
    // The only links on a Needs you card are hq's own: the pull request and the item.
    for (const link of region.querySelectorAll("a")) {
      expect(link.getAttribute("href") ?? "").toMatch(
        /^(https:\/\/github\.com\/acme\/web\/pull\/106|\/app\/work\/FAC-\d+)$/,
      )
    }
    // The buttons are never inside a text element, and every text element wraps and is bounded.
    for (const button of region.querySelectorAll("button")) {
      expect(button.closest("h3, p")).toBeNull()
    }
    await expectNoA11yViolations(app.container.innerHTML)
  })

  it("a 5 000 character unbroken title, reason, prompt and option label wrap inside their cards", async () => {
    const long = "A".repeat(5000)
    const base = workBoardFixture()
    const board: WorkBoard = {
      ...base,
      columns: base.columns.map((c) => ({
        ...c,
        items: c.items.map((item) => ({ ...item, title: long, summary: long })),
      })),
      needsYou: base.needsYou.map((n) => ({
        ...n,
        title: long,
        reason: long,
        ...(n.question
          ? {
              question: {
                ...n.question,
                prompt: long,
                // hq stores an option label to 200 characters and a detail to 500.
                options: n.question.options.map((o) => ({
                  ...o,
                  label: "A".repeat(200),
                  detail: "D".repeat(500),
                })),
              },
            }
          : {}),
      })),
    }
    const app = await renderApp({ path: "/app/work", hq: createFakeHq({ workBoard: board }) })
    const region = await needsYou(app)
    for (const article of region.querySelectorAll("article")) {
      expect(article.className).toContain("min-w-0")
      for (const text of article.querySelectorAll("h3, p")) {
        expect(text.className, text.tagName).toContain("wrap-anywhere")
      }
    }
    // The buttons whose text comes from outside (the option labels) wrap; the others have fixed text.
    const asking = [...region.querySelectorAll("article")].find((a) =>
      a.textContent?.includes("(default)"),
    ) as HTMLElement
    const options = within(asking)
      .getAllByRole("button")
      .filter((b) => !/^Show (all|less)$/.test(b.textContent ?? ""))
    expect(options).toHaveLength(2)
    for (const button of options) {
      expect(button.className).toContain("whitespace-normal")
      expect(button.className).toContain("wrap-anywhere")
      expect(button.className).toContain("h-auto")
    }
    for (const title of app.getByRole("region", { name: "Board" }).querySelectorAll("article a")) {
      expect(title.className).toContain("wrap-anywhere")
    }
    expect(app.container.querySelector("[style]")).toBeNull()
  })

  it("the search sends listWorkItems with the query and shows results instead of columns, and clearing it returns the board", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/work", hq })
    await needsYou(app)
    const search = app.getByRole("searchbox", { name: "Search work items" })
    expect(search.getAttribute("placeholder")).toBe("Search items, files, errors")
    expect(listReads(hq)).toEqual([])
    await app.user.type(search, "checkout")

    const results = await app.findByRole("region", { name: "Search results" })
    expect(await within(results).findByText("Checkout shows a blank page")).toBeTruthy()
    expect(app.queryByRole("region", { name: "Board" })).toBeNull()
    const last = listReads(hq).at(-1)
    expect(last?.search).toContain("query=checkout")
    expect(posts(hq)).toEqual([])

    await app.user.clear(search)
    expect(await app.findByRole("region", { name: "Board" })).toBeTruthy()
    expect(app.queryByRole("region", { name: "Search results" })).toBeNull()
  })

  it("a search with no match says so", async () => {
    const app = await renderApp({ path: "/app/work" })
    await app.user.type(
      await app.findByRole("searchbox", { name: "Search work items" }),
      "zzzznothing",
    )
    expect(await app.findByText("No work item matches")).toBeTruthy()
  })

  it("New item opens the form and creates once; the board refetches", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/work", hq })
    await app.user.click(await app.findByRole("button", { name: "New item" }))
    expect((app.getByLabelText("Repo") as HTMLInputElement).value).toBe("acme/web")
    await app.user.type(app.getByLabelText("Title"), "Add a retry button")
    await app.user.type(app.getByLabelText("Details"), "The export page has none.")
    const readsBefore = boardReads(hq).length
    await app.user.dblClick(app.getByRole("button", { name: "Create item" }))
    await waitFor(() => expect(app.queryByLabelText("Title")).toBeNull())
    expect(posts(hq)).toEqual([
      {
        method: "POST",
        path: "/v1/work-items",
        search: "",
        body: { title: "Add a retry button", body: "The export page has none.", repo: "acme/web" },
        credentials: "same-origin",
      },
    ])
    await waitFor(() => expect(boardReads(hq).length).toBeGreaterThan(readsBefore))
    expect((await app.findByRole("status", { name: "Last action" })).textContent).toContain(
      "FAC-11",
    )
  })

  it("a 403 on create shows the server's message and keeps the form", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/work", hq })
    await app.user.click(await app.findByRole("button", { name: "New item" }))
    await app.user.type(app.getByLabelText("Title"), "Something")
    hq.state.nextError = {
      status: 403,
      body: { error: { code: "FORBIDDEN", message: "Only a founder can create work." } },
    }
    await app.user.click(app.getByRole("button", { name: "Create item" }))
    expect((await app.findByRole("alert")).textContent).toBe("Only a founder can create work.")
    expect(app.getByLabelText("Title")).toBeTruthy()
    expect(posts(hq)).toHaveLength(1)
  })

  it("the form needs a title and an owner/name repo before it sends anything", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/work", hq })
    await app.user.click(await app.findByRole("button", { name: "New item" }))
    await app.user.click(app.getByRole("button", { name: "Create item" }))
    expect(await app.findByRole("alert")).toBeTruthy()
    await app.user.type(app.getByLabelText("Title"), "x")
    await app.user.clear(app.getByLabelText("Repo"))
    await app.user.type(app.getByLabelText("Repo"), "not a repo")
    await app.user.click(app.getByRole("button", { name: "Create item" }))
    expect(app.getByRole("alert").textContent).toMatch(/owner\/name/)
    expect(posts(hq)).toEqual([])
  })

  it("an empty board says 'Nothing in the pipeline yet' in each column and 'Nothing needs you'", async () => {
    const empty = workBoardFixture({
      repos: [],
      columns: workBoardFixture().columns.map((c) => ({ ...c, count: 0, items: [] })),
      stats: {
        inFlight: 0,
        runningAttempts: 0,
        needsYou: 0,
        oldestWaitingMinutes: null,
        resolvedToday: 0,
        verifiedToday: 0,
        watching: 0,
        reopened: 0,
        latestReopened: null,
      },
      needsYou: [],
    })
    const app = await renderApp({ path: "/app/work", hq: createFakeHq({ workBoard: empty }) })
    expect(await app.findByText("Nothing needs you")).toBeTruthy()
    expect(app.getAllByText("Nothing in the pipeline yet")).toHaveLength(5)
    expect(app.getByText("0 in flight")).toBeTruthy()
    // No wait to report: never "null" or "NaN".
    expect(app.container.textContent).not.toMatch(/null|NaN|undefined/)
    await app.user.click(app.getByRole("button", { name: "New item" }))
    // No repo on the board: the form asks for one.
    expect((app.getByLabelText("Repo") as HTMLInputElement).value).toBe("")
  })

  it("shows loading while the board is on its way", async () => {
    const hq = createFakeHq()
    const real = hq.fetch
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    hq.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (url.startsWith("/v1/work/board")) await gate
      return real(input, init)
    }) as typeof fetch
    const app = await renderApp({ path: "/app/work", hq })
    expect(await app.findByText("Loading the work board")).toBeTruthy()
    release()
    expect(await app.findByRole("heading", { level: 1, name: "Work" })).toBeTruthy()
  })

  it("shows an error with Retry that asks again", async () => {
    const failing = createFakeHq()
    const real = failing.fetch
    let refuse = true
    failing.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      if (refuse && url.startsWith("/v1/work/board")) {
        return new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "slow" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "3" },
        })
      }
      return real(input, init)
    }) as typeof fetch
    const app = await renderApp({ path: "/app/work", hq: failing })
    expect(await app.findByText("Too many attempts")).toBeTruthy()
    refuse = false
    await app.user.click(app.getByRole("button", { name: "Retry" }))
    expect(await app.findByRole("heading", { level: 1, name: "Work" })).toBeTruthy()
    expect(posts(failing)).toEqual([])
  })

  it("the refusal panel and a non-founder come from the gate, not from the board", async () => {
    const refused = await renderApp({
      path: "/app/work",
      hq: createFakeHq({ caller: "refused" }),
    })
    expect(await refused.findByText("hq refused to start")).toBeTruthy()
    expect(refused.queryByRole("heading", { level: 1, name: "Work" })).toBeNull()
    refused.unmount()
    const other = await renderApp({
      path: "/app/work",
      hq: createFakeHq({ caller: "non-founder" }),
    })
    expect(await other.findByText(/not a founder/i)).toBeTruthy()
    expect(other.queryByRole("heading", { level: 1, name: "Work" })).toBeNull()
  })

  it("'Pause all agents' appears nowhere and 'Autopilot off' is present, 'Autopilot on' nowhere", async () => {
    const app = await renderApp({ path: "/app/work" })
    await app.findByRole("heading", { level: 1, name: "Work" })
    expect(app.container.textContent).not.toMatch(/pause all/i)
    expect(app.container.textContent).toContain("Autopilot off")
    expect(app.container.textContent).not.toMatch(/Autopilot on/i)
  })

  it("no write is sent on load, focus, visibility or retry", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/work", hq })
    await needsYou(app)
    fireEvent.focus(window)
    fireEvent(document, new Event("visibilitychange"))
    fireEvent(window, new Event("online"))
    await app.queryClient.invalidateQueries({ queryKey: ["work"] })
    expect(posts(hq)).toEqual([])
    expect(hq.sent.every((s) => s.method === "GET")).toBe(true)
  })

  it("a waiting card (a verify item past its window with a verifier not connected) is a card, not a Needs you entry", async () => {
    const base = workBoardFixture()
    const waiting: WorkItemSummary = workSummaryFixture({
      id: "9b1d7b0e-5d0c-4f43-9a4c-1c0d4c1d9e11",
      number: 12,
      displayId: "FAC-12",
      title: "Signup emails arrive late",
      state: "verify",
      attention: null,
      waitingSince: null,
      card: { label: "waiting", tone: "amber", detail: "window ended · sentry not connected" },
      pullRequest: null,
    })
    const board: WorkBoard = {
      ...base,
      columns: base.columns.map((c) =>
        c.key === "verifying" ? { ...c, count: 2, items: [...c.items, waiting] } : c,
      ),
    }
    const app = await renderApp({ path: "/app/work", hq: createFakeHq({ workBoard: board }) })
    const region = await needsYou(app)
    expect(within(region).queryByText("Signup emails arrive late")).toBeNull()
    expect(within(region).getAllByRole("article")).toHaveLength(3)
    const column = within(app.getByRole("region", { name: "Board" })).getByRole("region", {
      name: "Verifying",
    })
    expect(within(column).getByText("Signup emails arrive late")).toBeTruthy()
    expect(within(column).getByText("waiting")).toBeTruthy()
    expect(within(column).getByText("window ended · sentry not connected")).toBeTruthy()
  })

  it("the stats are hq's numbers, not counted from the cards (In flight differs from the cards shown)", async () => {
    const base = workBoardFixture()
    const board: WorkBoard = {
      ...base,
      stats: { ...base.stats, inFlight: 41, resolvedToday: 7, watching: 3, verifiedToday: 4 },
    }
    const app = await renderApp({ path: "/app/work", hq: createFakeHq({ workBoard: board }) })
    const stats = await app.findByRole("region", { name: "Pipeline summary" })
    expect(within(stats).getByText("41")).toBeTruthy()
    expect(within(stats).getByText("7")).toBeTruthy()
    expect(within(stats).getByText("4 verified, 3 still watching")).toBeTruthy()
    expect(app.getByText("acme/web · 41 in flight")).toBeTruthy()
  })

  it("the reopened stat names the item and hq's own reason, never a reason of its own", async () => {
    const base = workBoardFixture()
    const board: WorkBoard = {
      ...base,
      stats: {
        ...base.stats,
        reopened: 1,
        latestReopened: { displayId: "FAC-9", reason: "A founder reopened it." },
      },
    }
    const app = await renderApp({ path: "/app/work", hq: createFakeHq({ workBoard: board }) })
    const stats = await app.findByRole("region", { name: "Pipeline summary" })
    expect(within(stats).getByText("FAC-9: A founder reopened it.")).toBeTruthy()
    expect(stats.textContent).not.toMatch(/recurred/)
  })

  it("more than 30 cards in a column says how many are not shown, as plain text", async () => {
    const base = workBoardFixture()
    const board: WorkBoard = {
      ...base,
      columns: base.columns.map((c) => (c.key === "triage" ? { ...c, count: 45 } : c)),
    }
    const app = await renderApp({ path: "/app/work", hq: createFakeHq({ workBoard: board }) })
    const column = within(await app.findByRole("region", { name: "Board" })).getByRole("region", {
      name: "Triage",
    })
    const more = within(column).getByText("43 more")
    expect(more.closest("a, button")).toBeNull()
  })

  it("renders no inline style and no a11y violations", async () => {
    const app = await renderApp({ path: "/app/work" })
    await needsYou(app)
    expect(app.container.querySelector("[style]")).toBeNull()
    await expectNoA11yViolations(app.container.innerHTML)
  })

  it("every control on the board is min-h-touch", async () => {
    const app = await renderApp({ path: "/app/work" })
    const main = (await needsYou(app)).closest("main") as HTMLElement
    const controls = main.querySelectorAll("a, button, input, textarea")
    expect(controls.length).toBeGreaterThan(8)
    for (const control of controls) {
      expect(control.className, control.textContent ?? control.tagName).toContain("min-h-touch")
    }
  })

  it("a card title is a link to the item page", async () => {
    const app = await renderApp({ path: "/app/work" })
    await needsYou(app)
    const column = within(app.getByRole("region", { name: "Board" })).getByRole("region", {
      name: "In review",
    })
    const link = within(column).getByRole("link", { name: MERGE_TITLE })
    expect(link.getAttribute("href")).toBe("/app/work/FAC-6")
    // The link opens the item page (Task 17b).
    await app.user.click(link)
    expect(await app.findByRole("heading", { level: 1, name: MERGE_TITLE })).toBeTruthy()
  })
})
