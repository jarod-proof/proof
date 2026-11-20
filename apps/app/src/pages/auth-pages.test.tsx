// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setNavigator } from "../lib/navigation"
import { fakeAuth } from "../test/fake-auth"
import { SignInPage, SignUpPage } from "./auth-pages"

// jsdom can't load another page: record where the page sends the browser instead.
const navigate = vi.fn<(url: string) => void>()

beforeEach(() => {
  navigate.mockReset()
  setNavigator(navigate)
})

afterEach(() => {
  setNavigator(undefined)
})

describe("SignInPage", () => {
  it("has no accessibility violations", async () => {
    const { container } = render(
      <SignInPage auth={fakeAuth()} next="/settings/agents" signUpHref="/sign-up" />,
    )
    await expectNoA11yViolations(container.innerHTML)
  })

  it("signs in and goes to the next page", async () => {
    const auth = fakeAuth()
    render(<SignInPage auth={auth} next="/settings/agents" signUpHref="/sign-up" />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("Email"), "ada@example.com")
    await user.type(screen.getByLabelText("Password"), "correct-horse")
    await user.click(screen.getByRole("button", { name: "Sign in with email" }))

    expect(auth.signIn).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "correct-horse",
    })
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/settings/agents"))
  })

  it("resumes a pending OAuth flow at the URL the server returns", async () => {
    const auth = fakeAuth({ signIn: vi.fn(async () => "https://auth.example.com/resume") })
    render(<SignInPage auth={auth} next="/settings/agents" signUpHref="/sign-up" />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("Email"), "ada@example.com")
    await user.type(screen.getByLabelText("Password"), "correct-horse")
    await user.click(screen.getByRole("button", { name: "Sign in with email" }))

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://auth.example.com/resume"))
  })

  it("shows the server's message and lets the person try again", async () => {
    const auth = fakeAuth({
      signIn: vi.fn(async () => {
        throw new Error("Invalid email or password")
      }),
    })
    render(<SignInPage auth={auth} next="/settings/agents" signUpHref="/sign-up" />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("Email"), "ada@example.com")
    await user.type(screen.getByLabelText("Password"), "wrong-pass")
    await user.click(screen.getByRole("button", { name: "Sign in with email" }))

    expect(await screen.findByText("Invalid email or password")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Sign in with email" })).toHaveProperty(
      "disabled",
      false,
    )
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe("SignInPage email change link", () => {
  it("explains the link was opened signed out, and that signing in resumes it", async () => {
    window.history.replaceState(null, "", "/sign-in?error=SIGN_IN_TO_CONFIRM_EMAIL_CHANGE")
    try {
      render(
        <SignInPage
          auth={fakeAuth()}
          next="/api/auth/verify-email?token=t"
          signUpHref="/sign-up"
        />,
      )
      expect(
        await screen.findByText(/Sign in to the account this email change is for/),
      ).toBeTruthy()
    } finally {
      window.history.replaceState(null, "", "/")
    }
  })
})

describe("SignUpPage", () => {
  it("has no accessibility violations", async () => {
    const { container } = render(
      <SignUpPage auth={fakeAuth()} next="/consent" signInHref="/sign-in" />,
    )
    await expectNoA11yViolations(container.innerHTML)
  })

  it("creates the account with a name and goes to the next page", async () => {
    const auth = fakeAuth()
    render(<SignUpPage auth={auth} next="/consent" signInHref="/sign-in" />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("Name"), "Ada")
    await user.type(screen.getByLabelText("Work email"), "ada@example.com")
    await user.type(screen.getByLabelText("Password"), "correct-horse")
    await user.click(screen.getByRole("button", { name: "Create account" }))

    expect(auth.signUp).toHaveBeenCalledWith({
      name: "Ada",
      email: "ada@example.com",
      password: "correct-horse",
    })
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/consent"))
  })
})

describe("SignInPage methods", () => {
  const methods = {
    password: true,
    magicLink: true,
    passkey: true,
    social: ["github" as const],
    sso: true,
    stripe: false,
  }

  it("offers the server's methods and badges the one last used", async () => {
    const auth = fakeAuth({
      signInMethods: vi.fn(async () => methods),
      lastUsedMethod: vi.fn(() => "passkey"),
    })
    render(<SignInPage auth={auth} next="/settings/agents" signUpHref="/sign-up" />)
    expect(await screen.findByRole("button", { name: /Sign in with passkey/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: /Continue with GitHub/ })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Continue with Google/ })).toBeNull()
    expect(screen.getByRole("button", { name: /Sign in with SSO/ })).toBeTruthy()
    expect(screen.getByText("Last used")).toBeTruthy()
  })

  it("emails a sign-in link and says to check the inbox", async () => {
    const sendMagicLink = vi.fn(async () => undefined)
    const auth = fakeAuth({ signInMethods: vi.fn(async () => methods), sendMagicLink })
    render(<SignInPage auth={auth} next="/settings/agents" signUpHref="/sign-up" />)
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText("Email"), "ada@example.com")
    await user.click(screen.getByRole("button", { name: "Email me a sign-in link" }))
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeTruthy()
    expect(sendMagicLink).toHaveBeenCalledWith({
      email: "ada@example.com",
      callbackURL: expect.stringMatching(/\/settings\/agents$/),
    })
  })

  it("asks for an email before the link or SSO buttons send anything", async () => {
    const auth = fakeAuth({ signInMethods: vi.fn(async () => methods) })
    render(<SignInPage auth={auth} next="/settings/agents" signUpHref="/sign-up" />)
    await userEvent.setup().click(await screen.findByRole("button", { name: "Sign in with SSO" }))
    expect(await screen.findByText("Enter your email address first.")).toBeTruthy()
    expect(auth.signInWithSso).toBeUndefined()
  })
})

