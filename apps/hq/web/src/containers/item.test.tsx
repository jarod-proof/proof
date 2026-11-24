// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { act, fireEvent, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { WorkItemDetail } from "../api/schemas"
import { createFakeHq, type FakeHq } from "../test/fake-hq"
import {
  doneItemFixture,
  questionFixture,
  triageItemFixture,
  WORK_HEAD_SHA,
  WORK_IDS,
  workItemFixture,
} from "../test/fixtures"
import { renderApp } from "../test/render"

type App = Awaited<ReturnType<typeof renderApp>>

const SHA7 = WORK_HEAD_SHA.slice(0, 7)
const posts = (hq: FakeHq) => hq.sent.filter((s) => s.method !== "GET")
const itemReads = (hq: FakeHq) => hq.sent.filter((s) => /^\/v1\/work-items\/[^/]+$/.test(s.path))

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

/** The page's own content (the sidebar has its own "Work" link and buttons). */
const page = async (app: App, name?: string) => {
  await app.findByRole("heading", { level: 1, name: name ?? /./ })
  return within(app.container.querySelector("main") as HTMLElement)
}
const region = (main: ReturnType<typeof within>, name: string | RegExp) =>
  main.getByRole("region", { name })

const twice = (button: HTMLElement) =>
  act(async () => {
    button.click()
    button.click()
  })

function setItem(hq: FakeHq, item: WorkItemDetail) {
  hq.state.workItems[item.id] = item
}

