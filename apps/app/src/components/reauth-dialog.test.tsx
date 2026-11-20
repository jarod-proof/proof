// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { expectNoA11yViolations } from "@proof/ui/a11y"
import { Dialog } from "@proof/ui/components/ui/dialog"

import { WebError } from "../lib/web-auth"
import type { ReauthAuth, ReauthConfirm } from "../lib/reauth"
import { renderWithClient } from "../test/render"
import {
  ReauthBody,
  ReauthDialog,
  type ReauthMethodSource,
  ReauthProvider,
  useReauth,
} from "./reauth-dialog"

/**
 * A reauth client whose session changes when a sign-in succeeds, as the browser's would: a new token,
 * and the first organization (org-a) as the active one, where the person was working in org-b.
 */
function fakeReauth(overrides: Partial<ReauthAuth> = {}): ReauthAuth {
  let token = "t-old"
  let activeOrganizationId: string | null = "org-b"
  const signedIn = () => {
    token = "t-new"
    activeOrganizationId = "org-a"
  }
  return {
    session: vi.fn(async () => ({ userId: "u1", token, activeOrganizationId })),
    signInWithPassword: vi.fn(async () => {
      signedIn()
      return "done" as const
    }),
    signInWithPasskey: vi.fn(async () => signedIn()),
    verifyCode: vi.fn(async () => signedIn()),
    verifyBackupCode: vi.fn(async () => signedIn()),
    signOut: vi.fn(async () => undefined),
    setActiveOrganization: vi.fn(async (organizationId: string) => {
      activeOrganizationId = organizationId
    }),
    revokeSession: vi.fn(async () => undefined),
    ...overrides,
  }
}

const BOTH = { email: "ada@example.com", hasPassword: true, hasPasskey: true }

function renderDialog(props: Partial<Parameters<typeof ReauthDialog>[0]> & { auth: ReauthAuth }) {
  const handlers = {
    onConfirmed: vi.fn(),
    onCancel: vi.fn(),
    onSignedOut: vi.fn(),
    onMismatch: vi.fn(),
  }
  const ui = <ReauthDialog open methods={BOTH} {...handlers} {...props} />
  const view = renderWithClient(ui)
  return { ...view, handlers }
}

