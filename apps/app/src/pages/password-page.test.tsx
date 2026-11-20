// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { fakeAuth } from "../test/fake-auth"
import { PasswordPage } from "./password-page"

describe("PasswordPage", () => {
  it("has no accessibility violations on the reset form", async () => {
    const { container } = render(<PasswordPage auth={fakeAuth()} mode="reset" token="tok" />)
    await screen.findByRole("button", { name: "Set password" })
    await expectNoA11yViolations(container.innerHTML)
  })

  it("sets the password with the token from the link", async () => {
    const auth = fakeAuth()
    render(<PasswordPage auth={auth} mode="reset" token="tok-1" />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("New password"), "new-pass-123")
    await user.type(screen.getByLabelText("Confirm password"), "new-pass-123")
    await user.click(screen.getByRole("button", { name: "Set password" }))

    expect(await screen.findByText("Your password is set. Sign in with it.")).toBeTruthy()
    expect(auth.resetPassword).toHaveBeenCalledWith({ token: "tok-1", newPassword: "new-pass-123" })
  })

  it("uses the claim wording for an account an agent created", async () => {
    const { container } = render(<PasswordPage auth={fakeAuth()} mode="claim" token="tok" />)
    expect(
      await screen.findByText(
        /An agent created this account for you\. Set a password to claim it\./,
      ),
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "Claim account" })).toBeTruthy()
    await expectNoA11yViolations(container.innerHTML)
  })

  it("refuses mismatched passwords without calling the server", async () => {
    const auth = fakeAuth()
    render(<PasswordPage auth={auth} mode="reset" token="tok" />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("New password"), "new-pass-123")
    await user.type(screen.getByLabelText("Confirm password"), "different-1")
    await user.click(screen.getByRole("button", { name: "Set password" }))

    expect(await screen.findByText("The two passwords do not match.")).toBeTruthy()
    expect(auth.resetPassword).not.toHaveBeenCalled()
  })

  it("refuses a password shorter than 8 characters", async () => {
    const auth = fakeAuth()
    render(<PasswordPage auth={auth} mode="reset" token="tok" />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("New password"), "short")
    await user.type(screen.getByLabelText("Confirm password"), "short")
    await user.click(screen.getByRole("button", { name: "Set password" }))

    expect(
      await screen.findByText("The new password must be at least 8 characters long."),
    ).toBeTruthy()
    expect(auth.resetPassword).not.toHaveBeenCalled()
  })

  it("shows the server's message when the token is refused", async () => {
    const auth = fakeAuth({
      resetPassword: vi.fn(async () => {
        throw new Error("This link is invalid or has expired")
      }),
    })
    render(<PasswordPage auth={auth} mode="reset" token="old" />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("New password"), "new-pass-123")
    await user.type(screen.getByLabelText("Confirm password"), "new-pass-123")
    await user.click(screen.getByRole("button", { name: "Set password" }))

    await waitFor(() =>
      expect(screen.getByText("This link is invalid or has expired")).toBeTruthy(),
    )
  })

  it("explains a link with no token, or a link the server marked invalid", async () => {
    const { unmount } = render(<PasswordPage auth={fakeAuth()} mode="reset" token={undefined} />)
    expect(
      await screen.findByText(
        "This link is missing its token. Open the link from the email again.",
      ),
    ).toBeTruthy()
    unmount()

    // The real shape of an expired link: better-auth redirects with ?error=INVALID_TOKEN, no token.
    render(
      <PasswordPage auth={fakeAuth()} mode="reset" token={undefined} linkError="INVALID_TOKEN" />,
    )
    expect(
      await screen.findByText("This link is invalid or has expired. Ask for a new one."),
    ).toBeTruthy()
  })
})
