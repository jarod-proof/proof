// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeAll, describe, expect, it, vi } from "vitest"

import { AccountError } from "../lib/account-api"
import { TwoFactorPage, sameSiteCallback } from "./two-factor-page"

function resume(overrides: Partial<{ continueOAuth: () => Promise<string | undefined> }> = {}) {
  return { continueOAuth: vi.fn(async () => undefined), ...overrides }
}

function signIn(overrides: Partial<Parameters<typeof TwoFactorPage>[0]["signIn"]> = {}) {
  return {
    completeSignInWithCode: vi.fn(async () => undefined),
    completeSignInWithBackupCode: vi.fn(async () => undefined),
    ...overrides,
  }
}

// input-otp measures the page with elementFromPoint, which jsdom does not implement.
beforeAll(() => {
  if (!document.elementFromPoint) document.elementFromPoint = () => null
})

describe("sameSiteCallback", () => {
  const origin = "https://app.example.com"
  it("keeps a path or an absolute URL on this origin, and refuses another site", () => {
    expect(sameSiteCallback("/acme", origin)).toBe("/acme")
    expect(sameSiteCallback(`${origin}/api/auth/oauth2/authorize?client_id=c&sig=s`, origin)).toBe(
      "/api/auth/oauth2/authorize?client_id=c&sig=s",
    )
    expect(sameSiteCallback("https://evil.example.net/x", origin)).toBeUndefined()
    expect(sameSiteCallback(undefined, origin)).toBeUndefined()
  })
})

describe("TwoFactorPage", () => {
  it("resumes an OAuth authorization when its signed query is on the page", async () => {
    window.history.replaceState(null, "", "/two-factor?client_id=c&sig=s")
    try {
      const user = userEvent.setup()
      const oauth = resume({ continueOAuth: vi.fn(async () => "https://app.example.com/consent") })
      render(<TwoFactorPage next="/acme" signIn={signIn()} {...oauth} />)
      await user.type(screen.getByLabelText("Code"), "123456")
      await user.click(screen.getByRole("button", { name: "Verify" }))
      await waitFor(() => expect(oauth.continueOAuth).toHaveBeenCalled())
    } finally {
      window.history.replaceState(null, "", "/")
    }
  })

  it("checks an app code and goes to the continuation the server gives", async () => {
    const user = userEvent.setup()
    const api = signIn({
      completeSignInWithCode: vi.fn(
        async () => "https://auth.example.com/oauth2/authorize?resumed=1",
      ),
    })
    render(<TwoFactorPage next="/acme" signIn={api} {...resume()} />)
    await user.type(screen.getByLabelText("Code"), "123456")
    await user.click(screen.getByRole("button", { name: "Verify" }))
    await waitFor(() => expect(api.completeSignInWithCode).toHaveBeenCalledWith("123456", true))
  })

  it("switches to a backup code, and says when the code is wrong", async () => {
    const user = userEvent.setup()
    const api = signIn({
      completeSignInWithBackupCode: vi.fn(async () => {
        throw new AccountError("Invalid backup code", 401, "INVALID_BACKUP_CODE")
      }),
    })
    render(<TwoFactorPage next="/acme" signIn={api} {...resume()} />)
    await user.click(screen.getByRole("button", { name: "Use a backup code instead" }))
    await user.type(screen.getByLabelText("Backup code"), "aaaa-1111")
    await user.click(screen.getByRole("button", { name: "Verify" }))
    expect(
      await screen.findByText("That backup code isn't right, or it has already been used."),
    ).toBeTruthy()
  })

  it("asks for a code before it sends anything", async () => {
    const user = userEvent.setup()
    const api = signIn()
    render(<TwoFactorPage next="/acme" signIn={api} {...resume()} />)
    await user.click(screen.getByRole("button", { name: "Verify" }))
    expect(await screen.findByText("Enter the six-digit code from your app.")).toBeTruthy()
    expect(api.completeSignInWithCode).not.toHaveBeenCalled()
  })

  it("has no axe violations", async () => {
    const { container } = render(<TwoFactorPage next="/acme" signIn={signIn()} {...resume()} />)
    await expectNoA11yViolations(container.innerHTML)
  })
})
