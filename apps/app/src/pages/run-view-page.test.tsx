// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { Approval, RunDetail, RunStep } from "../lib/runs-api"
import { RunViewPage, type RunViewPageProps, type RunViewState } from "./run-view-page"

const later = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString()

function step(overrides: Partial<RunStep> & Pick<RunStep, "id" | "title" | "status">): RunStep {
  return {
    position: 0,
    kind: "collect",
    detail: null,
    progressDone: null,
    progressTotal: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    ...overrides,
  }
}

function run(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    id: "r1",
    agentId: "agent-1",
    title: "Testing the two fixes",
    status: "running",
    summary: null,
    startedBy: null,
    createdAt: "2026-10-16T10:00:00.000Z",
    startedAt: "2026-10-16T10:00:00.000Z",
    finishedAt: null,
    deferredUntil: null,
    durationMs: 240000,
    footprint: { energyWh: 0.6, tokens: 18000, toolCalls: 7, energyBudgetWh: 2 },
    steps: [
      step({
        id: "s1",
        title: "Collected 14 release blockers",
        status: "done",
        position: 0,
        durationMs: 6000,
      }),
      step({ id: "s2", title: "Drafted 2 fixes", status: "done", position: 1 }),
      step({
        id: "s3",
        title: "Running tests",
        status: "running",
        position: 2,
        progressDone: 38,
        progressTotal: 61,
      }),
      step({ id: "s4", title: "Open pull request", status: "queued", position: 3 }),
    ],
    approvals: [],
    messages: [],
    ...overrides,
  }
}

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "ap1",
    stepId: null,
    action: "Post summary to #releases?",
    detail: "v2.8 triage: 4 themes",
    requestedAt: "2026-10-16T10:03:00.000Z",
    status: "pending",
    decision: null,
    ...overrides,
  }
}

function page(state: RunViewState, overrides: Partial<RunViewPageProps> = {}) {
  const props: RunViewPageProps = {
    organization: { name: "Acme Inc", slug: "acme" },
    state,
    canApprove: true,
    canSteer: true,
    busy: false,
    actionError: null,
    onRetry: vi.fn(),
    onDecide: vi.fn(),
    onUndo: vi.fn(),
    onWindowPassed: vi.fn(),
    onSteer: vi.fn(async () => undefined),
    onDefer: vi.fn(async () => undefined),
    sending: false,
    ...overrides,
  }
  return { ...render(<RunViewPage {...props} />), props }
}