describe("ReauthDialog", () => {
  it("explains why, and offers the password and passkey the person has", () => {
    renderDialog({ auth: fakeReauth() })
    expect(screen.getByRole("heading", { name: "Confirm it's you" })).toBeTruthy()
    expect(screen.getByText("For your security, confirm it's you to continue.")).toBeTruthy()
    expect(screen.getByLabelText("Password")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Use your passkey" })).toBeTruthy()
  })

  it("passes the accessibility checks for both sets of methods, and for no method", async () => {
    const methods = { email: "ada@example.com", hasPassword: true, hasPasskey: true }
    const handlers = {
      onConfirmed: vi.fn(),
      onCancel: vi.fn(),
      onSignedOut: vi.fn(),
      onMismatch: vi.fn(),
    }
    // The dialog root gives the footer's Cancel its context; it renders no portal in static markup.
    const frame = (body: ReactElement) =>
      renderToStaticMarkup(
        <Dialog open onOpenChange={() => undefined}>
          {body}
        </Dialog>,
      )
    await expectNoA11yViolations(
      frame(<ReauthBody methods={methods} auth={fakeReauth()} {...handlers} />),
    )
    await expectNoA11yViolations(
      frame(
        <ReauthBody
          methods={{ email: "", hasPassword: false, hasPasskey: false }}
          auth={fakeReauth()}
          {...handlers}
        />,
      ),
    )
  })

  it("re-enters the password for the person's own email, then confirms once a new session replaces the old", async () => {
    const user = userEvent.setup()
    const auth = fakeReauth()
    const { handlers } = renderDialog({ auth })
    await user.type(screen.getByLabelText("Password"), "correct horse")
    await user.click(screen.getByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(handlers.onConfirmed).toHaveBeenCalledTimes(1))
    expect(auth.signInWithPassword).toHaveBeenCalledWith("ada@example.com", "correct horse")
    expect(handlers.onMismatch).not.toHaveBeenCalled()
  })

  it("shows the server's refusal for a wrong password and does not confirm", async () => {
    const user = userEvent.setup()
    const auth = fakeReauth({
      signInWithPassword: vi.fn(async () => {
        throw new WebError("Invalid email or password", 401)
      }),
    })
    const { handlers } = renderDialog({ auth })
    await user.type(screen.getByLabelText("Password"), "nope")
    await user.click(screen.getByRole("button", { name: "Confirm" }))
    expect((await screen.findByRole("alert")).textContent).toBe("Invalid email or password")
    expect(handlers.onConfirmed).not.toHaveBeenCalled()
  })

  it("puts back the organization the person was in, when the new session starts in another", async () => {
    const user = userEvent.setup()
    const auth = fakeReauth()
    const { handlers } = renderDialog({ auth })
    await user.type(screen.getByLabelText("Password"), "pw")
    await user.click(screen.getByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(handlers.onConfirmed).toHaveBeenCalledTimes(1))
    expect(auth.setActiveOrganization).toHaveBeenCalledWith("org-b")
  })

  it("revokes the session the re-sign-in replaced, so no duplicate row stays valid", async () => {
    const user = userEvent.setup()
    const auth = fakeReauth()
    const { handlers } = renderDialog({ auth })
    await user.type(screen.getByLabelText("Password"), "pw")
    await user.click(screen.getByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(handlers.onConfirmed).toHaveBeenCalledTimes(1))
    expect(auth.revokeSession).toHaveBeenCalledWith("t-old")
  })

  it("still confirms when revoking the replaced session fails", async () => {
    const user = userEvent.setup()
    const auth = fakeReauth({
      revokeSession: vi.fn(async () => {
        throw new WebError("Could not sign out that session", 500)
      }),
    })
    const { handlers } = renderDialog({ auth })
    await user.type(screen.getByLabelText("Password"), "pw")
    await user.click(screen.getByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(handlers.onConfirmed).toHaveBeenCalledTimes(1))
  })

  it("does not revoke anything when the sign-in leaves the old session in place", async () => {
    const user = userEvent.setup()
    const auth = fakeReauth({ signInWithPassword: vi.fn(async () => "done" as const) })
    renderDialog({ auth })
    await user.type(screen.getByLabelText("Password"), "pw")
    await user.click(screen.getByRole("button", { name: "Confirm" }))
    await screen.findByRole("alert")
    expect(auth.revokeSession).not.toHaveBeenCalled()
  })

  it("does not confirm when the sign-in leaves the old session in place", async () => {
    const user = userEvent.setup()
    const auth = fakeReauth({ signInWithPassword: vi.fn(async () => "done" as const) })
    const { handlers } = renderDialog({ auth })
    await user.type(screen.getByLabelText("Password"), "pw")
    await user.click(screen.getByRole("button", { name: "Confirm" }))
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not confirm it's you. Try again.",
    )
    expect(handlers.onConfirmed).not.toHaveBeenCalled()
  })

  it("asks for the authenticator code in place when the account has two-factor", async () => {
    const user = userEvent.setup()
    const auth = fakeReauth({ signInWithPassword: vi.fn(async () => "two-factor" as const) })
    const { handlers } = renderDialog({ auth })
    await user.type(screen.getByLabelText("Password"), "pw")
    await user.click(screen.getByRole("button", { name: "Confirm" }))
    await user.type(await screen.findByLabelText("Authenticator code"), "123456")
    await user.click(screen.getByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(handlers.onConfirmed).toHaveBeenCalledTimes(1))
    expect(auth.verifyCode).toHaveBeenCalledWith("123456")
  })

  it("offers a backup code from the code step", async () => {
    const user = userEvent.setup()
    const auth = fakeReauth({ signInWithPassword: vi.fn(async () => "two-factor" as const) })
    const { handlers } = renderDialog({ auth })
    await user.type(screen.getByLabelText("Password"), "pw")
    await user.click(screen.getByRole("button", { name: "Confirm" }))
    await user.click(await screen.findByRole("button", { name: "Use a backup code" }))
    await user.type(screen.getByLabelText("Backup code"), "abcd-1234")
    await user.click(screen.getByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(handlers.onConfirmed).toHaveBeenCalledTimes(1))
    expect(auth.verifyBackupCode).toHaveBeenCalledWith("abcd-1234")
    expect(auth.verifyCode).not.toHaveBeenCalled()
  })

  it("confirms with a passkey, and reloads when the passkey signed in a different account", async () => {
    const user = userEvent.setup()
    let userId = "u1"
    const auth = fakeReauth({
      session: vi.fn(async () => ({ userId, token: "t", activeOrganizationId: null })),
      signInWithPasskey: vi.fn(async () => {
        userId = "u2"
      }),
    })
    const { handlers } = renderDialog({ auth })
    await user.click(screen.getByRole("button", { name: "Use your passkey" }))
    await waitFor(() => expect(handlers.onMismatch).toHaveBeenCalledTimes(1))
    expect(handlers.onConfirmed).not.toHaveBeenCalled()
  })

  it("for an account with no password or passkey, offers only sign out and sign in again", async () => {
    const user = userEvent.setup()
    const auth = fakeReauth()
    const { handlers } = renderDialog({
      auth,
      methods: { email: "ada@example.com", hasPassword: false, hasPasskey: false },
    })
    expect(screen.queryByLabelText("Password")).toBeNull()
    expect(screen.getByText(/signs in another way/)).toBeTruthy()
    await user.click(screen.getByRole("button", { name: "Sign out and sign in again" }))
    await waitFor(() => expect(handlers.onSignedOut).toHaveBeenCalledTimes(1))
    expect(auth.signOut).toHaveBeenCalledTimes(1)
  })

  it("cancels without confirming", async () => {
    const user = userEvent.setup()
    const { handlers } = renderDialog({ auth: fakeReauth() })
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    expect(handlers.onCancel).toHaveBeenCalledTimes(1)
    expect(handlers.onConfirmed).not.toHaveBeenCalled()
  })
})

