// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { AccountError } from "../lib/account-api"
import { AccountSecurityPage, type AccountSecurityPageProps } from "./account-security-page"

const TOTP_URI = "otpauth://totp/Starter:jordan%40acme.dev?secret=JBSWY3DPEHPK3PXP&issuer=Starter"

function props(overrides: Partial<AccountSecurityPageProps> = {}): AccountSecurityPageProps {
  return {
    name: "Jordan Lee",
    email: "jordan@acme.dev",
    summary: {
      hasPassword: true,
      passwordChangedAt: new Date(Date.now() - 90 * 86_400_000).toISOString(),
      twoFactorEnabled: true,
      twoFactorEnabledAt: "2026-09-02T10:00:00Z",
      backupCodesRemaining: 8,
    },
    lastSignIn: "Passkey · just now · Chrome on macOS",
    passkeys: [
      { id: "pk-1", name: "MacBook Pro · Touch ID", createdAt: "2026-09-02T10:00:00Z" },
      { id: "pk-2", name: "iPhone · Face ID", createdAt: "2026-08-18T10:00:00Z" },
    ],
    connected: [
      {
        accountId: "acc-gh",
        provider: "github",
        label: "GitHub",
        connectedAt: "2026-09-02T10:00:00Z",
      },
      { accountId: null, provider: "google", label: "Google", connectedAt: null },
    ],
    sessions: [
      {
        token: "t-now",
        device: "Chrome on macOS",
        method: "passkey",
        when: "Active now",
        current: true,
      },
      {
        token: "t-2",
        device: "Safari on iPhone",
        method: "Google",
        when: "2 days ago",
        current: false,
      },
    ],
    sessionsNeedSignIn: false,
    onSignInAgain: vi.fn(async () => undefined),
    onAddPasskey: vi.fn(async () => undefined),
    onRenamePasskey: vi.fn(async () => undefined),
    onRemovePasskey: vi.fn(async () => undefined),
    onEnableTwoFactor: vi.fn(async () => ({
      totpURI: TOTP_URI,
      backupCodes: ["aaaa-1111", "bbbb-2222"],
    })),
    onConfirmTwoFactor: vi.fn(async () => undefined),
    onDisableTwoFactor: vi.fn(async () => undefined),
    onNewBackupCodes: vi.fn(async () => ["cccc-3333"]),
    onChangePassword: vi.fn(async () => undefined),
    onConnect: vi.fn(async () => undefined),
    onDisconnect: vi.fn(async () => undefined),
    onRevokeSession: vi.fn(async () => undefined),
    onRevokeOtherSessions: vi.fn(async () => undefined),
    ...overrides,
  }
}

/**
 * Holds a closing popup mounted. Base UI waits for an element's animations before it unmounts, so one
 * that has not finished keeps the exit on screen the way a real transition does. Call the result to
 * let it finish.
 */
function holdExitAnimations(): () => void {
  let finish!: () => void
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [{ finished, playState: "running" }],
  })
  return () => {
    finish()
    Reflect.deleteProperty(Element.prototype, "getAnimations")
  }
}

