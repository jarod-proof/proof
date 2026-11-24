// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { SignInPage } from "./sign-in-page"

describe("SignInPage", () => {
  it("has labelled Email and Password fields with the right autocomplete and a Sign in button", () => {
    const view = render(<SignInPage onSubmit={() => {}} pending={false} error={null} />)
    const email = view.getByLabelText("Email") as HTMLInputElement
    const password = view.getByLabelText("Password") as HTMLInputElement
    expect(email.autocomplete).toBe("username")
    expect(password.autocomplete).toBe("current-password")
    expect(password.type).toBe("password")
    expect(view.getByRole("button", { name: "Sign in" })).toBeTruthy()
    expect(view.queryByRole("alert")).toBeNull()
  })

  it("is a POST form with 44px inputs, so a failed handler could never put the password in the URL", () => {
    const view = render(<SignInPage onSubmit={() => {}} pending={false} error={null} />)
    expect(view.container.querySelector("form")?.getAttribute("method")).toBe("post")
    for (const label of ["Email", "Password"]) {
      expect(view.getByLabelText(label).className).toContain("h-11")
    }
    expect(view.getByRole("button", { name: "Sign in" }).className).toContain("min-h-touch")
  })

  it("submits the typed values once", async () => {
    const onSubmit = vi.fn()
    const view = render(<SignInPage onSubmit={onSubmit} pending={false} error={null} />)
    const user = userEvent.setup()
    await user.type(view.getByLabelText("Email"), "a@example.com")
    await user.type(view.getByLabelText("Password"), "hunter2")
    await user.click(view.getByRole("button", { name: "Sign in" }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith({ email: "a@example.com", password: "hunter2" })
  })

  it("shows the error as an alert, as text only", () => {
    const view = render(
      <SignInPage onSubmit={() => {}} pending={false} error="<b>Wrong email or password.</b>" />,
    )
    const alert = view.getByRole("alert")
    expect(alert.textContent).toBe("<b>Wrong email or password.</b>")
    expect(alert.querySelector("b")).toBeNull()
  })

  it("disables the button while pending", () => {
    const view = render(<SignInPage onSubmit={() => {}} pending error={null} />)
    expect(
      (view.getByRole("button", { name: /Sign(ing)? in/ }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it("has no a11y violations (plain and with an error) and no inline style", async () => {
    const plain = render(<SignInPage onSubmit={() => {}} pending={false} error={null} />)
    await expectNoA11yViolations(plain.container.innerHTML)
    plain.unmount()
    const failed = render(<SignInPage onSubmit={() => {}} pending={false} error="Wrong." />)
    expect(failed.container.querySelector("[style]")).toBeNull()
    await expectNoA11yViolations(failed.container.innerHTML)
  })
})