describe("SignUpPage breached password", () => {
  it("names the password field with the breach message", async () => {
    const auth = fakeAuth({
      signUp: vi.fn(async () => {
        throw Object.assign(new Error("This password has shown up in a known data breach."), {
          code: "PASSWORD_COMPROMISED",
        })
      }),
    })
    render(<SignUpPage auth={auth} next="/consent" signInHref="/sign-in" />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("Name"), "Ada")
    await user.type(screen.getByLabelText("Work email"), "ada@example.com")
    await user.type(screen.getByLabelText("Password"), "Summer2024!")
    await user.click(screen.getByRole("button", { name: "Create account" }))

    expect(
      await screen.findByText(
        "This password has shown up in a known data breach. Choose a different one.",
      ),
    ).toBeTruthy()
    expect(screen.getByLabelText("Password").getAttribute("aria-invalid")).toBe("true")
    expect(screen.getByText(/Your password is never sent\./)).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe("SignInPage forgot password", () => {
  it("opens the reset request from the sign-in form, with the email carried over", async () => {
    const auth = fakeAuth()
    render(<SignInPage auth={auth} next="/settings/agents" signUpHref="/sign-up" />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("Email"), "ada@example.com")
    await user.click(screen.getByRole("button", { name: "Forgot password?" }))
    expect(await screen.findByRole("heading", { name: "Forgot password?" })).toBeTruthy()
    expect(screen.getByLabelText("Email")).toHaveProperty("value", "ada@example.com")
    await user.click(screen.getByRole("button", { name: "Send reset link" }))

    expect(auth.requestPasswordReset).toHaveBeenCalledWith({
      email: "ada@example.com",
      redirectTo: `${window.location.origin}/reset-password`,
    })
    expect(
      await screen.findByText(
        "If an account exists for ada@example.com, we sent a reset link. The link opens the page to choose a new password.",
      ),
    ).toBeTruthy()
  })

  it("says the same thing whether or not the address has an account, and can go back", async () => {
    const auth = fakeAuth({
      requestPasswordReset: vi.fn(async () => {
        throw new Error("Could not send the reset link")
      }),
    })
    render(<SignInPage auth={auth} next="/settings/agents" signUpHref="/sign-up" />)
    const user = userEvent.setup()
    await user.type(screen.getByLabelText("Email"), "nobody@example.com")
    await user.click(screen.getByRole("button", { name: "Forgot password?" }))
    await user.click(screen.getByRole("button", { name: "Send reset link" }))
    expect(await screen.findByText("Could not send the reset link")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Back to sign in" }))
    expect(await screen.findByRole("button", { name: "Sign in with email" })).toBeTruthy()
  })

  it("asks for an email before sending a reset", async () => {
    const auth = fakeAuth()
    render(<SignInPage auth={auth} next="/settings/agents" signUpHref="/sign-up" />)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Forgot password?" }))
    await user.click(await screen.findByRole("button", { name: "Send reset link" }))
    expect(await screen.findByText("Enter your email address first.")).toBeTruthy()
    expect(auth.requestPasswordReset).not.toHaveBeenCalled()
  })
})

describe("SignUpPage social sign-up", () => {
  const methods = {
    password: true,
    magicLink: false,
    passkey: false,
    social: ["github" as const],
    sso: false,
    stripe: false,
  }

  it("shows a failed social sign-up and lets the person try again", async () => {
    const auth = fakeAuth({
      signInMethods: vi.fn(async () => methods),
      signInWithSocial: vi.fn(async () => {
        throw new Error("GitHub sign-in is not set up on this server")
      }),
    })
    render(<SignUpPage auth={auth} next="/consent" signInHref="/sign-in" />)
    const github = await screen.findByRole("button", { name: "GitHub" })
    await userEvent.setup().click(github)

    expect(await screen.findByText("GitHub sign-in is not set up on this server")).toBeTruthy()
    expect((screen.getByRole("button", { name: "GitHub" }) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it("stays pending while the social sign-up redirects away", async () => {
    const auth = fakeAuth({
      signInMethods: vi.fn(async () => methods),
      signInWithSocial: vi.fn(() => new Promise<void>(() => undefined)),
    })
    render(<SignUpPage auth={auth} next="/consent" signInHref="/sign-in" />)
    await userEvent.setup().click(await screen.findByRole("button", { name: "GitHub" }))

    await waitFor(() =>
      expect((screen.getByRole("button", { name: "GitHub" }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    )
    expect(auth.signInWithSocial).toHaveBeenCalledWith("github", expect.any(String))
  })
})
