// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { act, type RenderResult, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { AttemptView, WorkItemDetail } from "../api/schemas"
import {
  askingItemFixture,
  doneItemFixture,
  exhaustedItemFixture,
  questionFixture,
  triageItemFixture,
  verifyingItemFixture,
  WORK_HEAD_SHA,
  WORK_IDS,
  workItemFixture,
} from "../test/fixtures"
import { renderInRouter } from "../test/render"
import { type ItemActions, ItemPage } from "./item-page"

const SHA7 = WORK_HEAD_SHA.slice(0, 7)

function actionsOf(overrides: Partial<ItemActions> = {}): ItemActions {
  return {
    onStop: vi.fn(),
    onReopen: vi.fn(),
    onRevert: vi.fn(),
    onRetry: vi.fn(),
    onRequestAttempt: vi.fn(),
    onAnswer: vi.fn(),
    onApproveMerge: vi.fn(),
    pending: null,
    error: null,
    notice: null,
    ...overrides,
  }
}

async function show(
  item: WorkItemDetail,
  options: {
    actions?: Partial<ItemActions>
    dispatch?: "label" | "claim" | null
    issueUrl?: string | null
    approvedBy?: string | null
    transcript?: Parameters<typeof ItemPage>[0]["transcript"]
  } = {},
) {
  const actions = actionsOf(options.actions)
  const view = await renderInRouter(
    <ItemPage
      item={item}
      transcript={options.transcript ?? { kind: "not-recorded" }}
      actions={actions}
      dispatch={options.dispatch === undefined ? "label" : options.dispatch}
      issueUrl={options.issueUrl ?? null}
      approvedBy={options.approvedBy ?? null}
    />,
  )
  return { view, actions, user: userEvent.setup() }
}

const section = (view: RenderResult, name: string | RegExp) => view.getByRole("region", { name })
const attempt = (n: number, overrides: Partial<AttemptView> = {}): AttemptView => ({
  ...(workItemFixture().attemptList[1] as AttemptView),
  id: `00000000-0000-4000-8000-0000000009${String(n).padStart(2, "0")}`,
  number: n,
  reviewer: null,
  ...overrides,
})

describe("ItemPage header", () => {
  it("has a back link to Work, the title as the h1 and the mock's meta row", async () => {
    const { view } = await show(workItemFixture())
    const back = view.getByRole("link", { name: "Work" })
    expect(back.getAttribute("href")).toBe("/app/work")
    expect(view.getByRole("heading", { level: 1 }).textContent).toBe(
      "Empty cart crashes the checkout",
    )
    const meta = view.getByRole("region", { name: "About this item" })
    expect(meta.textContent).toContain("FAC-6")
    expect(meta.textContent).toContain("GitHub · acme/web")
    expect(meta.textContent).toContain("Empty cart crashes the checkout.")
    expect(meta.textContent).toContain("first seen 2026-11-17 12:00 UTC")
    // The state chip is hq's card, in hq's words.
    expect(meta.textContent).toContain("needs you")
    expect(meta.textContent).toContain("merge approval")
  })

  it("says how many times the signal came when it came more than once", async () => {
    const { view } = await show(verifyingItemFixture())
    expect(view.getByRole("region", { name: "About this item" }).textContent).toContain(
      "5 occurrences",
    )
    view.unmount()
    const once = await show(workItemFixture())
    expect(once.view.getByRole("region", { name: "About this item" }).textContent).not.toMatch(
      /occurrences/,
    )
  })

  it("names the sections in the mock's order, then the history", async () => {
    const { view } = await show(verifyingItemFixture())
    const headings = [...view.container.querySelectorAll("h2")].map((h) => h.textContent)
    expect(headings).toEqual([
      "Progress",
      "Plan and verification contract",
      "Attempts",
      "Questions from agents",
      "Attempt 2 transcript",
      "PR #108",
      "Evidence",
      "Verification window",
      "History",
    ])
  })

  it("shows the contract's heading and its line, and the stage strip", async () => {
    const { view } = await show(workItemFixture())
    const contract = section(view, "Plan and verification contract")
    expect(contract.textContent).toContain(
      "Recorded before the first attempt. Done means these hold.",
    )
    expect(within(contract).getByText("The reported flow works again")).toBeTruthy()
    expect(view.getByRole("list", { name: "Progress" })).toBeTruthy()
  })

  it("a reopened item shows Triage as now with 'cycle 2'", async () => {
    const { view } = await show(triageItemFixture({ cycle: 2 }))
    const triage = within(view.getByRole("list", { name: "Progress" }))
      .getByText("Triage")
      .closest("li") as HTMLElement
    expect(triage.getAttribute("aria-current")).toBe("step")
    expect(triage.textContent).toContain("cycle 2")
  })
})

