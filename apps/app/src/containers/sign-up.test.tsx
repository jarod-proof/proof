// @vitest-environment jsdom
import type { SignInMethods } from "@proof/auth/client"
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { AuthClient } from "../lib/web-auth"
import { fakeAuth } from "../test/fake-auth"
import { SignUpContainer } from "./sign-up"

const passkeyMethods: SignInMethods = {
  password: true,
  magicLink: false,
  passkey: true,
  social: [],
  sso: false,
  stripe: false,
}

function fakeClient(start: unknown = { data: { sent: true }, error: null }) {
  const $fetch = vi.fn(async () => start)
  const addPasskey = vi.fn(async () => ({ data: {}, error: null }))
  return {
    client: { $fetch, passkey: { addPasskey } } as unknown as AuthClient,
    $fetch,
    addPasskey,
  }
}

describe("SignUpContainer passkey sign-up", () => {
  it("has no accessibility violations with the passkey button offered", async () => {
    const { client } = fakeClient()
    const auth = fakeAuth({ signInMethods: vi.fn(async () => passkeyMethods) })
    const { container } = render(
      <SignUpContainer auth={auth} next="/consent" signInHref="/sign-in" client={client} />,
    )
    await screen.findByRole("button", { name: "Sign up with a passkey" })
    await expectNoA11yViolations(container.innerHTML)
  })

  it("emails a sign-up link and says so, without signing anyone in", async () => {
    const { client, $fetch, addPasskey } = fakeClient()
    const auth = fakeAuth({ signInMethods: vi.fn(async () => passkeyMethods) })
    render(<SignUpContainer auth={auth} next="/consent" signInHref="/sign-in" client={client} />)
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText("Name"), "Ada")
    await user.type(screen.getByLabelText("Work email"), "ada@example.com")
    await user.click(screen.getByRole("button", { name: "Sign up with a passkey" }))

    expect(await screen.findByText(/We sent a link to ada@example.com/)).toBeTruthy()
    expect($fetch).toHaveBeenCalledWith("/passkey-signup/start", {
      method: "POST",
      body: {
        name: "Ada",
        email: "ada@example.com",
        callbackURL: "/sign-up/passkey?next=%2Fconsent",
      },
    })
    expect(addPasskey).not.toHaveBeenCalled()
    expect(auth.signUp).not.toHaveBeenCalled()
  })

  it("asks for a name and email before anything is sent", async () => {
    const { client, $fetch } = fakeClient()
    const auth = fakeAuth({ signInMethods: vi.fn(async () => passkeyMethods) })
    render(<SignUpContainer auth={auth} next="/consent" signInHref="/sign-in" client={client} />)
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Sign up with a passkey" }))

    expect(await screen.findByText("Enter your name.")).toBeTruthy()
    expect($fetch).not.toHaveBeenCalled()
  })

  it("shows a failed send and lets the person try again", async () => {
    const { client } = fakeClient({
      data: null,
      error: { message: "Too many signups from this network. Try again later.", status: 429 },
    })
    const auth = fakeAuth({ signInMethods: vi.fn(async () => passkeyMethods) })
    render(<SignUpContainer auth={auth} next="/consent" signInHref="/sign-in" client={client} />)
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText("Name"), "Ada")
    await user.type(screen.getByLabelText("Work email"), "ada@example.com")
    await user.click(screen.getByRole("button", { name: "Sign up with a passkey" }))

    expect(
      await screen.findByText("Too many signups from this network. Try again later."),
    ).toBeTruthy()
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Sign up with a passkey" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    )
  })
})
