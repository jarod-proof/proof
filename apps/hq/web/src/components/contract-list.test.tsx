// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it } from "vitest"

import type { ContractItemView } from "../api/schemas"
import { CONNECTED_VERIFIER_KINDS } from "../../../src/data/contract"
import { VERIFIER_KINDS } from "../../../src/work/machine"
import { doneItemFixture, verifyingItemFixture } from "../test/fixtures"
import { ContractList, NOT_CONNECTED_VERIFIERS } from "./contract-list"

const row = (overrides: Partial<ContractItemView> = {}): ContractItemView => ({
  id: "00000000-0000-4000-8000-000000000999",
  text: "The reported flow works again",
  verifier: { kind: "reviewer", label: "reviewer" },
  status: "pending",
  evidence: null,
  checkedAt: null,
  ...overrides,
})

const fac141: ContractItemView[] = [
  row({
    id: "00000000-0000-4000-8000-000000000a01",
    text: "The crash does not recur",
    verifier: { kind: "signal_recurrence", label: "signal recurrence" },
    status: "pending",
  }),
  row({
    id: "00000000-0000-4000-8000-000000000a02",
    text: "The checks of the pull request pass",
    verifier: { kind: "ci", label: "ci" },
    status: "passing",
    evidence: "All 4 checks passed.",
  }),
  row({
    id: "00000000-0000-4000-8000-000000000a03",
    text: "Regression test fails before the fix and passes after",
    verifier: { kind: "reviewer", label: "reviewer" },
    status: "failing",
    evidence: "The reviewer asked for changes.",
  }),
]

describe("ContractList", () => {
  it("shows the text, the three verifier labels (reviewer, ci, signal recurrence) and each status and evidence", () => {
    const view = render(<ContractList items={fac141} />)
    const items = view.getAllByRole("listitem")
    expect(items).toHaveLength(3)
    expect(items[0]?.textContent).toContain("The crash does not recur")
    expect(items[0]?.textContent).toContain("signal recurrence")
    expect(items[0]?.textContent).toContain("Pending")
    expect(items[1]?.textContent).toContain("ci")
    expect(items[1]?.textContent).toContain("Passing")
    expect(items[1]?.textContent).toContain("All 4 checks passed.")
    expect(items[2]?.textContent).toContain("reviewer")
    expect(items[2]?.textContent).toContain("Failing")
    expect(items[2]?.textContent).toContain("The reviewer asked for changes.")
    expect(view.getByText("Passing").className).toContain("text-success")
    expect(view.getByText("Failing").className).toContain("text-destructive")
    expect(view.getByText("Pending").className).toContain("text-faint")
  })

  it("renders the contract of a verifying and a done item", () => {
    const verifying = render(<ContractList items={verifyingItemFixture().contract} />)
    expect(verifying.getAllByText("Passing")).toHaveLength(2)
    verifying.unmount()
    const done = render(<ContractList items={doneItemFixture().contract} />)
    expect(done.getByText("The reviewer approved fix attempt 2.")).toBeTruthy()
  })

  it("never invents evidence: a row without any shows none", () => {
    const view = render(<ContractList items={[row()]} />)
    expect(view.getByRole("listitem").textContent).toBe(
      "The reported flow works againreviewerPending",
    )
  })

  it("labels a pending sentry or posthog verifier 'Not connected', never as waiting or progressing", () => {
    const view = render(
      <ContractList
        items={[
          row({ id: "a", verifier: { kind: "sentry", label: "sentry" }, status: "pending" }),
          row({ id: "b", verifier: { kind: "posthog", label: "posthog" }, status: "pending" }),
          row({ id: "c", verifier: { kind: "ci", label: "ci" }, status: "pending" }),
        ]}
      />,
    )
    const items = view.getAllByRole("listitem")
    expect(items[0]?.textContent).toContain("Not connected")
    expect(items[0]?.textContent).not.toContain("Pending")
    expect(items[1]?.textContent).toContain("Not connected")
    expect(items[2]?.textContent).toContain("Pending")
    expect(items[2]?.textContent).not.toContain("Not connected")
    for (const li of items.slice(0, 2)) {
      expect(li.querySelector(".text-success")).toBeNull()
      expect(li.querySelector(".text-solar")).toBeNull()
    }
  })

  it("keeps its list of unconnected verifiers equal to hq's connected list", () => {
    expect([...NOT_CONNECTED_VERIFIERS].sort()).toEqual(
      VERIFIER_KINDS.filter((kind) => !CONNECTED_VERIFIER_KINDS.includes(kind)).sort(),
    )
  })

  it("says so when no contract is recorded, and shows no row", () => {
    const view = render(<ContractList items={[]} />)
    expect(view.queryAllByRole("listitem")).toHaveLength(0)
    expect(view.getByText("No contract is recorded yet.")).toBeTruthy()
  })

  it("renders hostile text and a 100 000 character evidence as plain text, bounded", async () => {
    const user = userEvent.setup()
    const hostile = `<img src=x onerror=alert(1)> [x](https://evil.example) <a href="https://evil.example">go</a> ${"B".repeat(100_000)}`
    const view = render(
      <ContractList items={[row({ text: hostile, evidence: hostile, status: "failing" })]} />,
    )
    expect(view.container.querySelector("img")).toBeNull()
    expect(view.container.querySelector("a")).toBeNull()
    const li = view.getByRole("listitem")
    expect(li.className).toContain("min-w-0")
    expect(li.querySelector(".wrap-anywhere")).not.toBeNull()
    // the evidence is cut with a way to read it all, and the text stays whole in the DOM
    const toggle = view.getByRole("button", { name: /Show all/ })
    expect(toggle.className).toContain("min-h-touch")
    expect(view.container.textContent).toContain(hostile)
    await user.click(toggle)
    expect(view.getByRole("button", { name: /Show less/ })).toBeTruthy()
  })

  it("has no inline style and no accessibility violations", async () => {
    const view = render(<ContractList items={fac141} />)
    expect(view.container.querySelector("[style]")).toBeNull()
    await expectNoA11yViolations(view.container.innerHTML)
  })
})