describe("ReauthProvider", () => {
  const source = (): ReauthMethodSource => ({
    getProfile: vi.fn(async () => ({
      id: "u1",
      name: "Ada",
      email: "ada@example.com",
      emailVerified: true,
      currentSessionToken: "t-old",
    })),
    listAccounts: vi.fn(async () => [{ id: "cred-1", providerId: "credential", createdAt: null }]),
    listPasskeys: vi.fn(async () => []),
  })

  /** A button that asks for a confirmation and reports the answer. */
  function Probe({ onResult }: { onResult: (ok: boolean) => void }) {
    const confirm: ReauthConfirm = useReauth()
    return (
      <button
        type="button"
        onClick={() => {
          void confirm().then(onResult)
        }}
      >
        Ask
      </button>
    )
  }

  it("resolves false when the person cancels, and shares one dialog between concurrent asks", async () => {
    const people = source()
    const onResult = vi.fn()
    renderWithClient(
      <ReauthProvider auth={fakeReauth()} api={people} reload={vi.fn()}>
        <Probe onResult={onResult} />
      </ReauthProvider>,
    )
    // Two asks before the first resolves: one account read, one dialog.
    const ask = screen.getByRole("button", { name: "Ask" })
    fireEvent.click(ask)
    fireEvent.click(ask)
    expect(await screen.findByRole("heading", { name: "Confirm it's you" })).toBeTruthy()
    expect(screen.getAllByRole("heading", { name: "Confirm it's you" })).toHaveLength(1)
    expect(people.getProfile).toHaveBeenCalledTimes(1)
    const user = userEvent.setup()
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(2))
    expect(onResult.mock.calls).toEqual([[false], [false]])
  })

  it("resolves true after a confirmed re-sign-in", async () => {
    const user = userEvent.setup()
    const onResult = vi.fn()
    renderWithClient(
      <ReauthProvider auth={fakeReauth()} api={source()} reload={vi.fn()}>
        <Probe onResult={onResult} />
      </ReauthProvider>,
    )
    await user.click(screen.getByRole("button", { name: "Ask" }))
    await user.type(await screen.findByLabelText("Password"), "pw")
    await user.click(screen.getByRole("button", { name: "Confirm" }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true))
  })

  it("resolves false without a dialog when no provider is mounted", async () => {
    const onResult = vi.fn()
    renderWithClient(<Probe onResult={onResult} />)
    await userEvent.setup().click(screen.getByRole("button", { name: "Ask" }))
    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false))
    expect(screen.queryByRole("heading", { name: "Confirm it's you" })).toBeNull()
  })
})
