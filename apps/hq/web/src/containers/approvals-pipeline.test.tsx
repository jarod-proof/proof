// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { act, fireEvent, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { WorkBoard } from "../api/schemas"
import { createFakeHq, type FakeHq, urlOf } from "../test/fake-hq"
import { workCountsOf } from "../test/fake-work"
import {
  factoryStatusFixture,
  needsYouFixture,
  proposalFixture,
  WORK_HEAD_SHA,
  WORK_IDS,
  workBoardFixture,
  workItemsFixture,
} from "../test/fixtures"
import { renderApp } from "../test/render"

type App = Awaited<ReturnType<typeof renderApp>>

const posts = (hq: FakeHq) => hq.sent.filter((s) => s.method !== "GET")
const boardReads = (hq: FakeHq) => hq.sent.filter((s) => s.path === "/v1/work/board")

const MERGE_TITLE = "Empty cart crashes the checkout"
const QUESTION_TITLE = "Invoices are rounded the wrong way"
const BUDGET_TITLE = "Export times out on large workspaces"
const STUCK_TITLE = "Search ignores accents"

/** The default board's three needs plus a stuck attempt: all four kinds, as hq sorts them. */
function boardOfFour(): WorkBoard {
  const base = workBoardFixture()
  const needsYou = [...base.needsYou, needsYouFixture("stuck_attempt")]
  return { ...base, needsYou, stats: { ...base.stats, needsYou: needsYou.length } }
}

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

/** The section, once its board has been read (the section itself is there while it loads). */
const pipeline = async (app: App) => {
  const region = await app.findByRole("region", { name: /From the pipeline/ })
  await waitFor(() => expect(within(region).queryByText(/^Loading /)).toBeNull())
  return region
}
const card = async (app: App, title: string) =>
  within(await pipeline(app)).getByRole("article", { name: title })
const leaves = (app: App, title: string) =>
  waitFor(() =>
    expect(
      within(app.getByRole("region", { name: /From the pipeline/ })).queryByRole("article", {
        name: title,
      }),
    ).toBeNull(),
  )
const navApprovals = (app: App) =>
  within(app.getByRole("navigation", { name: "Primary" })).getByRole("link", {
    name: /Approvals/,
  })

/** hq answers the board read with an error until `fix()` is called. */
function failBoard(hq: FakeHq): { fix(): void } {
  const real = hq.fetch
  let failing = true
  hq.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (failing && urlOf(input).startsWith("/v1/work/board")) {
      return new Response(JSON.stringify({ error: { code: "INTERNAL", message: "boom" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      })
    }
    return real(input, init)
  }) as typeof fetch
  return {
    fix: () => {
      failing = false
    },
  }
}