describe("the Item detail screen", () => {
  it("renders the header, the stage strip, the contract, the two attempts and the pull request panel", async () => {
    const app = await renderApp({ path: "/app/work/FAC-6" })
    const main = await page(app, "Empty cart crashes the checkout")
    expect(main.getByRole("link", { name: "Work" }).getAttribute("href")).toBe("/app/work")
    expect(main.getByRole("list", { name: "Progress" })).toBeTruthy()
    const contract = region(main, "Plan and verification contract")
    expect(contract.textContent).toContain("Recorded before the first attempt.")
    expect(within(contract).getByText("The checks of the pull request pass")).toBeTruthy()
    expect(within(region(main, "Attempts")).getAllByRole("article")).toHaveLength(2)
    expect(region(main, "PR #106").textContent).toContain("Merge approval waits for a founder")
  })

  it("an item is found by its uuid as well as by FAC-<n>", async () => {
    const app = await renderApp({ path: `/app/work/${WORK_IDS.review}` })
    expect(
      await app.findByRole("heading", { level: 1, name: "Empty cart crashes the checkout" }),
    ).toBeTruthy()
  })

  it("marks Work as the current screen in the sidebar", async () => {
    const app = await renderApp({ path: "/app/work/FAC-6" })
    await page(app)
    expect(
      app
        .getAllByRole("link", { name: /Work/ })
        .some((l) => l.getAttribute("aria-current") === "page"),
    ).toBe(true)
  })

  it("an open question sends one POST with the option and the page shows 'You answered A'", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/work/FAC-2", hq })
    const main = await page(app)
    await app.user.click(
      within(region(main, "Questions from agents")).getByRole("button", { name: /Half up/ }),
    )
    await within(region(main, "Questions from agents")).findByText("You answered A")
    expect(posts(hq)).toEqual([
      {
        method: "POST",
        path: `/v1/questions/${WORK_IDS.question}/answer`,
        search: "",
        body: { optionId: "up" },
        credentials: "same-origin",
      },
    ])
    expect((await app.findByRole("status", { name: "Last action" })).textContent).toBe(
      "Answer sent for FAC-2.",
    )
    // The buttons are gone: answered.
    expect(within(region(main, "Questions from agents")).queryByRole("button")).toBeNull()
  })

  it("approving a merge from the panel sends one POST and the text changes to the approved line", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/work/FAC-6", hq })
    const main = await page(app)
    const panel = region(main, "PR #106")
    await app.user.click(within(panel).getByRole("button", { name: "Approve merge" }))
    expect(posts(hq)).toEqual([])
    const group = within(panel).getByRole("group", { name: "Approve merge" })
    expect(group.textContent).toContain(SHA7)
    await app.user.click(within(group).getByRole("button", { name: "Confirm" }))
    await waitFor(() =>
      expect(region(main, "PR #106").textContent).toContain(
        `Approved by Founder for ${SHA7}; merge it on GitHub`,
      ),
    )
    expect(posts(hq)).toEqual([
      {
        method: "POST",
        path: `/v1/work-items/${WORK_IDS.review}/merge-approval`,
        search: "",
        body: { headSha: WORK_HEAD_SHA },
        credentials: "same-origin",
      },
    ])
    expect((await app.findByRole("status", { name: "Last action" })).textContent).toBe(
      `Merge approved for FAC-6 at ${SHA7}. Nothing was merged: merge it on GitHub.`,
    )
    // The decision's author is a name, never the id hq stores.
    expect(app.container.textContent).not.toContain("user-1")
  })

  it("another founder's approval reads 'a founder', not an id", async () => {
    const hq = createFakeHq()
    const base = workItemFixture()
    setItem(hq, {
      ...base,
      mergeApproval: {
        ...(base.mergeApproval as NonNullable<WorkItemDetail["mergeApproval"]>),
        status: "approved",
        decidedBy: "someone-else-7",
        decidedAt: "2026-11-17T12:10:00.000Z",
      },
    })
    const app = await renderApp({ path: "/app/work/FAC-6", hq })
    const main = await page(app)
    expect(region(main, "PR #106").textContent).toContain(
      `Approved by a founder for ${SHA7}; merge it on GitHub`,
    )
    expect(app.container.textContent).not.toContain("someone-else-7")
  })

  describe("double-click protection belongs to the container", () => {
    it("two quick clicks on Confirm of Approve merge send exactly one POST", async () => {
      const hq = createFakeHq()
      const hold = holdPosts(hq)
      const app = await renderApp({ path: "/app/work/FAC-6", hq })
      const main = await page(app)
      await app.user.click(
        within(region(main, "PR #106")).getByRole("button", { name: "Approve merge" }),
      )
      await twice(within(region(main, "PR #106")).getByRole("button", { name: "Confirm" }))
      expect(hold.reached()).toBe(1)
      // The second click is told so while the first is in flight, and not after it has finished.
      expect((await app.findByRole("alert")).textContent).toBe(
        "Another change is in flight. Try again when it has finished.",
      )
      hold.release()
      await waitFor(() => expect(region(main, "PR #106").textContent).toContain("Approved by"))
      expect(app.queryByRole("alert")).toBeNull()
      expect(posts(hq)).toHaveLength(1)
    })

    it("a double click (user events) on Confirm sends one POST and disables the controls meanwhile", async () => {
      const hq = createFakeHq()
      const hold = holdPosts(hq)
      const app = await renderApp({ path: "/app/work/FAC-6", hq })
      const main = await page(app)
      await app.user.click(
        within(region(main, "PR #106")).getByRole("button", { name: "Approve merge" }),
      )
      const confirm = within(region(main, "PR #106")).getByRole("button", { name: "Confirm" })
      await app.user.dblClick(confirm)
      expect((confirm as HTMLButtonElement).disabled).toBe(true)
      for (const button of main.getAllByRole("button")) {
        expect((button as HTMLButtonElement).disabled, button.textContent ?? "").toBe(true)
      }
      hold.release()
      await waitFor(() => expect(region(main, "PR #106").textContent).toContain("Approved by"))
      expect(posts(hq)).toHaveLength(1)
    })

    it("two quick clicks on an answer send exactly one POST", async () => {
      const hq = createFakeHq()
      const hold = holdPosts(hq)
      const app = await renderApp({ path: "/app/work/FAC-2", hq })
      const main = await page(app)
      await twice(
        within(region(main, "Questions from agents")).getByRole("button", { name: /Half up/ }),
      )
      expect(hold.reached()).toBe(1)
      hold.release()
      await within(region(main, "Questions from agents")).findByText("You answered A")
      expect(posts(hq)).toHaveLength(1)
    })

    it("an answer and an approval in one tick are one write", async () => {
      const hq = createFakeHq()
      const base = workItemFixture()
      setItem(hq, { ...base, questions: [questionFixture()] })
      const hold = holdPosts(hq)
      const app = await renderApp({ path: "/app/work/FAC-6", hq })
      const main = await page(app)
      await app.user.click(
        within(region(main, "PR #106")).getByRole("button", { name: "Approve merge" }),
      )
      const confirm = within(region(main, "PR #106")).getByRole("button", { name: "Confirm" })
      const answer = within(region(main, "Questions from agents")).getByRole("button", {
        name: /Half up/,
      })
      await act(async () => {
        answer.click()
        confirm.click()
      })
      expect(hold.reached()).toBe(1)
      hold.release()
      await waitFor(() => expect(posts(hq)).toHaveLength(1))
    })

    it("when two different controls are clicked in one tick, hq's refusal of the write that was sent is what the page shows", async () => {
      const hq = createFakeHq()
      const base = workItemFixture()
      setItem(hq, { ...base, questions: [questionFixture()] })
      const hold = holdPosts(hq)
      const app = await renderApp({ path: "/app/work/FAC-6", hq })
      const main = await page(app)
      await app.user.click(
        within(region(main, "PR #106")).getByRole("button", { name: "Approve merge" }),
      )
      const confirm = within(region(main, "PR #106")).getByRole("button", { name: "Confirm" })
      const answer = within(region(main, "Questions from agents")).getByRole("button", {
        name: /Half up/,
      })
      hq.state.nextError = {
        status: 409,
        body: { error: { code: "CONFLICT", message: "This question was already answered." } },
      }
      // The answer takes the lock; the approval is turned away and must not own the message.
      await act(async () => {
        answer.click()
        confirm.click()
      })
      expect(hold.reached()).toBe(1)
      hold.release()
      await waitFor(() =>
        expect(app.getByRole("alert").textContent).toBe("This question was already answered."),
      )
      expect(posts(hq)).toHaveLength(1)
    })

    it("a double click on one control does not make a later write on another control say 'in flight'", async () => {
      const hq = createFakeHq()
      // The client keeps the fetch it was built with, so the hold is one wrapper with a gate that
      // can be armed again for each write.
      const real = hq.fetch
      let gate: Promise<void> = Promise.resolve()
      let reached = 0
      hq.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET").toUpperCase() === "POST") {
          reached += 1
          await gate
        }
        return real(input, init)
      }) as typeof fetch
      const arm = () => {
        let release = () => {}
        gate = new Promise<void>((resolve) => {
          release = resolve
        })
        reached = 0
        return release
      }
      const app = await renderApp({ path: "/app/work/FAC-6", hq })
      const main = await page(app)
      const releaseStop = arm()
      await app.user.click(main.getByRole("button", { name: "Stop item" }))
      await twice(
        within(main.getByRole("group", { name: "Stop item" })).getByRole("button", {
          name: "Stop item",
        }),
      )
      expect(reached).toBe(1)
      releaseStop()
      await waitFor(() =>
        expect(
          (main.getByRole("button", { name: "Reopen item" }) as HTMLButtonElement).disabled,
        ).toBe(false),
      )
      expect(app.queryByRole("alert")).toBeNull()
      // A different control, held in flight: nothing was turned away, so nothing says so.
      const releaseReopen = arm()
      await app.user.click(main.getByRole("button", { name: "Reopen item" }))
      await app.user.click(
        within(main.getByRole("group", { name: "Reopen item" })).getByRole("button", {
          name: "Reopen",
        }),
      )
      expect(reached).toBe(1)
      expect(app.queryByRole("alert")).toBeNull()
      releaseReopen()
      await waitFor(() => expect(posts(hq)).toHaveLength(2))
      expect(app.queryByRole("alert")).toBeNull()
    })

    it("two quick clicks on the confirmation of a stop send one POST", async () => {
      const hq = createFakeHq()
      const hold = holdPosts(hq)
      const app = await renderApp({ path: "/app/work/FAC-6", hq })
      const main = await page(app)
      await app.user.click(main.getByRole("button", { name: "Stop item" }))
      await twice(
        within(main.getByRole("group", { name: "Stop item" })).getByRole("button", {
          name: "Stop item",
        }),
      )
      expect(hold.reached()).toBe(1)
      hold.release()
      await waitFor(() => expect(posts(hq)).toHaveLength(1))
    })
  })

  it("a refused write shows hq's own words on the page, re-reads, and sends nothing twice", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/work/FAC-6", hq })
    const main = await page(app)
    await app.user.click(
      within(region(main, "PR #106")).getByRole("button", { name: "Approve merge" }),
    )
    const reads = itemReads(hq).length
    hq.state.nextError = {
      status: 409,
      body: {
        error: { code: "CONFLICT", message: "The pull request changed since you looked" },
      },
    }
    await app.user.click(within(region(main, "PR #106")).getByRole("button", { name: "Confirm" }))
    const alert = await app.findByRole("alert")
    expect(alert.textContent).toBe("The pull request changed since you looked. Review it again.")
    // A conflict re-reads the item: it is the truth now.
    await waitFor(() => expect(itemReads(hq).length).toBeGreaterThan(reads))
    expect(posts(hq)).toHaveLength(1)
  })

  it("evidence renders the payload text and never as markup", async () => {
    const hq = createFakeHq()
    const base = workItemFixture()
    const hostile = '<img src=x onerror="alert(1)"> [pay](https://evil.example)'
    setItem(hq, {
      ...base,
      signal: { ...(base.signal as NonNullable<WorkItemDetail["signal"]>), evidence: hostile },
    })
    const app = await renderApp({ path: "/app/work/FAC-6", hq })
    const main = await page(app)
    expect(region(main, "Evidence").textContent).toContain(hostile)
    expect(app.container.querySelector("img")).toBeNull()
    expect(app.container.querySelector("a[href*='evil']")).toBeNull()
  })

  it("Stop watching in verify asks first (a running build finishes on its own), then sends one POST and the page says stopped", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/work/FAC-8", hq })
    const main = await page(app)
    expect(main.queryByRole("button", { name: "Stop item" })).toBeNull()
    await app.user.click(main.getByRole("button", { name: "Stop watching" }))
    expect(posts(hq)).toEqual([])
    const group = main.getByRole("group", { name: "Stop watching" })
    expect(group.textContent).toContain("finishes on its own")
    await app.user.click(within(group).getByRole("button", { name: "Stop watching" }))
    await waitFor(() =>
      expect(main.getByRole("region", { name: "About this item" }).textContent).toContain(
        "stopped by a founder",
      ),
    )
    expect(posts(hq)).toEqual([
      {
        method: "POST",
        path: `/v1/work-items/${WORK_IDS.verifying}/stop`,
        search: "",
        body: {},
        credentials: "same-origin",
      },
    ])
    // Stopped: nothing more to stop.
    expect((main.getByRole("button", { name: "Stop item" }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it("Stop item elsewhere sends the founder's note", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/work/FAC-6", hq })
    const main = await page(app)
    await app.user.click(main.getByRole("button", { name: "Stop item" }))
    const group = main.getByRole("group", { name: "Stop item" })
    await app.user.type(within(group).getByLabelText("Note (optional)"), "duplicate of FAC-3")
    await app.user.click(within(group).getByRole("button", { name: "Stop item" }))
    await waitFor(() => expect(posts(hq)).toHaveLength(1))
    expect(posts(hq)[0]?.body).toEqual({ note: "duplicate of FAC-3" })
  })

  it("Revert merge is absent without a merged pull request; its confirmation says nothing is reverted automatically", async () => {
    const none = await renderApp({ path: "/app/work/FAC-6" })
    const noMain = await page(none)
    expect(noMain.queryByRole("button", { name: "Revert merge" })).toBeNull()
    none.unmount()

    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/work/FAC-8", hq })
    const main = await page(app)
    await app.user.click(main.getByRole("button", { name: "Revert merge" }))
    const group = main.getByRole("group", { name: "Revert merge" })
    expect(group.textContent).toMatch(/Nothing is reverted automatically/)
    expect(posts(hq)).toEqual([])
    await app.user.click(within(group).getByRole("button", { name: "Request revert" }))
    await waitFor(() =>
      expect(main.getByRole("region", { name: "About this item" }).textContent).toContain(
        "reopened",
      ),
    )
    expect(posts(hq).map((p) => p.path)).toEqual([
      `/v1/work-items/${WORK_IDS.verifying}/revert-request`,
    ])
  })

  it("Reopen item from done sends one POST and the page shows the reopened state", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/work/FAC-10", hq })
    const main = await page(app)
    await app.user.click(main.getByRole("button", { name: "Reopen item" }))
    expect(posts(hq)).toEqual([])
    await app.user.click(
      within(main.getByRole("group", { name: "Reopen item" })).getByRole("button", {
        name: "Reopen",
      }),
    )
    await waitFor(() => {
      const meta = main.getByRole("region", { name: "About this item" }).textContent ?? ""
      expect(meta).toContain("reopened")
      expect(meta).toContain("back in triage")
    })
    expect(posts(hq)).toEqual([
      {
        method: "POST",
        path: `/v1/work-items/${WORK_IDS.done}/reopen`,
        search: "",
        body: {},
        credentials: "same-origin",
      },
    ])
    expect((await app.findByRole("status", { name: "Last action" })).textContent).toBe(
      "FAC-10 reopened; hq retriages it. No attempt was started.",
    )
  })

  it("reopening a stopped item says it is back in triage", async () => {
    const hq = createFakeHq()
    setItem(hq, doneItemFixture({ state: "stopped" }))
    const app = await renderApp({ path: "/app/work/FAC-10", hq })
    const main = await page(app)
    await app.user.click(main.getByRole("button", { name: "Reopen item" }))
    await app.user.click(
      within(main.getByRole("group", { name: "Reopen item" })).getByRole("button", {
        name: "Reopen",
      }),
    )
    expect((await app.findByRole("status", { name: "Last action" })).textContent).toBe(
      "FAC-10 reopened: back in triage. No attempt was started.",
    )
  })

  it("shows the item while the board that says how attempts start is still on its way", async () => {
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
    const app = await renderApp({ path: "/app/work/FAC-1", hq })
    const main = await page(app, "Checkout shows a blank page")
    expect(await main.findByText(/Checking how attempts start/)).toBeTruthy()
    expect(app.container.textContent).not.toContain("agent:build")
    release()
    expect(await main.findByText(/label to the issue to start the agent/)).toBeTruthy()
  })

  it("an item that used its attempts offers Retry with notes and sends the note once", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/work/FAC-5", hq })
    const main = await page(app)
    await app.user.click(main.getByRole("button", { name: "Retry with notes" }))
    await app.user.type(main.getByLabelText("Notes for the next attempt"), "Try the cursor query")
    await app.user.dblClick(main.getByRole("button", { name: "Allow one more attempt" }))
    await waitFor(() => expect(main.queryByRole("button", { name: "Retry with notes" })).toBeNull())
    expect(posts(hq)).toEqual([
      {
        method: "POST",
        path: `/v1/work-items/${WORK_IDS.exhausted}/retry`,
        search: "",
        body: { note: "Try the cursor query" },
        credentials: "same-origin",
      },
    ])
    expect(region(main, "Your notes").textContent).toContain("Try the cursor query")
  })

  describe("starting an attempt", () => {
    it("in label mode there is no Request attempt control, only the label instruction and the issue link", async () => {
      const hq = createFakeHq()
      const app = await renderApp({ path: "/app/work/FAC-1", hq })
      const main = await page(app)
      expect(main.queryByRole("button", { name: /Request/ })).toBeNull()
      const start = region(main, "Start an attempt")
      expect(start.textContent).toContain(
        "Add the agent:build label to the issue to start the agent (if it already has the label, remove it and add it again: GitHub starts a run only when the label is added).",
      )
      expect(within(start).getByRole("link", { name: /issue/i }).getAttribute("href")).toBe(
        "https://github.com/acme/web/issues/101",
      )
      expect(posts(hq)).toEqual([])
    })

    it("with no GitHub issue it says label mode cannot start the item", async () => {
      const hq = createFakeHq()
      const base = triageItemFixture()
      setItem(hq, {
        ...base,
        source: "ci_failure",
        signal: {
          ...(base.signal as NonNullable<WorkItemDetail["signal"]>),
          source: "ci_failure",
          url: null,
          urlChecked: false,
        },
      })
      const app = await renderApp({ path: "/app/work/FAC-1", hq })
      const main = await page(app)
      const start = region(main, "Start an attempt")
      expect(start.textContent).toContain("This item has no GitHub issue.")
      expect(start.textContent).toContain("label mode cannot start an item without one.")
      expect(within(start).queryByRole("link")).toBeNull()
    })

    it("an issue url hq did not check is no issue link", async () => {
      const hq = createFakeHq()
      const base = triageItemFixture()
      setItem(hq, {
        ...base,
        signal: {
          ...(base.signal as NonNullable<WorkItemDetail["signal"]>),
          url: "https://evil.example/acme/web/issues/101",
          urlChecked: false,
        },
      })
      const app = await renderApp({ path: "/app/work/FAC-1", hq })
      const main = await page(app)
      expect(within(region(main, "Start an attempt")).queryByRole("link")).toBeNull()
      expect(app.container.querySelector("a[href*='evil']")).toBeNull()
    })

    it("in claim mode Request attempt sends one POST with the kind and the instructions", async () => {
      const base = triageItemFixture()
      const hq = createFakeHq()
      hq.state.workBoard = { ...hq.state.workBoard, dispatch: "claim" }
      setItem(hq, { ...base, actions: { ...base.actions, canRequestAttempt: true } })
      const app = await renderApp({ path: "/app/work/FAC-1", hq })
      const main = await page(app)
      expect(app.container.textContent).not.toContain("agent:build")
      await app.user.type(
        main.getByLabelText("Instructions for the agent (optional)"),
        "start in cart.ts",
      )
      await app.user.dblClick(main.getByRole("button", { name: "Request an investigation" }))
      await waitFor(() => expect(posts(hq)).toHaveLength(1))
      expect(posts(hq)[0]).toEqual({
        method: "POST",
        path: `/v1/work-items/${WORK_IDS.triage}/attempt-requests`,
        search: "",
        body: { kind: "investigate", instructions: "start in cart.ts" },
        credentials: "same-origin",
      })
      await within(region(main, "Attempts")).findByText("Requested, not started")
    })

    it("when the board cannot be read the page says how attempts start is not known and offers nothing", async () => {
      const hq = createFakeHq()
      const real = hq.fetch
      hq.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url.startsWith("/v1/work/board")) {
          return new Response(
            JSON.stringify({ error: { code: "RATE_LIMITED", message: "slow" } }),
            {
              status: 429,
              headers: { "content-type": "application/json", "retry-after": "3" },
            },
          )
        }
        return real(input, init)
      }) as typeof fetch
      const app = await renderApp({ path: "/app/work/FAC-1", hq })
      const main = await page(app)
      expect(await main.findByText(/How attempts start could not be read/)).toBeTruthy()
      expect(main.queryByRole("button", { name: /Request/ })).toBeNull()
      expect(app.container.textContent).not.toContain("agent:build")
    })
  })

  it("a reopened item shows Triage as now with 'cycle 2'", async () => {
    const hq = createFakeHq()
    setItem(hq, triageItemFixture({ cycle: 2 }))
    const app = await renderApp({ path: "/app/work/FAC-1", hq })
    const main = await page(app)
    const triage = within(main.getByRole("list", { name: "Progress" }))
      .getByText("Triage")
      .closest("li")
    expect(triage?.textContent).toContain("cycle 2")
  })

  describe("when the page cannot be shown", () => {
    it("FAC-999 is a not-found state with a link back to Work", async () => {
      const app = await renderApp({ path: "/app/work/FAC-999" })
      expect(await app.findByText("Work item not found")).toBeTruthy()
      expect(app.getByText(/FAC-999/)).toBeTruthy()
      expect(app.getByRole("link", { name: "Back to Work" }).getAttribute("href")).toBe("/app/work")
      expect(app.queryByRole("button", { name: "Retry" })).toBeNull()
      expect(app.queryByRole("button", { name: /Stop|Reopen|Approve/ })).toBeNull()
    })

    it("a reference that is not an id is also not found, and the url text stays text", async () => {
      const app = await renderApp({ path: "/app/work/%3Cimg%20src=x%20onerror=alert(1)%3E" })
      expect(await app.findByText("Work item not found")).toBeTruthy()
      expect(app.container.querySelector("img")).toBeNull()
      expect(app.container.textContent).toContain("<img src=x onerror=alert(1)>")
    })

    it("a 401 on the item read is not 'not found': it shows the sign-in error, with Retry", async () => {
      const hq = createFakeHq()
      const real = hq.fetch
      hq.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url.startsWith("/v1/work-items/")) {
          return new Response(
            JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Send an API key" } }),
            { status: 401, headers: { "content-type": "application/json" } },
          )
        }
        return real(input, init)
      }) as typeof fetch
      const app = await renderApp({ path: "/app/work/FAC-6", hq })
      expect(await app.findByText("Sign in required")).toBeTruthy()
      expect(app.queryByText("Work item not found")).toBeNull()
      expect(app.getByRole("button", { name: "Retry" })).toBeTruthy()
      expect(posts(hq)).toEqual([])
    })

    it("a session that ended (the gate's probe answers 401) lands on sign-in, not on 'not found'", async () => {
      const hq = createFakeHq({ caller: "signed-out" })
      const app = await renderApp({ path: "/app/work/FAC-6", hq })
      expect(await app.findByLabelText("Email")).toBeTruthy()
      expect(app.queryByText("Work item not found")).toBeNull()
      expect(app.router.state.location.pathname).toBe("/sign-in")
    })

    it("hq's refusal and a non-founder come from the gate, not from the page", async () => {
      const refused = await renderApp({
        path: "/app/work/FAC-6",
        hq: createFakeHq({ caller: "refused" }),
      })
      expect(await refused.findByText("hq refused to start")).toBeTruthy()
      expect(refused.queryByRole("heading", { level: 1, name: /cart/ })).toBeNull()
      refused.unmount()
      const other = await renderApp({
        path: "/app/work/FAC-6",
        hq: createFakeHq({ caller: "non-founder" }),
      })
      expect(await other.findByText(/not a founder/i)).toBeTruthy()
      expect(other.queryByRole("heading", { level: 1, name: /cart/ })).toBeNull()
    })

    it("shows loading while the item is on its way", async () => {
      const hq = createFakeHq()
      const real = hq.fetch
      let release = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      hq.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url.startsWith("/v1/work-items/")) await gate
        return real(input, init)
      }) as typeof fetch
      const app = await renderApp({ path: "/app/work/FAC-6", hq })
      expect(await app.findByText("Loading the work item")).toBeTruthy()
      release()
      expect(
        await app.findByRole("heading", { level: 1, name: "Empty cart crashes the checkout" }),
      ).toBeTruthy()
    })

    it("shows an error with Retry that asks again, and sends no write", async () => {
      const hq = createFakeHq()
      const real = hq.fetch
      let refuse = true
      hq.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (refuse && url.startsWith("/v1/work-items/")) {
          return new Response(
            JSON.stringify({ error: { code: "RATE_LIMITED", message: "slow" } }),
            {
              status: 429,
              headers: { "content-type": "application/json", "retry-after": "3" },
            },
          )
        }
        return real(input, init)
      }) as typeof fetch
      const app = await renderApp({ path: "/app/work/FAC-6", hq })
      expect(await app.findByText("Too many attempts")).toBeTruthy()
      refuse = false
      await app.user.click(app.getByRole("button", { name: "Retry" }))
      expect(
        await app.findByRole("heading", { level: 1, name: "Empty cart crashes the checkout" }),
      ).toBeTruthy()
      expect(posts(hq)).toEqual([])
    })
  })

  it("no write is sent on load, focus, visibility, going online or a re-read", async () => {
    const hq = createFakeHq()
    const app = await renderApp({ path: "/app/work/FAC-6", hq })
    await page(app)
    fireEvent.focus(window)
    fireEvent(document, new Event("visibilitychange"))
    fireEvent(window, new Event("online"))
    await app.queryClient.invalidateQueries({ queryKey: ["work"] })
    expect(posts(hq)).toEqual([])
    expect(hq.sent.every((s) => s.method === "GET")).toBe(true)
  })

  it("renders no inline style, every control is min-h-touch and there are no accessibility violations", async () => {
    const hq = createFakeHq()
    const base = workItemFixture()
    setItem(hq, { ...base, questions: [questionFixture()] })
    const app = await renderApp({ path: "/app/work/FAC-6", hq })
    const main = await page(app)
    await app.user.click(main.getByRole("button", { name: "Stop item" }))
    expect(app.container.querySelector("[style]")).toBeNull()
    const controls = (app.container.querySelector("main") as HTMLElement).querySelectorAll(
      "a, button, input, textarea, select",
    )
    expect(controls.length).toBeGreaterThan(8)
    for (const control of controls) {
      expect(control.className, control.textContent ?? control.tagName).toContain("min-h-touch")
    }
    await expectNoA11yViolations(app.container.innerHTML)
  })

  it("done items show their chart to the window end and the passed window", async () => {
    const hq = createFakeHq()
    setItem(hq, doneItemFixture())
    const app = await renderApp({ path: "/app/work/FAC-10", hq })
    const main = await page(app)
    const win = region(main, "Verification window")
    expect(within(win).getByText("window end")).toBeTruthy()
  })
})