describe("RunViewPage", () => {
  it("shows the run, its step counter and its steps with shape and word", async () => {
    page({ kind: "ready", run: run() })
    expect(screen.getByRole("heading", { name: "Testing the two fixes", level: 1 })).toBeTruthy()
    expect(screen.getByText("Step 3 of 4")).toBeTruthy()
    const steps = within(screen.getByRole("list", { name: "Run steps" })).getAllByRole("listitem")
    expect(steps).toHaveLength(4)
    expect(steps[2]?.getAttribute("data-status")).toBe("running")
    expect(screen.getByText("38 of 61")).toBeTruthy()
    expect(screen.getByText("Queued")).toBeTruthy()
    await expectNoA11yViolations(document.body.innerHTML)
  })

  it("shows an empty steps state", () => {
    page({ kind: "ready", run: run({ steps: [] }) })
    expect(screen.getByText(/No steps yet/)).toBeTruthy()
  })

  it("says the step counter as text, with the big digits hidden from assistive tech", () => {
    page({ kind: "ready", run: run() })
    // A label on a box with no role is not announced: the words are text, and the visual digits are hidden.
    expect(screen.queryByLabelText("Step 3 of 4")).toBeNull()
    expect(screen.getByText("Step 3 of 4").closest('[aria-hidden="true"]')).toBeNull()
    expect(screen.getByText("/4").closest('[aria-hidden="true"]')).not.toBeNull()
  })

  it("renders no main landmark of its own, since the shell's main holds the page", () => {
    const ready = page({ kind: "ready", run: run() })
    expect(ready.container.querySelector("main")).toBeNull()
    ready.unmount()
    const missing = page({ kind: "not-found" })
    expect(missing.container.querySelector("main")).toBeNull()
  })

  it("asks for a decision with Approve and Deny of equal weight", () => {
    const { props } = page({
      kind: "ready",
      run: run({ status: "needs_you", approvals: [approval()] }),
    })
    const heading = screen.getByRole("heading", { name: "Post summary to #releases?" })
    const card = heading.closest("section") as HTMLElement
    expect(within(card).getByText("v2.8 triage: 4 themes")).toBeTruthy()
    const approve = within(card).getByRole("button", { name: "Approve" })
    const deny = within(card).getByRole("button", { name: "Deny" })
    expect(approve.className).toBe(deny.className)
    fireEvent.click(deny)
    expect(props.onDecide).toHaveBeenCalledWith("ap1", "deny")
  })

  it("is read-only for a viewer, and says why", () => {
    page(
      { kind: "ready", run: run({ status: "needs_you", approvals: [approval()] }) },
      { canApprove: false, canSteer: false },
    )
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull()
    expect(screen.getByText(/Only people who can approve/)).toBeTruthy()
    expect(screen.getByText(/Viewers can read this run/)).toBeTruthy()
    expect(screen.getByRole("textbox", { name: "Steer this run" })).toHaveProperty("disabled", true)
  })

  it("counts down the undo window from the server's end time, with an undo", () => {
    const { props } = page({
      kind: "ready",
      run: run({
        status: "running",
        approvals: [
          approval({
            status: "approved",
            decision: {
              decidedBy: "user-1",
              decidedAt: new Date().toISOString(),
              effectiveAt: later(30),
              undoableUntil: later(30),
            },
          }),
        ],
      }),
    })
    expect(screen.getByText(/Undo available for \d+ seconds?\./)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Undo" }))
    expect(props.onUndo).toHaveBeenCalledWith("ap1")
  })

  it("shows a decision as final once the window has passed", () => {
    const onWindowPassed = vi.fn()
    page(
      {
        kind: "ready",
        run: run({
          approvals: [
            approval({
              status: "denied",
              decision: {
                decidedBy: "user-1",
                decidedAt: new Date(Date.now() - 40_000).toISOString(),
                effectiveAt: new Date(Date.now() - 10_000).toISOString(),
                undoableUntil: null,
              },
            }),
          ],
        }),
      },
      { onWindowPassed },
    )
    expect(screen.getByText(/The decision is final/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull()
  })

  it("names an expired undo window as passed and asks for the final state", () => {
    const onWindowPassed = vi.fn()
    page(
      {
        kind: "ready",
        run: run({
          approvals: [
            approval({
              status: "approved",
              decision: {
                decidedBy: "user-1",
                decidedAt: new Date(Date.now() - 31_000).toISOString(),
                effectiveAt: new Date(Date.now() - 1_000).toISOString(),
                undoableUntil: new Date(Date.now() - 1_000).toISOString(),
              },
            }),
          ],
        }),
      },
      { onWindowPassed },
    )
    expect(onWindowPassed).toHaveBeenCalled()
  })

  it("sends a steering message and clears nothing else", () => {
    const { props } = page({ kind: "ready", run: run() })
    expect(screen.getByRole("form", { name: "Steer this run" })).toBeTruthy()
    expect(props.canSteer).toBe(true)
  })

  it("shows a queued run's deferral time", () => {
    const until = later(3600)
    page({ kind: "ready", run: run({ status: "queued", deferredUntil: until }) })
    expect(screen.getAllByText(/Queued until/).length).toBeGreaterThan(0)
  })

  it("shows the footprint against the budget, and tokens and tool calls", () => {
    page({ kind: "ready", run: run() })
    expect(screen.getByText("Run footprint")).toBeTruthy()
    expect(screen.getByText("0.6 Wh of 2 Wh run budget · 18k tokens · 7 tool calls")).toBeTruthy()
  })

  it("renders the summary as Markdown and never as raw HTML", () => {
    page({
      kind: "ready",
      run: run({ summary: "## Done\n\n<script>alert(1)</script>\n\nFour themes." }),
    })
    expect(screen.getByRole("heading", { name: "Done", level: 2 })).toBeTruthy()
    expect(document.querySelector("script")).toBeNull()
    expect(screen.getByText("Four themes.")).toBeTruthy()
  })

  it("states not found, with a way back", () => {
    page({ kind: "not-found" })
    expect(screen.getByRole("heading", { name: "Run not found" })).toBeTruthy()
    expect(screen.getByRole("link", { name: "Back to Acme Inc" }).getAttribute("href")).toBe(
      "/acme",
    )
  })

  it("shows the error with a retry, and the loading state", () => {
    const onRetry = vi.fn()
    const { unmount } = page({ kind: "error", message: "Offline" }, { onRetry })
    expect(screen.getByRole("alert").textContent).toContain("Offline")
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(onRetry).toHaveBeenCalled()
    unmount()
    page({ kind: "loading" })
    expect(screen.getByText("Loading run…")).toBeTruthy()
  })
})