describe("AccountSecurityPage", () => {
  it("summarises the sign-in method, passkeys and two-factor", () => {
    render(<AccountSecurityPage {...props()} />)
    expect(screen.getByText("Passkey · just now · Chrome on macOS")).toBeTruthy()
    expect(screen.getByText("2 passkeys")).toBeTruthy()
    expect(screen.getByText("Two-factor on")).toBeTruthy()
    expect(screen.getByText("Password checked when set")).toBeTruthy()
    expect(screen.getByText("8 of 10 left · each works once")).toBeTruthy()
  })

  it("renames a passkey inline and removes one only after it is confirmed", async () => {
    const user = userEvent.setup()
    const onRenamePasskey = vi.fn(async () => undefined)
    const onRemovePasskey = vi.fn(async () => undefined)
    render(<AccountSecurityPage {...props({ onRenamePasskey, onRemovePasskey })} />)

    await user.click(screen.getByRole("button", { name: "Rename iPhone · Face ID" }))
    const field = screen.getByLabelText("Passkey name")
    await user.clear(field)
    await user.type(field, "Phone")
    await user.click(screen.getByRole("button", { name: "Save name" }))
    await waitFor(() => expect(onRenamePasskey).toHaveBeenCalledWith("pk-2", "Phone"))

    await user.click(screen.getByRole("button", { name: "Remove MacBook Pro · Touch ID" }))
    expect(onRemovePasskey).not.toHaveBeenCalled()
    const confirm = await screen.findByRole("alertdialog")
    await user.click(within(confirm).getByRole("button", { name: "Remove passkey" }))
    await waitFor(() => expect(onRemovePasskey).toHaveBeenCalledWith("pk-1"))
  })

  it("walks through switching two-factor on: password, the secret, a code, then the backup codes once", async () => {
    const user = userEvent.setup()
    const onEnableTwoFactor = vi.fn(async () => ({
      totpURI: TOTP_URI,
      backupCodes: ["aaaa-1111", "bbbb-2222"],
    }))
    const onConfirmTwoFactor = vi.fn(async () => undefined)
    render(
      <AccountSecurityPage
        {...props({
          summary: {
            ...props().summary,
            twoFactorEnabled: false,
            twoFactorEnabledAt: null,
            backupCodesRemaining: null,
          },
          onEnableTwoFactor,
          onConfirmTwoFactor,
        })}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Turn on" }))
    const dialog = await screen.findByRole("dialog")
    await user.type(within(dialog).getByLabelText("Password"), "correct horse battery staple 42")
    await user.click(within(dialog).getByRole("button", { name: "Continue" }))
    await waitFor(() =>
      expect(onEnableTwoFactor).toHaveBeenCalledWith("correct horse battery staple 42"),
    )

    expect(within(dialog).getByRole("img", { name: "QR code for the setup link" })).toBeTruthy()
    expect(within(dialog).getByLabelText("Setup key")).toHaveProperty("value", "JBSWY3DPEHPK3PXP")
    expect(within(dialog).getByLabelText("Setup link")).toHaveProperty("value", TOTP_URI)
    await user.type(within(dialog).getByLabelText("Six-digit code from the app"), "123456")
    await user.click(within(dialog).getByRole("button", { name: "Turn on" }))
    await waitFor(() => expect(onConfirmTwoFactor).toHaveBeenCalledWith("123456"))

    const codes = await within(dialog).findByRole("list", { name: "Backup codes" })
    expect(within(codes).getByText("aaaa-1111")).toBeTruthy()
    expect(within(codes).getByText("bbbb-2222")).toBeTruthy()
    expect(within(dialog).getByRole("button", { name: "I've saved them" })).toBeTruthy()
  })

  it("turns two-factor off after the password is confirmed", async () => {
    const user = userEvent.setup()
    const onDisableTwoFactor = vi.fn(async () => undefined)
    render(<AccountSecurityPage {...props({ onDisableTwoFactor })} />)
    await user.click(screen.getByRole("button", { name: "Turn off" }))
    const dialog = await screen.findByRole("alertdialog")
    await user.type(within(dialog).getByLabelText("Password"), "pw-123456789")
    await user.click(within(dialog).getByRole("button", { name: "Turn off two-factor" }))
    await waitFor(() => expect(onDisableTwoFactor).toHaveBeenCalledWith("pw-123456789"))
  })

  it("makes new backup codes behind a password, and cannot view the old ones", async () => {
    const user = userEvent.setup()
    const onNewBackupCodes = vi.fn(async () => ["cccc-3333"])
    render(<AccountSecurityPage {...props({ onNewBackupCodes })} />)
    expect(screen.getByRole("button", { name: "View codes" })).toHaveProperty("disabled", true)
    await user.click(screen.getByRole("button", { name: "Make new codes" }))
    const dialog = await screen.findByRole("dialog")
    await user.type(within(dialog).getByLabelText("Password"), "pw-123456789")
    await user.click(within(dialog).getByRole("button", { name: "Make new codes" }))
    await waitFor(() => expect(onNewBackupCodes).toHaveBeenCalledWith("pw-123456789"))
    expect(await within(dialog).findByText("cccc-3333")).toBeTruthy()
  })

  it("changes the password, and shows the breached-password copy when it is refused", async () => {
    const user = userEvent.setup()
    const message = "This password has shown up in a known data breach. Choose a different one."
    const onChangePassword = vi.fn(async () => {
      throw new Error(message)
    })
    render(<AccountSecurityPage {...props({ onChangePassword })} />)
    await user.click(screen.getByRole("button", { name: "Change password" }))
    const dialog = await screen.findByRole("dialog")
    await user.type(within(dialog).getByLabelText("Current password"), "old-password-1")
    await user.type(within(dialog).getByLabelText("New password"), "password123")
    await user.type(within(dialog).getByLabelText("Confirm new password"), "password123")
    await user.click(within(dialog).getByRole("button", { name: "Change password" }))
    await waitFor(() =>
      expect(onChangePassword).toHaveBeenCalledWith({
        currentPassword: "old-password-1",
        newPassword: "password123",
      }),
    )
    expect(await within(dialog).findByText(message)).toBeTruthy()
  })

  it("disconnects a provider after confirming, and offers to connect one that is not linked", async () => {
    const user = userEvent.setup()
    const onDisconnect = vi.fn(async () => undefined)
    const onConnect = vi.fn(async () => undefined)
    render(<AccountSecurityPage {...props({ onDisconnect, onConnect })} />)
    expect(screen.getByText("Connected · Sep 2, 2026")).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Disconnect" }))
    await user.click(await screen.findByRole("button", { name: "Disconnect GitHub" }))
    await waitFor(() => expect(onDisconnect).toHaveBeenCalledWith("acc-gh"))

    await user.click(screen.getByRole("button", { name: "Connect" }))
    expect(onConnect).toHaveBeenCalledWith("google")
  })

  it("says a provider is not set up on this server when connecting it is refused", async () => {
    const user = userEvent.setup()
    const onConnect = vi.fn(async () => {
      throw new AccountError("Provider not found", 404, "PROVIDER_NOT_FOUND")
    })
    render(<AccountSecurityPage {...props({ onConnect })} />)
    await user.click(screen.getByRole("button", { name: "Connect" }))
    expect(
      await screen.findByText("This sign-in method isn't set up on this server yet."),
    ).toBeTruthy()
  })

  it("shows the server's refusal when the last way in cannot be disconnected", async () => {
    const user = userEvent.setup()
    const onDisconnect = vi.fn(async () => {
      throw new Error("You can't disconnect your last way to sign in.")
    })
    render(<AccountSecurityPage {...props({ onDisconnect })} />)
    await user.click(screen.getByRole("button", { name: "Disconnect" }))
    await user.click(await screen.findByRole("button", { name: "Disconnect GitHub" }))
    expect(await screen.findByText("You can't disconnect your last way to sign in.")).toBeTruthy()
  })

  it("lists the sessions, marks this one, and signs the others out", async () => {
    const user = userEvent.setup()
    const onRevokeOtherSessions = vi.fn(async () => undefined)
    const onRevokeSession = vi.fn(async () => undefined)
    render(<AccountSecurityPage {...props({ onRevokeOtherSessions, onRevokeSession })} />)
    expect(screen.getByText("This device")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Sign out Chrome on macOS" })).toBeNull()
    await user.click(screen.getByRole("button", { name: "Sign out Safari on iPhone" }))
    await waitFor(() => expect(onRevokeSession).toHaveBeenCalledWith("t-2"))

    await user.click(screen.getByRole("button", { name: "Sign out everywhere else" }))
    await user.click(await screen.findByRole("button", { name: "Sign out others" }))
    await waitFor(() => expect(onRevokeOtherSessions).toHaveBeenCalled())
  })

  it("signs a session out once when its button is clicked twice", async () => {
    const user = userEvent.setup()
    let finish: () => void = () => {}
    const onRevokeSession = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          finish = () => resolve(undefined)
        }),
    )
    render(<AccountSecurityPage {...props({ onRevokeSession })} />)
    const button = screen.getByRole("button", { name: "Sign out Safari on iPhone" })
    await user.click(button)
    await user.click(button)
    expect(onRevokeSession).toHaveBeenCalledTimes(1)
    expect((button as HTMLButtonElement).disabled).toBe(true)
    finish()
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  })

  it("asks for a recent sign-in when the session list is too old to read", async () => {
    const page = props({ sessions: [], sessionsNeedSignIn: true })
    render(<AccountSecurityPage {...page} />)
    await userEvent.click(screen.getByRole("button", { name: "Sign in again" }))
    await waitFor(() => expect(page.onSignInAgain).toHaveBeenCalledOnce())
  })

  it("has no axe violations", async () => {
    const { container } = render(<AccountSecurityPage {...props()} />)
    await expectNoA11yViolations(container.innerHTML)
  })

  it("asks for the password again after the new codes are saved, with nothing left over", async () => {
    const user = userEvent.setup()
    const onNewBackupCodes = vi.fn(async () => ["cccc-3333"])
    render(<AccountSecurityPage {...props({ onNewBackupCodes })} />)
    await user.click(screen.getByRole("button", { name: "Make new codes" }))
    let dialog = await screen.findByRole("dialog")
    await user.type(within(dialog).getByLabelText("Password"), "pw-123456789")
    await user.click(within(dialog).getByRole("button", { name: "Make new codes" }))
    expect(await within(dialog).findByText("cccc-3333")).toBeTruthy()
    await user.click(within(dialog).getByRole("button", { name: "I've saved them" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    await user.click(screen.getByRole("button", { name: "Make new codes" }))
    dialog = await screen.findByRole("dialog")
    expect(within(dialog).queryByText("cccc-3333")).toBeNull()
    expect((within(dialog).getByLabelText("Password") as HTMLInputElement).value).toBe("")
  })

  it("keeps the backup codes on screen while the dialog animates out after saving them", async () => {
    const user = userEvent.setup()
    render(
      <AccountSecurityPage {...props({ onNewBackupCodes: vi.fn(async () => ["cccc-3333"]) })} />,
    )
    await user.click(screen.getByRole("button", { name: "Make new codes" }))
    const dialog = await screen.findByRole("dialog")
    await user.type(within(dialog).getByLabelText("Password"), "pw-123456789")
    await user.click(within(dialog).getByRole("button", { name: "Make new codes" }))
    expect(await within(dialog).findByText("cccc-3333")).toBeTruthy()
    const release = holdExitAnimations()
    try {
      await user.click(within(dialog).getByRole("button", { name: "I've saved them" }))
      expect(within(dialog).getByText("cccc-3333")).toBeTruthy()
      expect(within(dialog).queryByLabelText("Password")).toBeNull()
    } finally {
      release()
    }
  })

  it("forgets the typed current and new passwords when the change is cancelled", async () => {
    const user = userEvent.setup()
    render(<AccountSecurityPage {...props()} />)
    await user.click(screen.getByRole("button", { name: "Change password" }))
    let dialog = await screen.findByRole("dialog")
    await user.type(within(dialog).getByLabelText("Current password"), "old-password-1")
    await user.type(within(dialog).getByLabelText("New password"), "password123")
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    await user.click(screen.getByRole("button", { name: "Change password" }))
    dialog = await screen.findByRole("dialog")
    expect((within(dialog).getByLabelText("Current password") as HTMLInputElement).value).toBe("")
    expect((within(dialog).getByLabelText("New password") as HTMLInputElement).value).toBe("")
  })

  it("clears a refused password change when the dialog is closed and reopened", async () => {
    const user = userEvent.setup()
    const message = "This password has shown up in a known data breach. Choose a different one."
    render(
      <AccountSecurityPage
        {...props({
          onChangePassword: vi.fn(async () => {
            throw new Error(message)
          }),
        })}
      />,
    )
    await user.click(screen.getByRole("button", { name: "Change password" }))
    let dialog = await screen.findByRole("dialog")
    await user.type(within(dialog).getByLabelText("Current password"), "old-password-1")
    await user.type(within(dialog).getByLabelText("New password"), "password123")
    await user.type(within(dialog).getByLabelText("Confirm new password"), "password123")
    await user.click(within(dialog).getByRole("button", { name: "Change password" }))
    expect(await within(dialog).findByText(message)).toBeTruthy()
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    await user.click(screen.getByRole("button", { name: "Change password" }))
    dialog = await screen.findByRole("dialog")
    expect(within(dialog).queryByText(message)).toBeNull()
  })

  it("keeps the success note after a password change, and starts a fresh form next time", async () => {
    const user = userEvent.setup()
    render(<AccountSecurityPage {...props()} />)
    await user.click(screen.getByRole("button", { name: "Change password" }))
    const dialog = await screen.findByRole("dialog")
    await user.type(within(dialog).getByLabelText("Current password"), "old-password-1")
    await user.type(within(dialog).getByLabelText("New password"), "password123")
    await user.type(within(dialog).getByLabelText("Confirm new password"), "password123")
    await user.click(within(dialog).getByRole("button", { name: "Change password" }))
    expect(await screen.findByText("Your password is changed.")).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("forgets the password typed into turn-off when the dialog is dismissed", async () => {
    const user = userEvent.setup()
    render(<AccountSecurityPage {...props()} />)
    await user.click(screen.getByRole("button", { name: "Turn off" }))
    let dialog = await screen.findByRole("alertdialog")
    await user.type(within(dialog).getByLabelText("Password"), "pw-123456789")
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())

    await user.click(screen.getByRole("button", { name: "Turn off" }))
    dialog = await screen.findByRole("alertdialog")
    expect((within(dialog).getByLabelText("Password") as HTMLInputElement).value).toBe("")
  })

  it("leaves the landmark to the app shell rather than nesting a main", () => {
    render(<AccountSecurityPage {...props()} />)
    expect(document.querySelector("main")).toBeNull()
  })
})