describe("Approvals: the pipeline section", () => {
  it("shows proposal cards and, below them, the pipeline's needs-you cards of all four kinds with the Work board's buttons", async () => {
    const hq = createFakeHq({
      proposals: [proposalFixture({ id: "p-1", title: "Tone of voice" })],
      workBoard: boardOfFour(),
    })
    const app = await renderApp({ path: "/app/approvals", hq })
    const proposal = await app.findByRole("article", { name: "Tone of voice" })
    const region = await pipeline(app)
    // After the proposals' Needs you section, before Recently decided.
    const headings = [...app.container.querySelectorAll("h2")].map((h) => h.id)
    expect(headings).toEqual(["needs-you", "work-needs", "recently-decided"])
    expect(proposal.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    expect(region.querySelector("h2 span")?.textContent).toBe("4")
    const merge = within(region).getByRole("article", { name: MERGE_TITLE })
    expect(within(merge).getByRole("button", { name: "Approve merge" })).toBeTruthy()
    expect(within(merge).getByText(/head aaaaaaa/)).toBeTruthy()
    expect(within(merge).getByText(/ready for review/)).toBeTruthy()
    expect(within(merge).getByRole("link", { name: "Review diff" }).getAttribute("href")).toBe(
      "https://github.com/acme/web/pull/106",
    )
    const question = within(region).getByRole("article", { name: QUESTION_TITLE })
    expect(within(question).getByRole("button", { name: "Half up (default)" })).toBeTruthy()
    expect(within(question).getByRole("button", { name: "Half to even" })).toBeTruthy()
    const budget = within(region).getByRole("article", { name: BUDGET_TITLE })
    expect(within(budget).getByRole("button", { name: "Retry with notes" })).toBeTruthy()
    expect(within(budget).getByRole("link", { name: "Take over" })).toBeTruthy()
    const stuck = within(region).getByRole("article", { name: STUCK_TITLE })
    expect(within(stuck).getByRole("link", { name: "Open item" }).getAttribute("href")).toBe(
      "/app/work/FAC-4",
    )
    // Reads only.
    expect(posts(hq)).toEqual([])
  })

  it("approving a merge here sends one POST and the section and the badge drop by one", async () => {
    const hq = createFakeHq({
      proposals: [proposalFixture({ id: "p-1", title: "Tone of voice" })],
      workBoard: boardOfFour(),
    })
    const app = await renderApp({ path: "/app/approvals", hq })
    // 1 proposal plus 4 pipeline needs.
    await waitFor(() => expect(navApprovals(app).textContent).toContain("5"))
    const merge = await card(app, MERGE_TITLE)
    await app.user.click(within(merge).getByRole("button", { name: "Approve merge" }))
    // Asked, not sent.
    expect(posts(hq)).toEqual([])
    const group = within(merge).getByRole("group", { name: "Approve merge" })
    expect(group.textContent).toContain("aaaaaaa")
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
    const region = await pipeline(app)
    expect(within(region).getAllByRole("article")).toHaveLength(3)
    expect(region.querySelector("h2 span")?.textContent).toBe("3")
    await waitFor(() => expect(navApprovals(app).textContent).toContain("4"))
    expect(within(region).getByRole("status", { name: "Last action" }).textContent).toBe(
      "Merge approved for FAC-6 at aaaaaaa. Nothing was merged: merge it on GitHub.",
    )
    // The proposal is untouched.
    expect(app.getByRole("article", { name: "Tone of voice" })).toBeTruthy()
  })

  it("answering a question here sends one POST with the option id and the card leaves", async () => {
    const hq = createFakeHq({ workBoard: boardOfFour() })
    const app = await renderApp({ path: "/app/approvals", hq })
    const question = await card(app, QUESTION_TITLE)
    await app.user.click(within(question).getByRole("button", { name: "Half to even" }))
    await leaves(app, QUESTION_TITLE)
    expect(posts(hq).map((s) => [s.path, s.body])).toEqual([
      [`/v1/questions/${WORK_IDS.question}/answer`, { optionId: "even" }],
    ])
    expect(
      within(await pipeline(app)).getByRole("status", { name: "Last action" }).textContent,
    ).toBe("Answer sent for FAC-2.")
  })

  it("Retry with notes sends the note once and says no attempt was started", async () => {
    const hq = createFakeHq({ workBoard: boardOfFour() })
    const app = await renderApp({ path: "/app/approvals", hq })
    const budget = await card(app, BUDGET_TITLE)
    await app.user.click(within(budget).getByRole("button", { name: "Retry with notes" }))
    await app.user.type(within(budget).getByLabelText("Notes for the next attempt"), "try X")
    await app.user.click(within(budget).getByRole("button", { name: "Allow one more attempt" }))
    await leaves(app, BUDGET_TITLE)
    expect(posts(hq).map((s) => s.body)).toEqual([{ note: "try X" }])
    expect(
      within(await pipeline(app)).getByRole("status", { name: "Last action" }).textContent,
    ).toBe("One more fix attempt allowed for FAC-5. None was started.")
  })

  it("the sidebar badge on Approvals is pendingProposals plus work.needsYou (3 + 4 shows 7)", async () => {
    const hq = createFakeHq({
      workBoard: boardOfFour(),
      factoryStatus: factoryStatusFixture({
        pendingProposals: 3,
        work: workCountsOf(boardOfFour(), workItemsFixture()),
      }),
    })
    const app = await renderApp({ path: "/app/approvals", hq })
    await waitFor(() => expect(navApprovals(app).textContent).toBe("Approvals7"))
  })

  it("the badge counts a pipeline need even when no proposal is pending", async () => {
    const hq = createFakeHq({
      // The default board has three needs; hq's counts for it, as the fake derives them.
      factoryStatus: factoryStatusFixture({
        pendingProposals: 0,
        work: workCountsOf(workBoardFixture(), workItemsFixture()),
      }),
    })
    const app = await renderApp({ path: "/app/digest", hq })
    await waitFor(() => expect(navApprovals(app).textContent).toBe("Approvals3"))
  })

  it("a null work counts as 0: the badge is the proposals alone", async () => {
    const hq = createFakeHq({
      factoryStatus: factoryStatusFixture({ pendingProposals: 3, work: null }),
    })
    const app = await renderApp({ path: "/app/digest", hq })
    await waitFor(() => expect(navApprovals(app).textContent).toBe("Approvals3"))
  })

  it("a work key hq did not send at all (an older hq) counts as 0 too", async () => {
    const hq = createFakeHq({ factoryStatus: factoryStatusFixture({ pendingProposals: 2 }) })
    const real = hq.fetch
    hq.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const reply = await real(input, init)
      if (!urlOf(input).startsWith("/v1/factory/status")) return reply
      const { work: _dropped, ...body } = (await reply.json()) as Record<string, unknown>
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
    const app = await renderApp({ path: "/app/digest", hq })
    await waitFor(() => expect(navApprovals(app).textContent).toBe("Approvals2"))
  })

  it("the badge reads 99+ above 99", async () => {
    const hq = createFakeHq({
      factoryStatus: factoryStatusFixture({
        pendingProposals: 100,
        work: workCountsOf(workBoardFixture(), workItemsFixture()),
      }),
    })
    const app = await renderApp({ path: "/app/digest", hq })
    await waitFor(() => expect(navApprovals(app).textContent).toBe("Approvals99+"))
  })

  it("a failing board read leaves proposals usable and shows an error block only in the pipeline section", async () => {
    const hq = createFakeHq({ proposals: [proposalFixture({ id: "p-1", title: "Tone of voice" })] })
    const board = failBoard(hq)
    const app = await renderApp({ path: "/app/approvals", hq })
    const proposal = await app.findByRole("article", { name: "Tone of voice" })
    const region = await pipeline(app)
    const alert = await within(region).findByRole("alert")
    expect(alert.textContent).toContain("hq had a problem")
    // The proposals' own section has no error, and the proposal still decides.
    expect(within(app.getByRole("region", { name: /Needs you/ })).queryByRole("alert")).toBeNull()
    await app.user.click(within(proposal).getByRole("button", { name: "Approve" }))
    expect(
      await within(await app.findByRole("region", { name: /Recently decided/ })).findByText(
        "Tone of voice",
      ),
    ).toBeTruthy()
    expect(posts(hq).map((s) => s.path)).toEqual(["/v1/proposals/p-1/decision"])
    // Retry asks again, sends no POST, and the cards come.
    board.fix()
    await app.user.click(within(region).getByRole("button", { name: "Retry" }))
    expect(await card(app, MERGE_TITLE)).toBeTruthy()
    expect(posts(hq)).toHaveLength(1)
  })

  it("shows loading in the section while the board is on its way, then the empty state", async () => {
    const hq = createFakeHq({ workBoard: workBoardFixture({ needsYou: [] }) })
    const real = hq.fetch
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    hq.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (urlOf(input).startsWith("/v1/work/board")) await gate
      return real(input, init)
    }) as typeof fetch
    const app = await renderApp({ path: "/app/approvals", hq })
    expect(await app.findByText("Loading the pipeline")).toBeTruthy()
    release()
    expect(await app.findByText("Nothing from the pipeline needs you")).toBeTruthy()
  })

  describe("one write at a time", () => {
    it("while a merge approval is on its way no other pipeline card can be clicked and one request is sent", async () => {
      const hq = createFakeHq({ workBoard: boardOfFour() })
      const hold = holdPosts(hq)
      const app = await renderApp({ path: "/app/approvals", hq })
      const merge = await card(app, MERGE_TITLE)
      await app.user.click(within(merge).getByRole("button", { name: "Approve merge" }))
      const confirm = within(merge).getByRole("button", { name: "Confirm" })
      await app.user.dblClick(confirm)
      expect((confirm as HTMLButtonElement).disabled).toBe(true)
      expect(merge.getAttribute("aria-busy")).toBe("true")
      const region = await pipeline(app)
      for (const button of region.querySelectorAll("button")) {
        expect((button as HTMLButtonElement).disabled, button.textContent ?? "").toBe(true)
      }
      hold.release()
      await leaves(app, MERGE_TITLE)
      expect(posts(hq)).toHaveLength(1)
      expect(hold.reached()).toBe(1)
    })

    it("two clicks in one tick on two different cards send one request", async () => {
      const hq = createFakeHq({ workBoard: boardOfFour() })
      const hold = holdPosts(hq)
      const app = await renderApp({ path: "/app/approvals", hq })
      const question = await card(app, QUESTION_TITLE)
      await app.user.click(
        within(await card(app, MERGE_TITLE)).getByRole("button", { name: "Approve merge" }),
      )
      const confirm = within(await card(app, MERGE_TITLE)).getByRole("button", { name: "Confirm" })
      const answer = within(question).getByRole("button", { name: "Half to even" })
      await act(async () => {
        fireEvent.click(confirm)
        fireEvent.click(answer)
      })
      expect(hold.reached()).toBe(1)
      hold.release()
      await leaves(app, MERGE_TITLE)
      expect(posts(hq)).toHaveLength(1)
      expect(posts(hq)[0]?.path).toBe(`/v1/work-items/${WORK_IDS.review}/merge-approval`)
    })

    it("a card stays disabled until the board has been read again after a successful write", async () => {
      const hq = createFakeHq({ workBoard: boardOfFour() })
      const real = hq.fetch
      let posted = false
      let reached = 0
      let release = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      hq.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = (init?.method ?? "GET").toUpperCase()
        if (posted && method === "GET" && urlOf(input).startsWith("/v1/work/board")) {
          reached += 1
          await gate
        }
        const reply = await real(input, init)
        if (method === "POST") posted = true
        return reply
      }) as typeof fetch
      const app = await renderApp({ path: "/app/approvals", hq })
      const merge = await card(app, MERGE_TITLE)
      await app.user.click(within(merge).getByRole("button", { name: "Approve merge" }))
      await app.user.click(within(merge).getByRole("button", { name: "Confirm" }))
      await waitFor(() => expect(reached).toBe(1))
      const region = await pipeline(app)
      expect(within(region).getAllByRole("article")).toHaveLength(4)
      for (const button of region.querySelectorAll("button")) {
        expect((button as HTMLButtonElement).disabled, button.textContent ?? "").toBe(true)
      }
      expect(posts(hq)).toHaveLength(1)
      release()
      await leaves(app, MERGE_TITLE)
    })
  })

  describe("what hq refuses", () => {
    it("a 409 for a head that moved says so, reads the board again and the card stays", async () => {
      const hq = createFakeHq({ workBoard: boardOfFour() })
      const app = await renderApp({ path: "/app/approvals", hq })
      const merge = await card(app, MERGE_TITLE)
      await app.user.click(within(merge).getByRole("button", { name: "Approve merge" }))
      const before = boardReads(hq).length
      hq.state.nextError = {
        status: 409,
        body: { error: { code: "CONFLICT", message: "The pull request changed since you looked" } },
      }
      await app.user.click(within(merge).getByRole("button", { name: "Confirm" }))
      expect((await within(merge).findByRole("alert")).textContent).toBe(
        "The pull request changed since you looked. Review it again.",
      )
      await waitFor(() => expect(boardReads(hq).length).toBeGreaterThan(before))
      expect(posts(hq)).toHaveLength(1)
    })

    /** The pull request's head moves on (hq: a push voids the pending approval and makes a new one). */
    const moveHead = (hq: FakeHq, headSha: string) => {
      const item = hq.state.workItems[WORK_IDS.review]
      if (!item?.pullRequest || !item.mergeApproval)
        throw new Error("the review item has no pull request")
      item.pullRequest.headSha = headSha
      item.mergeApproval.headSha = headSha
      hq.state.workBoard.needsYou = hq.state.workBoard.needsYou.map((n) =>
        n.itemId === WORK_IDS.review && n.merge
          ? {
              ...n,
              merge: { ...n.merge, headSha },
              reason: n.reason.replace(/at \w{7}\./, `at ${headSha.slice(0, 7)}.`),
            }
          : n,
      )
    }

    it("a new head restarts the confirmation, and Confirm on a stale card sends the head that was shown and gets hq's own 409", async () => {
      const B = "b".repeat(40)
      const C = "c".repeat(40)
      const hq = createFakeHq({ workBoard: boardOfFour() })
      const app = await renderApp({ path: "/app/approvals", hq })
      const merge = await card(app, MERGE_TITLE)
      expect(merge.textContent).toContain("head aaaaaaa")

      // (a) The head moves while the confirmation is open: a board read brings the new head, the
      // confirmation closes (it is a new question), the new sha shows, and nothing was posted.
      await app.user.click(within(merge).getByRole("button", { name: "Approve merge" }))
      expect(within(merge).getByRole("group", { name: "Approve merge" }).textContent).toContain(
        "aaaaaaa",
      )
      moveHead(hq, B)
      await act(() => app.queryClient.invalidateQueries({ queryKey: ["work"] }))
      await waitFor(() => expect(merge.textContent).toContain("head bbbbbbb"))
      expect(within(merge).queryByRole("group", { name: "Approve merge" })).toBeNull()
      expect(within(merge).queryByRole("button", { name: "Confirm" })).toBeNull()
      expect(within(merge).getByRole("button", { name: "Approve merge" })).toBeTruthy()
      expect(posts(hq)).toEqual([])

      // (b) A confirmation opened at B, then the head moves to C before the card learns of it:
      // Confirm sends B (the sha that was shown), hq's own check refuses it (no nextError), and
      // after the card re-renders with C its confirmation is closed and hq's words are still there.
      await app.user.click(within(merge).getByRole("button", { name: "Approve merge" }))
      expect(within(merge).getByRole("group", { name: "Approve merge" }).textContent).toContain(
        "bbbbbbb",
      )
      moveHead(hq, C)
      await app.user.click(within(merge).getByRole("button", { name: "Confirm" }))
      await waitFor(() => expect(merge.textContent).toContain("head ccccccc"))
      expect(posts(hq)).toEqual([
        {
          method: "POST",
          path: `/v1/work-items/${WORK_IDS.review}/merge-approval`,
          search: "",
          body: { headSha: B },
          credentials: "same-origin",
        },
      ])
      expect((await within(merge).findByRole("alert")).textContent).toBe(
        "The pull request changed since you looked. Review it again.",
      )
      expect(within(merge).queryByRole("group", { name: "Approve merge" })).toBeNull()
      expect(within(merge).queryByRole("button", { name: "Confirm" })).toBeNull()
      expect(within(merge).getByRole("button", { name: "Approve merge" })).toBeTruthy()
    })

    it("a 403 and any other 409 show hq's own words, and nothing is retried", async () => {
      const hq = createFakeHq({ workBoard: boardOfFour() })
      const app = await renderApp({ path: "/app/approvals", hq })
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
        expect(within(merge).getByRole("alert").textContent).toBe(
          "This merge is already approved.",
        ),
      )
      expect(posts(hq)).toHaveLength(2)
    })
  })

  describe("untrusted text", () => {
    it("a 40 000 character prompt and a title of HTML render as text, Show all is offered and the answer buttons stay", async () => {
      const hostile = '<img src=x onerror="alert(1)"> [pay now](https://evil.example/pay)'
      const base = boardOfFour()
      const board: WorkBoard = {
        ...base,
        needsYou: base.needsYou.map((n) => ({
          ...n,
          title: hostile,
          ...(n.question
            ? {
                question: {
                  ...n.question,
                  prompt: `${hostile}\n${"P".repeat(40_000)}`,
                },
              }
            : {}),
        })),
      }
      const app = await renderApp({
        path: "/app/approvals",
        hq: createFakeHq({ workBoard: board }),
      })
      const region = await pipeline(app)
      expect(app.container.querySelector("img")).toBeNull()
      expect(app.container.querySelector("a[href*='evil']")).toBeNull()
      expect(region.textContent).toContain('<img src=x onerror="alert(1)">')
      expect(region.textContent).toContain("[pay now](https://evil.example/pay)")
      const mergeCard = [...region.querySelectorAll("article")].find((a) =>
        a.textContent?.includes("merge approval"),
      ) as HTMLElement
      expect(within(mergeCard).getByRole("button", { name: "Approve merge" })).toBeTruthy()
      const asking = [...region.querySelectorAll("article")].find((a) =>
        a.textContent?.includes("(default)"),
      ) as HTMLElement
      expect(within(asking).getByRole("button", { name: "Half up (default)" })).toBeTruthy()
      expect(within(asking).getByRole("button", { name: "Half to even" })).toBeTruthy()
      expect(within(asking).getByRole("button", { name: "Show all" })).toBeTruthy()
      // The only links are hq's own: the pull request and the item.
      for (const link of region.querySelectorAll("a")) {
        expect(link.getAttribute("href") ?? "").toMatch(
          /^(https:\/\/github\.com\/acme\/web\/pull\/106|\/app\/work\/FAC-\d+)$/,
        )
      }
      for (const button of region.querySelectorAll("button")) {
        expect(button.closest("h3, p")).toBeNull()
      }
    })

    it("Review diff is a link only for the item's own pull request page", async () => {
      const base = boardOfFour()
      const evil = {
        ...base,
        needsYou: base.needsYou.map((n) =>
          n.merge
            ? {
                ...n,
                merge: { ...n.merge, pullRequestUrl: "https://evil.example/acme/web/pull/106" },
              }
            : n,
        ),
      }
      const app = await renderApp({
        path: "/app/approvals",
        hq: createFakeHq({ workBoard: evil }),
      })
      const merge = await card(app, MERGE_TITLE)
      expect(within(merge).queryByRole("link", { name: "Review diff" })).toBeNull()
    })
  })

  it("a draft pull request says draft beside the head sha", async () => {
    const base = boardOfFour()
    const draft = {
      ...base,
      needsYou: base.needsYou.map((n) =>
        n.merge ? { ...n, merge: { ...n.merge, isDraft: true } } : n,
      ),
    }
    const app = await renderApp({ path: "/app/approvals", hq: createFakeHq({ workBoard: draft }) })
    const merge = await card(app, MERGE_TITLE)
    expect(merge.textContent).toMatch(/head aaaaaaa · draft/)
  })

  it("no write is sent on load, focus, visibility or retry, and no inline style or a11y violation", async () => {
    const hq = createFakeHq({
      proposals: [proposalFixture({ id: "p-1", title: "Tone of voice" })],
      workBoard: boardOfFour(),
    })
    const app = await renderApp({ path: "/app/approvals", hq })
    await card(app, MERGE_TITLE)
    fireEvent.focus(window)
    fireEvent(document, new Event("visibilitychange"))
    fireEvent(window, new Event("online"))
    await app.queryClient.invalidateQueries({ queryKey: ["work"] })
    await app.queryClient.invalidateQueries({ queryKey: ["proposals"] })
    expect(posts(hq)).toEqual([])
    expect(hq.sent.every((s) => s.method === "GET")).toBe(true)
    expect(app.container.querySelector("[style]")).toBeNull()
    await expectNoA11yViolations(app.container.innerHTML)
  })

  it("every control in the pipeline section is at least min-h-touch", async () => {
    const app = await renderApp({
      path: "/app/approvals",
      hq: createFakeHq({ workBoard: boardOfFour() }),
    })
    const region = await pipeline(app)
    const controls = region.querySelectorAll("a, button")
    expect(controls.length).toBeGreaterThan(6)
    for (const control of controls) {
      expect(control.className, control.textContent ?? control.tagName).toContain("min-h-touch")
    }
  })
})
