// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { type PasskeyLandingPageProps, PasskeyLandingPage } from "./passkey-landing-page"

function props(overrides: Partial<PasskeyLandingPageProps> = {}): PasskeyLandingPageProps {
  return {
    state: "ready",
    error: null,
    signUpHref: "/sign-up",
    onAddPasskey: vi.fn(),
    onSkip: vi.fn(),
    onContinue: vi.fn(),
    ...overrides,
  }
}

describe("PasskeyLandingPage", () => {
  it("offers the passkey and the skip, and starts nothing on its own", () => {
    const page = props()
    render(<PasskeyLandingPage {...page} />)
    expect(screen.getByRole("button", { name: "Create passkey" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Skip for now" })).toBeTruthy()
    expect(page.onAddPasskey).not.toHaveBeenCalled()
  })

  it("calls back on create, skip and continue", async () => {
    const user = userEvent.setup()
    const page = props()
    const { rerender } = render(<PasskeyLandingPage {...page} />)
    await user.click(screen.getByRole("button", { name: "Create passkey" }))
    await user.click(screen.getByRole("button", { name: "Skip for now" }))
    expect(page.onAddPasskey).toHaveBeenCalledTimes(1)
    expect(page.onSkip).toHaveBeenCalledTimes(1)
    rerender(<PasskeyLandingPage {...page} state="added" />)
    await user.click(screen.getByRole("button", { name: "Continue" }))
    expect(page.onContinue).toHaveBeenCalledTimes(1)
  })

  it("disables the buttons while the passkey is being made", () => {
    render(<PasskeyLandingPage {...props({ state: "adding" })} />)
    expect(
      (screen.getByRole("button", { name: "Create passkey" }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole("button", { name: "Skip for now" }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it("shows a failure with the way to try again", () => {
    render(<PasskeyLandingPage {...props({ state: "failed", error: "Try again later." })} />)
    expect(screen.getByRole("alert").textContent).toContain("Try again later.")
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy()
  })

  it("points a stale link at sign-up, and offers sign-in", () => {
    render(<PasskeyLandingPage {...props({ state: "signed-out" })} />)
    expect(screen.getByRole("link", { name: "Start again" }).getAttribute("href")).toBe("/sign-up")
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/sign-in")
  })

  it("explains a refused link, with start again and sign in", () => {
    render(<PasskeyLandingPage {...props({ state: "refused", signInHref: "/account/login" })} />)
    expect(screen.getByRole("heading", { name: "This sign-up link can't be used" })).toBeTruthy()
    expect(screen.getByRole("link", { name: "Start again" }).getAttribute("href")).toBe("/sign-up")
    expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "/account/login",
    )
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("has no accessibility violations in any state", async () => {
    for (const state of [
      "checking",
      "refused",
      "signed-out",
      "ready",
      "failed",
      "added",
    ] as const) {
      const { container, unmount } = render(
        <PasskeyLandingPage {...props({ state, error: state === "failed" ? "Nope." : null })} />,
      )
      await expectNoA11yViolations(container.innerHTML)
      unmount()
    }
  })
})
