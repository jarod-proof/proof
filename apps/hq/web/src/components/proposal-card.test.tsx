// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { proposalFixture } from "../test/fixtures"
import { ProposalCard } from "./proposal-card"

const HOSTILE_TITLE = '<img src=x onerror="window.__pwned = 1"> Pricing'
const HOSTILE_REASON =
  '<a href="https://evil.example/steal">Approve me</a> <script>alert(1)</script>'
const HOSTILE_BODY = "[click here](javascript:alert(1))\n<iframe src=x></iframe>\n**not bold**"

function renderCard(
  overrides: Partial<Parameters<typeof ProposalCard>[0]> = {},
  proposal = proposalFixture({ id: "abcdef0123456789", kind: "playbook" }),
) {
  const onDecide = vi.fn()
  const view = render(
    <ProposalCard
      proposal={proposal}
      onDecide={onDecide}
      pending={false}
      error={null}
      {...overrides}
    />,
  )
  return { ...view, onDecide, user: userEvent.setup() }
}

describe("ProposalCard", () => {
  it("shows the short id, kind, title, reason and the proposed text, with Approve and Reject", () => {
    const view = renderCard({}, proposalFixture({ id: "abcdef0123456789", kind: "playbook" }))
    expect(view.getByText("abcdef01 · proposal · playbook")).toBeTruthy()
    expect(view.getByRole("heading", { name: "Pricing" })).toBeTruthy()
    expect(view.getByText("Stated in the founders call")).toBeTruthy()
    expect(view.getByText("Free, then $20 per seat.")).toBeTruthy()
    expect(view.getByRole("button", { name: "Approve" })).toBeTruthy()
    expect(view.getByRole("button", { name: "Reject" })).toBeTruthy()
    expect(view.getByLabelText("Note (optional)")).toBeTruthy()
  })

  it("Approve and Reject and the note are at least 44 px (min-h-touch)", () => {
    const view = renderCard()
    for (const name of ["Approve", "Reject"]) {
      expect(view.getByRole("button", { name }).className).toContain("min-h-touch")
    }
    expect(view.getByLabelText("Note (optional)").className).toContain("min-h-touch")
  })

  it("renders a title, reason and body of <img onerror>, a link and markdown as plain text", () => {
    const view = renderCard(
      {},
      proposalFixture({
        title: HOSTILE_TITLE,
        reason: HOSTILE_REASON,
        body: { text: HOSTILE_BODY },
      }),
    )
    const card = view.getByRole("article")
    expect(card.querySelector("img, a, script, iframe, strong, em")).toBeNull()
    expect(card.textContent).toContain(HOSTILE_TITLE)
    expect(card.textContent).toContain(HOSTILE_REASON)
    expect(card.textContent).toContain("[click here](javascript:alert(1))")
    expect(card.textContent).toContain("**not bold**")
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it("renders no inline style", () => {
    const view = renderCard({}, proposalFixture({ title: HOSTILE_TITLE, reason: HOSTILE_REASON }))
    expect(view.container.querySelector("[style]")).toBeNull()
  })

  it("keeps the body's own line breaks (whitespace-pre-wrap) and breaks long words", () => {
    const view = renderCard({}, proposalFixture({ body: { text: "line one\nline two" } }))
    const body = view.getByText(/line one/)
    expect(body.className).toContain("whitespace-pre-wrap")
    expect(body.className).toContain("wrap-anywhere")
    // Short text is shown whole: nothing clamps it.
    expect(body.className).not.toContain("line-clamp")
  })

  it("if any line-clamp class is present, Show all exists (at and around every threshold)", () => {
    const cases = [
      { title: "T".repeat(115) },
      { title: "T".repeat(121) },
      { reason: "R".repeat(200) },
      { reason: "R".repeat(241) },
      { body: { text: "word ".repeat(90) } }, // 450 characters, one paragraph
      { body: { text: "word ".repeat(97) } }, // 485 characters
      { body: { text: "x".repeat(360) } },
      {
        body: {
          text: `${"line of about sixty characters, so it wraps at 390 px wide\n".repeat(6)}`,
        },
      },
      { body: { text: "a\n".repeat(9) } },
      { body: { text: "y".repeat(40_000) } },
    ]
    for (const overrides of cases) {
      const view = renderCard({}, proposalFixture(overrides))
      const clamped = view.container.querySelector("[class*='line-clamp']") !== null
      if (clamped) expect(view.queryByRole("button", { name: "Show all" })).not.toBeNull()
      view.unmount()
    }
  })

  it("a 450-character body, a 200-character reason and a 115-character title are shown whole", () => {
    const view = renderCard(
      {},
      proposalFixture({
        title: "T".repeat(115),
        reason: "R".repeat(200),
        body: { text: "word ".repeat(90) },
      }),
    )
    expect(view.container.querySelector("[class*='line-clamp']")).toBeNull()
    expect(view.queryByRole("button", { name: "Show all" })).toBeNull()
  })

  it("the buttons are described by the card's title, and the text boxes clip their overflow", () => {
    const view = renderCard({}, proposalFixture({ title: "Pricing" }))
    const title = view.getByRole("heading", { name: "Pricing" })
    for (const name of ["Approve", "Reject"]) {
      expect(view.getByRole("button", { name }).getAttribute("aria-describedby")).toBe(title.id)
    }
    expect(view.getByText("Free, then $20 per seat.").parentElement?.className).toContain(
      "overflow-hidden",
    )
    expect(title.parentElement?.className).toContain("overflow-hidden")
  })

  it("clamps the title and reason, and keeps Approve out of the text's boxes", () => {
    const view = renderCard(
      {},
      proposalFixture({ title: "T".repeat(5000), reason: "R".repeat(5000) }),
    )
    const heading = view.getByRole("heading")
    expect(heading.className).toContain("line-clamp-3")
    expect(heading.className).toContain("wrap-anywhere")
    expect(view.getByText(/^R+$/).className).toContain("line-clamp-4")
    const approve = view.getByRole("button", { name: "Approve" })
    expect(heading.contains(approve)).toBe(false)
  })

  it("a 40,000 character body is cut to a preview until Show all, and Approve stays", async () => {
    const view = renderCard({}, proposalFixture({ body: { text: "x".repeat(40_000) } }))
    const card = view.getByRole("article")
    expect(card.textContent?.length).toBeLessThan(5000)
    expect(view.getByRole("button", { name: "Approve" })).toBeTruthy()

    const toggle = view.getByRole("button", { name: "Show all" })
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    await view.user.click(toggle)
    expect(view.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe(
      "true",
    )
    expect(card.textContent?.length).toBeGreaterThan(40_000)
    expect(view.getByRole("button", { name: "Approve" })).toBeTruthy()
    // Expanded text is still inside its own block, not the button row.
    expect(
      within(card).getByRole("button", { name: "Approve" }).closest("[data-slot='decision']"),
    ).toBeTruthy()
  })

  it("a short proposal has no Show all toggle", () => {
    const view = renderCard()
    expect(view.queryByRole("button", { name: /Show all|Show less/ })).toBeNull()
  })

  it("more than 8 lines gets the toggle even when short", () => {
    const view = renderCard({}, proposalFixture({ body: { text: "a\n".repeat(12) } }))
    expect(view.getByRole("button", { name: "Show all" })).toBeTruthy()
  })

  it("Approve calls onDecide once with no note, Reject passes the typed note", async () => {
    const view = renderCard()
    await view.user.click(view.getByRole("button", { name: "Approve" }))
    expect(view.onDecide).toHaveBeenCalledExactlyOnceWith({ decision: "approve" })

    await view.user.type(view.getByLabelText("Note (optional)"), "  too risky ")
    await view.user.click(view.getByRole("button", { name: "Reject" }))
    expect(view.onDecide).toHaveBeenLastCalledWith({ decision: "reject", note: "too risky" })
  })

  it("a blank note is not sent", async () => {
    const view = renderCard()
    await view.user.type(view.getByLabelText("Note (optional)"), "   ")
    await view.user.click(view.getByRole("button", { name: "Approve" }))
    expect(view.onDecide).toHaveBeenCalledExactlyOnceWith({ decision: "approve" })
  })

  it("the note stops at the 2000 characters hq accepts", () => {
    const view = renderCard()
    expect(view.getByLabelText("Note (optional)").getAttribute("maxlength")).toBe("2000")
  })

  it("pending disables both buttons and the note, and marks the card busy", async () => {
    const view = renderCard({ pending: true })
    expect((view.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true)
    expect((view.getByRole("button", { name: "Reject" }) as HTMLButtonElement).disabled).toBe(true)
    expect((view.getByLabelText("Note (optional)") as HTMLInputElement).disabled).toBe(true)
    expect(view.getByRole("article").getAttribute("aria-busy")).toBe("true")
    await view.user.click(view.getByRole("button", { name: "Approve" }))
    expect(view.onDecide).not.toHaveBeenCalled()
  })

  it("shows an error as text in a role=alert", () => {
    const view = renderCard({ error: "Already decided. Refresh to see the result." })
    expect(view.getByRole("alert").textContent).toBe("Already decided. Refresh to see the result.")
  })

  it("has no a11y violations, hostile text and error included", async () => {
    const view = renderCard(
      { error: "Founders only." },
      proposalFixture({
        title: HOSTILE_TITLE,
        reason: HOSTILE_REASON,
        body: { text: HOSTILE_BODY },
      }),
    )
    await expectNoA11yViolations(view.container.innerHTML)
  })
})
