// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { SessionsSection, type SessionsSectionProps } from "./sessions"

const SESSIONS: SessionsSectionProps["sessions"] = [
  {
    token: "tok-now",
    device: "Chrome on macOS",
    method: "Passkey",
    when: "just now",
    current: true,
  },
  {
    token: "tok-phone",
    device: "Safari on iPhone",
    method: null,
    when: "2 days ago",
    current: false,
  },
  {
    token: "tok-tablet",
    device: "Firefox on Linux",
    method: "Email",
    when: "last week",
    current: false,
  },
]

function renderSection(overrides: Partial<SessionsSectionProps> = {}) {
  const props: SessionsSectionProps = {
    sessions: SESSIONS,
    needsSignIn: false,
    onSignInAgain: vi.fn(async () => undefined),
    onRevoke: vi.fn(async () => undefined),
    onRevokeOthers: vi.fn(async () => undefined),
    ...overrides,
  }
  render(<SessionsSection {...props} />)
  return props
}

describe("SessionsSection", () => {
  it("lists each session, and offers to sign out every other one but not this one", () => {
    renderSection()
    expect(screen.getByText("Chrome on macOS")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Sign out Chrome on macOS" })).toBeNull()
    expect(screen.getByRole("button", { name: "Sign out Safari on iPhone" })).toBeTruthy()
  })

  it("signs out one session", async () => {
    const props = renderSection()
    await userEvent.click(screen.getByRole("button", { name: "Sign out Safari on iPhone" }))
    await waitFor(() => expect(props.onRevoke).toHaveBeenCalledWith("tok-phone"))
  })

  it("signs out every other session only after the confirm", async () => {
    const props = renderSection()
    await userEvent.click(screen.getByRole("button", { name: "Sign out everywhere else" }))
    expect(props.onRevokeOthers).not.toHaveBeenCalled()
    const confirm = await screen.findByRole("alertdialog")
    await userEvent.click(within(confirm).getByRole("button", { name: "Sign out others" }))
    await waitFor(() => expect(props.onRevokeOthers).toHaveBeenCalledOnce())
  })

  it("asks for a fresh sign-in before it can list the sessions, with a button that asks", async () => {
    const props = renderSection({ needsSignIn: true, sessions: [] })
    await userEvent.click(screen.getByRole("button", { name: "Sign in again" }))
    await waitFor(() => expect(props.onSignInAgain).toHaveBeenCalledOnce())
  })

  it("keeps the button for a second try when the sign-in is not confirmed", async () => {
    const props = renderSection({
      needsSignIn: true,
      sessions: [],
      onSignInAgain: vi.fn(async () => {
        throw new Error("Could not confirm it's you. Try again.")
      }),
    })
    await userEvent.click(screen.getByRole("button", { name: "Sign in again" }))
    expect(await screen.findByText("Could not confirm it's you. Try again.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeTruthy()
    expect(props.onSignInAgain).toHaveBeenCalledOnce()
  })

  it("has no accessibility violations", async () => {
    const { container } = render(
      <SessionsSection
        sessions={SESSIONS}
        needsSignIn={false}
        onSignInAgain={vi.fn(async () => undefined)}
        onRevoke={vi.fn(async () => undefined)}
        onRevokeOthers={vi.fn(async () => undefined)}
      />,
    )
    await expectNoA11yViolations(container.innerHTML)
    // The sign-in prompt that replaces the list has its own markup: check it too.
    cleanup()
    const prompt = render(
      <SessionsSection
        sessions={[]}
        needsSignIn
        onSignInAgain={vi.fn(async () => undefined)}
        onRevoke={vi.fn(async () => undefined)}
        onRevokeOthers={vi.fn(async () => undefined)}
      />,
    )
    await expectNoA11yViolations(prompt.container.innerHTML)
  })
})