describe("ItemPage decisions", () => {
  it("Stop watching in verify and Stop item elsewhere", async () => {
    const watching = await show(verifyingItemFixture())
    expect(watching.view.getByRole("button", { name: "Stop watching" })).toBeTruthy()
    expect(watching.view.queryByRole("button", { name: "Stop item" })).toBeNull()
    watching.view.unmount()
    const review = await show(workItemFixture())
    expect(review.view.getByRole("button", { name: "Stop item" })).toBeTruthy()
    expect(review.view.queryByRole("button", { name: "Stop watching" })).toBeNull()
  })

  it("Stop needs the confirmation, whose text says a running build finishes on its own, and calls onStop once", async () => {
    const { view, actions, user } = await show(workItemFixture())
    await user.click(view.getByRole("button", { name: "Stop item" }))
    expect(actions.onStop).not.toHaveBeenCalled()
    const group = view.getByRole("group", { name: "Stop item" })
    expect(group.textContent).toContain(
      "This stops the item in hq. A build already running on GitHub finishes on its own and its pull request is recorded on the stopped item.",
    )
    await user.click(within(group).getByRole("button", { name: "Stop item" }))
    expect(actions.onStop).toHaveBeenCalledTimes(1)
    expect(actions.onStop).toHaveBeenCalledWith(undefined)
  })

  it("a note typed in the confirmation is sent trimmed; a blank one is not", async () => {
    const { view, actions, user } = await show(workItemFixture())
    await user.click(view.getByRole("button", { name: "Stop item" }))
    const group = view.getByRole("group", { name: "Stop item" })
    await user.type(within(group).getByLabelText("Note (optional)"), "  duplicate of FAC-3  ")
    await user.click(within(group).getByRole("button", { name: "Stop item" }))
    expect(actions.onStop).toHaveBeenCalledWith("duplicate of FAC-3")
  })

  it("Cancel sends nothing", async () => {
    const { view, actions, user } = await show(workItemFixture())
    await user.click(view.getByRole("button", { name: "Stop item" }))
    await user.click(view.getByRole("button", { name: "Cancel" }))
    expect(actions.onStop).not.toHaveBeenCalled()
    expect(view.queryByRole("group", { name: "Stop item" })).toBeNull()
  })

  it("Revert merge is absent unless hq allows it; its confirmation says nothing is reverted automatically", async () => {
    const none = await show(workItemFixture())
    expect(none.view.queryByRole("button", { name: "Revert merge" })).toBeNull()
    none.view.unmount()
    const { view, actions, user } = await show(verifyingItemFixture())
    await user.click(view.getByRole("button", { name: "Revert merge" }))
    const group = view.getByRole("group", { name: "Revert merge" })
    expect(group.textContent).toMatch(/Nothing is reverted automatically/)
    expect(actions.onRevert).not.toHaveBeenCalled()
    await user.click(within(group).getByRole("button", { name: "Request revert" }))
    expect(actions.onRevert).toHaveBeenCalledTimes(1)
  })

  it("Reopen item asks first, then calls onReopen once", async () => {
    const { view, actions, user } = await show(doneItemFixture())
    await user.click(view.getByRole("button", { name: "Reopen item" }))
    expect(actions.onReopen).not.toHaveBeenCalled()
    const group = view.getByRole("group", { name: "Reopen item" })
    await user.click(within(group).getByRole("button", { name: "Reopen" }))
    expect(actions.onReopen).toHaveBeenCalledTimes(1)
  })

  it("a decision hq does not allow is disabled and says why", async () => {
    const done = await show(doneItemFixture())
    const stop = done.view.getByRole("button", { name: "Stop item" }) as HTMLButtonElement
    expect(stop.disabled).toBe(true)
    expect(
      done.view.getByText(
        "A founder can stop an item in triage, plan, attempt, review, deploy or verify; not from this state.",
      ),
    ).toBeTruthy()
    expect(stop.getAttribute("aria-describedby")).toBeTruthy()
    done.view.unmount()
    const review = await show(workItemFixture())
    const reopen = review.view.getByRole("button", { name: "Reopen item" }) as HTMLButtonElement
    expect(reopen.disabled).toBe(true)
    expect(
      review.view.getByText(/Only a verifying, done or stopped item can be reopened/),
    ).toBeTruthy()
  })

  it("while a write is on its way every decision is disabled", async () => {
    const { view } = await show(verifyingItemFixture(), { actions: { pending: "stop" } })
    for (const button of view.container.querySelectorAll("button")) {
      expect((button as HTMLButtonElement).disabled, button.textContent ?? "").toBe(true)
    }
  })

  it("while a write is on its way an open question cannot be answered either", async () => {
    const { view } = await show(askingItemFixture(), { actions: { pending: "approve" } })
    const answers = within(section(view, "Questions from agents")).getAllByRole("button")
    expect(answers).toHaveLength(2)
    for (const button of answers) expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it("shows the notice and the error of the last write", async () => {
    const { view } = await show(workItemFixture(), {
      actions: { notice: "FAC-6 stopped.", error: "That was already decided." },
    })
    expect(view.getByRole("status", { name: "Last action" }).textContent).toBe("FAC-6 stopped.")
    expect(view.getByRole("alert").textContent).toBe("That was already decided.")
  })
})

describe("ItemPage starting an attempt", () => {
  const ISSUE = "https://github.com/acme/web/issues/101"
  const LABEL_COPY =
    "Add the agent:build label to the issue to start the agent (if it already has the label, remove it and add it again: GitHub starts a run only when the label is added)."

  it("in label mode there is no Request attempt control; the label instruction links the issue", async () => {
    const { view } = await show(triageItemFixture(), { dispatch: "label", issueUrl: ISSUE })
    expect(view.queryByRole("button", { name: /Request/ })).toBeNull()
    const start = view.getByRole("region", { name: "Start an attempt" })
    expect(start.textContent).toContain(LABEL_COPY)
    const link = within(start).getByRole("link", { name: /issue/i })
    expect(link.getAttribute("href")).toBe(ISSUE)
    expect(link.className).toContain("min-h-touch")
    expect(link.getAttribute("rel")).toContain("noreferrer")
  })

  it("an item without an issue says label mode cannot start it", async () => {
    const { view } = await show(triageItemFixture(), { dispatch: "label", issueUrl: null })
    const start = view.getByRole("region", { name: "Start an attempt" })
    expect(start.textContent).toContain(
      "This item has no GitHub issue. Open an issue for it and add the agent:build label; label mode cannot start an item without one.",
    )
    expect(within(start).queryByRole("link")).toBeNull()
  })

  it("a done or stopped item has no instruction to start an attempt", async () => {
    const { view } = await show(doneItemFixture(), { dispatch: "label", issueUrl: ISSUE })
    expect(view.queryByRole("region", { name: "Start an attempt" })).toBeNull()
    expect(view.container.textContent).not.toContain("agent:build")
  })

  it("claim mode asks for an investigation from triage with optional instructions, one call; a fix is not offered there", async () => {
    const item = triageItemFixture({
      actions: { ...triageItemFixture().actions, canRequestAttempt: true },
    })
    const { view, actions, user } = await show(item, { dispatch: "claim" })
    expect(view.container.textContent).not.toContain("agent:build")
    await user.type(
      view.getByLabelText("Instructions for the agent (optional)"),
      "  start in cart.ts ",
    )
    await user.click(view.getByRole("button", { name: "Request an investigation" }))
    expect(actions.onRequestAttempt).toHaveBeenCalledWith("investigate", "start in cart.ts")
    expect(actions.onRequestAttempt).toHaveBeenCalledTimes(1)
    // hq refuses a fix from triage ("Investigate first"): the button says so and sends nothing.
    const fix = view.getByRole("button", { name: "Request a fix attempt" }) as HTMLButtonElement
    expect(fix.disabled).toBe(true)
    expect(view.container.textContent).toContain(
      "Investigate first: a fix starts from plan, attempt or review.",
    )
  })

  it("claim mode offers both kinds in plan, only a fix in attempt and review, and never a fix without budget", async () => {
    const enabled = async (
      state: WorkItemDetail["state"],
      attempts?: WorkItemDetail["attempts"],
    ) => {
      const base = triageItemFixture()
      const item = triageItemFixture({
        state,
        actions: { ...base.actions, canRequestAttempt: true },
        ...(attempts ? { attempts } : {}),
      })
      const { view } = await show(item, { dispatch: "claim" })
      const flag = (name: string) =>
        !(view.getByRole("button", { name }) as HTMLButtonElement).disabled
      const result = {
        investigate: flag("Request an investigation"),
        fix: flag("Request a fix attempt"),
        text: view.container.textContent ?? "",
      }
      view.unmount()
      return result
    }
    expect(await enabled("plan")).toMatchObject({ investigate: true, fix: true })
    const attempt = await enabled("attempt", { used: 1, limit: 3, running: false })
    expect(attempt).toMatchObject({ investigate: false, fix: true })
    expect(attempt.text).toContain("An investigation starts from triage or plan, not from attempt.")
    expect(await enabled("review", { used: 1, limit: 3, running: false })).toMatchObject({
      investigate: false,
      fix: true,
    })
    // Plan with the fix budget spent: an investigation may still start, a fix may not.
    const spent = await enabled("plan", { used: 3, limit: 3, running: false })
    expect(spent).toMatchObject({ investigate: true, fix: false })
    expect(spent.text).toContain("This item has used its fix attempts for this cycle.")
  })

  it("claim mode with canRequestAttempt false disables both and says why", async () => {
    const { view } = await show(triageItemFixture(), { dispatch: "claim" })
    for (const name of ["Request an investigation", "Request a fix attempt"]) {
      expect((view.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true)
    }
    expect(view.getByText(/hq does not allow a request right now/)).toBeTruthy()
  })

  it("in plan, where both kinds are allowed, hq's own canRequestAttempt false still disables both", async () => {
    const { view } = await show(triageItemFixture({ state: "plan" }), { dispatch: "claim" })
    for (const name of ["Request an investigation", "Request a fix attempt"]) {
      expect((view.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true)
    }
    expect(view.getByText(/hq does not allow a request right now/)).toBeTruthy()
  })

  describe("the label instruction shows only where hq's start rules allow a start", () => {
    const LABEL = "agent:build"
    const state = (value: WorkItemDetail["state"], overrides: Partial<WorkItemDetail> = {}) =>
      triageItemFixture({ state: value, ...overrides })
    const region = (view: RenderResult) => view.getByRole("region", { name: "Start an attempt" })

    it("an item that used its fix attempts says the limit is reached and that Retry with notes allows one more", async () => {
      const { view } = await show(exhaustedItemFixture(), { issueUrl: ISSUE })
      const start = region(view)
      expect(start.textContent).toContain("The attempt limit for this item is reached.")
      expect(start.textContent).toContain("Retry with notes allows one more fix attempt")
      expect(start.textContent).not.toContain(LABEL)
      expect(within(start).queryByRole("link")).toBeNull()
    })

    it("at the limit without a retry the line still says so and offers no label", async () => {
      const base = exhaustedItemFixture()
      const { view } = await show(
        exhaustedItemFixture({ actions: { ...base.actions, canRetry: false } }),
        { issueUrl: ISSUE },
      )
      expect(region(view).textContent).toContain("The attempt limit for this item is reached.")
      expect(region(view).textContent).not.toContain("Retry with notes")
      expect(region(view).textContent).not.toContain(LABEL)
    })

    it("a running attempt says so and offers no label", async () => {
      const item = state("attempt", { attempts: { used: 1, limit: 3, running: true } })
      const { view } = await show(item, { issueUrl: ISSUE })
      expect(region(view).textContent).toContain("An attempt is already running.")
      expect(region(view).textContent).not.toContain(LABEL)
      expect(within(region(view)).queryByRole("link")).toBeNull()
    })

    it("a requested attempt is still active for hq", async () => {
      const queued = state("plan", {
        attemptList: [attempt(1, { kind: "investigate", status: "requested", result: null })],
      })
      const { view } = await show(queued, { issueUrl: ISSUE })
      expect(region(view).textContent).toContain("An attempt is already running.")
      expect(region(view).textContent).not.toContain(LABEL)
    })

    it("a running attempt whose lease went stale is still active for hq (attempts.running is false)", async () => {
      const stale = state("attempt", {
        attempts: { used: 1, limit: 3, running: false },
        attemptList: [attempt(2, { kind: "fix", status: "running", result: null })],
      })
      const { view } = await show(stale, { issueUrl: ISSUE })
      expect(region(view).textContent).toContain("An attempt is already running.")
      expect(region(view).textContent).not.toContain(LABEL)
    })

    it.each(["signal", "deploy", "verify", "reopened"] as const)(
      "an item in %s says no attempt starts from there and offers no label",
      async (value) => {
        const { view } = await show(state(value), { issueUrl: ISSUE })
        const start = region(view)
        expect(start.textContent).toContain(`No attempt starts while the item is in ${value}`)
        expect(start.textContent).toContain("only from triage, plan, attempt or review")
        expect(start.textContent).not.toContain(LABEL)
        expect(within(start).queryByRole("link")).toBeNull()
      },
    )

    it("names as the way back only the controls hq offers from that state", async () => {
      // verify: both are offered.
      const both = await show(verifyingItemFixture(), { issueUrl: ISSUE })
      expect(region(both.view).textContent).toContain(
        "Reopen item or Revert merge is the way back.",
      )
      both.view.unmount()
      // deploy as hq produces it: a merged pull request (canRevert) and no founder reopen edge.
      const base = verifyingItemFixture()
      const deploy = state("deploy", {
        pullRequest: base.pullRequest,
        actions: { ...base.actions, canReopen: false, canRevert: true },
      })
      const only = await show(deploy, { issueUrl: ISSUE })
      expect(region(only.view).textContent).toContain("Revert merge is the way back.")
      expect(region(only.view).textContent).not.toContain("Reopen item")
      only.view.unmount()
      // nothing offered: nothing named.
      const none = await show(state("deploy"), { issueUrl: ISSUE })
      expect(region(none.view).textContent).not.toContain("the way back")
    })

    it("beside a waiting merge approval the label line warns that another attempt makes it unusable", async () => {
      const { view } = await show(workItemFixture(), { issueUrl: ISSUE })
      expect(region(view).textContent).toContain(LABEL)
      expect(region(view).textContent).toContain(
        "Starting another attempt leaves the waiting merge approval unusable.",
      )
    })

    it("an item in attempt with a pending merge approval gets no warning (only review does)", async () => {
      const { view } = await show(workItemFixture({ state: "attempt" }), { issueUrl: ISSUE })
      expect(region(view).textContent).toContain(LABEL)
      expect(region(view).textContent).not.toContain("unusable")
    })

    it("the warning is also given in claim mode, and only while the approval waits", async () => {
      const base = workItemFixture()
      const claim = await show(
        workItemFixture({ actions: { ...base.actions, canRequestAttempt: true } }),
        { dispatch: "claim" },
      )
      expect(region(claim.view).textContent).toContain("leaves the waiting merge approval unusable")
      claim.view.unmount()
      const approved = await show(
        workItemFixture({
          mergeApproval: {
            ...(base.mergeApproval as NonNullable<WorkItemDetail["mergeApproval"]>),
            status: "approved",
          },
        }),
        { issueUrl: ISSUE },
      )
      expect(region(approved.view).textContent).not.toContain("unusable")
      approved.view.unmount()
      const triage = await show(triageItemFixture(), { issueUrl: ISSUE })
      expect(region(triage.view).textContent).not.toContain("unusable")
    })

    it.each([
      ["triage", undefined],
      ["plan", { used: 3, limit: 3, running: false }],
      ["attempt", { used: 1, limit: 3, running: false }],
      ["review", { used: 2, limit: null, running: false }],
    ] as const)(
      "%s with nothing running and budget left shows the label instruction",
      async (value, attempts) => {
        const item = state(value, attempts ? { attempts } : {})
        const { view } = await show(item, { issueUrl: ISSUE })
        expect(region(view).textContent).toContain(LABEL)
        expect(within(region(view)).getByRole("link", { name: /issue/i })).toBeTruthy()
      },
    )
  })

  it("when the dispatch mode could not be read it says so and offers nothing", async () => {
    const { view } = await show(triageItemFixture(), { dispatch: null })
    expect(view.getByText(/How attempts start could not be read/)).toBeTruthy()
    expect(view.queryByRole("button", { name: /Request/ })).toBeNull()
    expect(view.container.textContent).not.toContain("agent:build")
  })

  it("an item that used its fix attempts offers Retry with notes; the note is required and sent trimmed", async () => {
    const { view, actions, user } = await show(exhaustedItemFixture())
    expect(view.container.textContent).toContain("3 of 3 fix attempts used")
    await user.click(view.getByRole("button", { name: "Retry with notes" }))
    const send = view.getByRole("button", { name: "Allow one more attempt" }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    await user.type(view.getByLabelText("Notes for the next attempt"), "  use the cursor query ")
    expect(send.disabled).toBe(false)
    await user.click(send)
    expect(actions.onRetry).toHaveBeenCalledTimes(1)
    expect(actions.onRetry).toHaveBeenCalledWith("use the cursor query")
  })

  it("without canRetry there is no Retry control", async () => {
    const { view } = await show(workItemFixture())
    expect(view.queryByRole("button", { name: "Retry with notes" })).toBeNull()
  })
})

describe("ItemPage attempts, questions and notes", () => {
  it("lists the attempts and says so when there are none", async () => {
    const { view } = await show(workItemFixture())
    const attempts = section(view, /^Attempts/)
    expect(within(attempts).getAllByRole("article")).toHaveLength(2)
    view.unmount()
    const none = await show(triageItemFixture())
    expect(
      within(section(none.view, /^Attempts/)).getByText("No attempt has started."),
    ).toBeTruthy()
  })

  it("an open question shows lettered answers and calls onAnswer once with the question and option", async () => {
    const { view, actions, user } = await show(askingItemFixture())
    const questions = section(view, "Questions from agents")
    await user.click(within(questions).getByRole("button", { name: /Half to even/ }))
    expect(actions.onAnswer).toHaveBeenCalledTimes(1)
    expect(actions.onAnswer).toHaveBeenCalledWith(WORK_IDS.question, "even")
  })

  it("keeps hq's option order and letters (the board's card puts the default first, a recorded difference)", async () => {
    const item = askingItemFixture({
      questions: [
        questionFixture({
          options: [
            { id: "even", label: "Half to even" },
            { id: "up", label: "Half up" },
          ],
          defaultOptionId: "up",
        }),
      ],
    })
    const { view } = await show(item)
    const names = within(section(view, "Questions from agents"))
      .getAllByRole("button")
      .map((b) => b.textContent)
    expect(names).toEqual(["AHalf to even", "BHalf updefault"])
  })

  it("says so when no agent asked anything", async () => {
    const { view } = await show(workItemFixture())
    expect(
      within(section(view, "Questions from agents")).getByText("No agent has asked a question."),
    ).toBeTruthy()
  })

  it("lists the founder's own notes under the attempts, by kind", async () => {
    const item = workItemFixture({
      founderNotes: [
        { at: "2026-11-17T12:00:00.000Z", kind: "retry", text: "Try the cursor query" },
        { at: "2026-11-17T12:05:00.000Z", kind: "answer", text: "Half up, per support" },
        { at: "2026-11-17T12:06:00.000Z", kind: "revert", text: "It broke checkout" },
        { at: "2026-11-17T12:07:00.000Z", kind: "request", text: "Start with cart.ts" },
      ],
    })
    const { view } = await show(item)
    const notes = view.getByRole("region", { name: "Your notes" })
    const text = notes.textContent ?? ""
    for (const part of [
      "Retry",
      "Try the cursor query",
      "Answer",
      "Half up, per support",
      "Revert",
      "It broke checkout",
      "Request",
      "Start with cart.ts",
      "2026-11-17 12:05 UTC",
    ]) {
      expect(text).toContain(part)
    }
    expect(within(notes).getAllByRole("listitem")).toHaveLength(4)
  })

  it("has no Your notes section without notes", async () => {
    const { view } = await show(workItemFixture())
    expect(view.queryByRole("region", { name: "Your notes" })).toBeNull()
  })

  it("says when hq sent only the newest attempts, questions or events", async () => {
    const item = workItemFixture({ truncated: { attempts: true, questions: true, events: true } })
    const { view } = await show(item)
    const text = view.container.textContent ?? ""
    expect(text).toContain("Only the newest attempts are shown.")
    expect(text).toContain("Only the newest questions are shown.")
    expect(text).toContain("Only the newest events are shown.")
  })

  it("the transcript is Not connected until Phase 2 sessions exist, for the newest attempt", async () => {
    const { view } = await show(workItemFixture())
    const transcript = section(view, "Attempt 2 transcript")
    expect(transcript.textContent).toContain("Not connected")
    expect(transcript.textContent).toContain("Phase 2 sessions")
    view.unmount()
    const none = await show(triageItemFixture())
    expect(none.view.queryByText(/transcript/)).toBeNull()
  })

  it("renders ready transcript events as plain text", async () => {
    const { view } = await show(workItemFixture(), {
      transcript: {
        kind: "ready",
        events: [{ at: "12:00", tool: "<b>edit</b>", text: "<img src=x onerror=alert(1)>" }],
      },
    })
    expect(view.container.querySelector("img")).toBeNull()
    expect(view.container.querySelector("b")).toBeNull()
    expect(view.container.textContent).toContain("<img src=x onerror=alert(1)>")
  })
})

describe("ItemPage pull request", () => {
  it("approving calls onApproveMerge once with the full head sha, after a confirmation naming the first 7", async () => {
    const { view, actions, user } = await show(workItemFixture())
    const panel = section(view, "PR #106")
    await user.click(within(panel).getByRole("button", { name: "Approve merge" }))
    expect(actions.onApproveMerge).not.toHaveBeenCalled()
    const group = within(panel).getByRole("group", { name: "Approve merge" })
    expect(group.textContent).toContain(SHA7)
    await user.click(within(group).getByRole("button", { name: "Confirm" }))
    expect(actions.onApproveMerge).toHaveBeenCalledTimes(1)
    expect(actions.onApproveMerge).toHaveBeenCalledWith(WORK_HEAD_SHA)
  })

  it("an item that is not in review cannot be approved from here", async () => {
    const item = workItemFixture({ state: "plan" })
    const { view } = await show(item)
    expect(view.queryByRole("button", { name: "Approve merge" })).toBeNull()
    expect(view.container.textContent).toContain("It cannot be approved from here right now.")
  })

  it("after approval it names the founder by name, never by id, and 'a founder' when the name is not known", async () => {
    const approved = workItemFixture({
      mergeApproval: {
        ...(workItemFixture().mergeApproval as NonNullable<WorkItemDetail["mergeApproval"]>),
        status: "approved",
        decidedBy: "user-1",
        decidedAt: "2026-11-17T12:10:00.000Z",
      },
    })
    const named = await show(approved, { approvedBy: "Ada Founder" })
    expect(named.view.container.textContent).toContain(
      `Approved by Ada Founder for ${SHA7}; merge it on GitHub`,
    )
    expect(named.view.container.textContent).not.toContain("user-1")
    named.view.unmount()
    const unnamed = await show(approved, { approvedBy: null })
    expect(unnamed.view.container.textContent).toContain(
      `Approved by a founder for ${SHA7}; merge it on GitHub`,
    )
    expect(unnamed.view.container.textContent).not.toContain("user-1")
  })

  it("the reviewer row is the newest attempt of this cycle that has a verdict", async () => {
    const item = workItemFixture({
      attemptList: [
        attempt(1, {
          reviewer: { verdict: "approve", summary: "Looks right.", headSha: WORK_HEAD_SHA },
        }),
        attempt(3, {
          reviewer: { verdict: "reject", summary: "Broke the cart test.", headSha: WORK_HEAD_SHA },
        }),
        attempt(4, { reviewer: null }),
        // Listed out of order on purpose: the number decides, not the position.
        attempt(2, {
          reviewer: {
            verdict: "request_changes",
            summary: "Needs a test.",
            headSha: WORK_HEAD_SHA,
          },
        }),
      ],
    })
    const { view } = await show(item)
    const panel = section(view, "PR #106")
    expect(panel.textContent).toContain("Reviewer rejected")
    expect(panel.textContent).toContain("Broke the cart test.")
    expect(panel.textContent).not.toContain("Looks right.")
  })

  it("a verdict from an earlier cycle is not shown against this cycle's pull request", async () => {
    const item = workItemFixture({
      cycle: 2,
      attemptList: [
        attempt(1, {
          cycle: 1,
          reviewer: { verdict: "approve", summary: "Old cycle.", headSha: WORK_HEAD_SHA },
        }),
      ],
    })
    const { view } = await show(item)
    expect(section(view, "PR #106").textContent).toContain("no verdict recorded")
  })

  it("no pull request says so", async () => {
    const { view } = await show(triageItemFixture())
    expect(view.getByRole("region", { name: "Pull request" }).textContent).toContain(
      "No pull request yet.",
    )
  })
})

describe("ItemPage verification window", () => {
  it("says what the window does, how long it has left, and the chart runs to now", async () => {
    const { view } = await show(verifyingItemFixture())
    const win = section(view, "Verification window")
    expect(win.textContent).toContain(
      "Runs the contract above for 6 h. Reopens automatically on recurrence; a revert is your call.",
    )
    expect(win.textContent).toContain("Running · 2h14m left")
    expect(within(win).getByText("now")).toBeTruthy()
    expect(within(win).getByRole("figure")).toBeTruthy()
  })

  it("a window that is not running ends the chart at 'window end'", async () => {
    const { view } = await show(doneItemFixture())
    const win = section(view, "Verification window")
    expect(within(win).getByText("window end")).toBeTruthy()
    expect(within(win).queryByText("now")).toBeNull()
    expect(win.textContent).toContain("Passed")
  })

  it("a running window past its end also ends the chart at 'window end'", async () => {
    const base = verifyingItemFixture()
    const item = verifyingItemFixture({
      window: {
        ...(base.window as NonNullable<WorkItemDetail["window"]>),
        pastEnd: true,
        remainingMinutes: null,
      },
    })
    const { view } = await show(item)
    const win = section(view, "Verification window")
    expect(within(win).getByText("window end")).toBeTruthy()
    expect(within(win).queryByText("now")).toBeNull()
    expect(win.textContent).toContain("past its end")
  })

  it("says what the window is still waiting on, in hq's words", async () => {
    const base = verifyingItemFixture()
    const item = verifyingItemFixture({
      window: {
        ...(base.window as NonNullable<WorkItemDetail["window"]>),
        waitingOn: [
          { contractItemId: "c1", kind: "sentry", state: "not_connected" },
          { contractItemId: "c2", kind: "ci", state: "pending" },
        ],
      },
    })
    const { view } = await show(item)
    const text = section(view, "Verification window").textContent ?? ""
    expect(text).toContain("sentry: not connected, so nothing is checking it")
    expect(text).toContain("ci: not checked yet")
  })

  it("an item without a window has no such section", async () => {
    const { view } = await show(workItemFixture())
    expect(view.queryByRole("region", { name: "Verification window" })).toBeNull()
  })
})

describe("ItemPage evidence and history", () => {
  it("shows the signal's evidence as plain text, never as markup", async () => {
    const hostile =
      '<img src=x onerror="alert(1)"> [pay](https://evil.example) <script>alert(1)</script>'
    const base = workItemFixture()
    const item = workItemFixture({
      signal: { ...(base.signal as NonNullable<WorkItemDetail["signal"]>), evidence: hostile },
    })
    const { view } = await show(item)
    const evidence = section(view, "Evidence")
    expect(evidence.textContent).toContain(hostile)
    expect(view.container.querySelector("img")).toBeNull()
    expect(view.container.querySelector("script")).toBeNull()
    expect(view.container.querySelector("a[href*='evil']")).toBeNull()
  })

  it("links the signal only when hq checked its url", async () => {
    const checked = await show(workItemFixture())
    const link = within(section(checked.view, "Evidence")).getByRole("link")
    expect(link.getAttribute("href")).toBe("https://github.com/acme/web/issues/106")
    expect(link.getAttribute("rel")).toContain("noreferrer")
    expect(link.className).toContain("min-h-touch")
    checked.view.unmount()

    const base = workItemFixture()
    const signal = base.signal as NonNullable<WorkItemDetail["signal"]>
    const unchecked = await show(workItemFixture({ signal: { ...signal, urlChecked: false } }))
    const evidence = section(unchecked.view, "Evidence")
    expect(within(evidence).queryByRole("link")).toBeNull()
    expect(evidence.textContent).toContain("https://github.com/acme/web/issues/106")
    unchecked.view.unmount()

    // A url hq calls checked but that is not a page of the item's repo is still no link here.
    const hostile = await show(
      workItemFixture({
        signal: { ...signal, urlChecked: true, url: "https://evil.example/acme/web/issues/106" },
      }),
    )
    expect(within(section(hostile.view, "Evidence")).queryByRole("link")).toBeNull()
    expect(section(hostile.view, "Evidence").textContent).toContain(
      "https://evil.example/acme/web/issues/106",
    )
  })

  it("says when the signal has no evidence text or no url", async () => {
    const base = workItemFixture()
    const signal = base.signal as NonNullable<WorkItemDetail["signal"]>
    const { view } = await show(
      workItemFixture({ signal: { ...signal, evidence: null, url: null, urlChecked: false } }),
    )
    const evidence = section(view, "Evidence")
    expect(evidence.textContent).toContain("No evidence text was recorded.")
    expect(within(evidence).queryByRole("link")).toBeNull()
  })

  it("lists the events newest first with hq's one-line summary, the kind of actor and the founder's note", async () => {
    const item = workItemFixture()
    const events = [
      {
        ...(item.events[0] as WorkItemDetail["events"][number]),
        actorType: "founder" as const,
        actorId: "user-1",
        note: "Merge it after lunch",
        summary: "Merge approval requested.",
      },
      ...item.events.slice(1),
    ]
    const { view } = await show(workItemFixture({ events }))
    const history = section(view, "History")
    const rows = within(history).getAllByRole("listitem")
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain("Merge approval requested.")
    expect(rows[0]?.textContent).toContain("founder")
    expect(rows[0]?.textContent).toContain("Merge it after lunch")
    expect(rows[0]?.textContent).toContain("2026-11-17 12:00 UTC")
    // An actor id is an id, never shown.
    expect(history.textContent).not.toContain("user-1")
    expect(history.textContent).not.toContain("agent-key-1")
  })
})

describe("ItemPage hostile and huge text", () => {
  it("a 100 000 character title, note, prompt and evidence stays in its card and clear of the buttons", async () => {
    const huge = `<img src=x onerror=alert(1)> ${"N".repeat(100_000)}`
    const base = askingItemFixture()
    const item = askingItemFixture({
      title: huge,
      signal: {
        ...(base.signal as NonNullable<WorkItemDetail["signal"]>),
        evidence: huge,
        summary: huge,
      },
      questions: [questionFixture({ prompt: huge })],
      attemptList: [attempt(1, { note: huge })],
      founderNotes: [{ at: "2026-11-17T12:00:00.000Z", kind: "retry", text: huge }],
    })
    const { view } = await show(item)
    expect(view.container.querySelector("img")).toBeNull()
    expect(view.getByRole("heading", { level: 1 }).className).toContain("wrap-anywhere")
    for (const article of view.container.querySelectorAll("article")) {
      expect(article.className).toContain("min-w-0")
      expect(article.className).toContain("overflow-hidden")
    }
    // Long text offers Show all, and no button is inside a text element.
    expect(view.getAllByRole("button", { name: /Show all/ }).length).toBeGreaterThanOrEqual(4)
    for (const button of view.container.querySelectorAll("button")) {
      expect(button.closest("p, h1, h2, h3, pre")).toBeNull()
    }
    // The decisions are still there.
    expect(view.getByRole("button", { name: "Stop item" })).toBeTruthy()
    expect(view.getByRole("button", { name: /Half up/ })).toBeTruthy()
  })
})

describe("ItemPage quality", () => {
  it("has no inline style and every control is min-h-touch", async () => {
    const item = verifyingItemFixture({
      questions: [questionFixture()],
      founderNotes: [{ at: "2026-11-17T12:00:00.000Z", kind: "revert", text: "note" }],
    })
    const { view, user } = await show(item, { dispatch: "claim" })
    await user.click(view.getByRole("button", { name: "Stop watching" }))
    expect(view.container.querySelector("[style]")).toBeNull()
    const controls = view.container.querySelectorAll("a, button, input, textarea, select")
    expect(controls.length).toBeGreaterThan(8)
    for (const control of controls) {
      expect(control.className, control.textContent ?? control.tagName).toContain("min-h-touch")
    }
  })

  it("has no accessibility violations", async () => {
    const item = verifyingItemFixture({
      questions: [questionFixture()],
      founderNotes: [{ at: "2026-11-17T12:00:00.000Z", kind: "revert", text: "note" }],
    })
    const { view } = await show(item, {
      dispatch: "label",
      issueUrl: "https://github.com/acme/web/issues/108",
    })
    await act(async () => {})
    await expectNoA11yViolations(view.container.innerHTML)
  })
})
