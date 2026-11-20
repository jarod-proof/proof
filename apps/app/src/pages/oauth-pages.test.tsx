// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setNavigator } from "../lib/navigation"
import { fakeAuth } from "../test/fake-auth"
import { fakeReauthAuth, notFresh, renderWithReauth } from "../test/reauth"
import { ConsentPage, SelectOrganizationPage } from "./oauth-pages"

// jsdom can't load another page: record where the page sends the browser instead.
const navigate = vi.fn<(url: string) => void>()

beforeEach(() => {
  navigate.mockReset()
  setNavigator(navigate)
})

afterEach(() => {
  setNavigator(undefined)
})

const consentProps = { clientId: "client-1", scope: "openid read write" }

describe("ConsentPage", () => {
  it("has no accessibility violations once loaded", async () => {
    const { container } = render(<ConsentPage auth={fakeAuth()} {...consentProps} />)
    await screen.findByRole("button", { name: "Allow" })
    await expectNoA11yViolations(container.innerHTML)
  })

  it("names the client, the scopes in plain words and the organization", async () => {
    render(<ConsentPage auth={fakeAuth()} {...consentProps} />)
    expect(
      await screen.findByRole("heading", { name: "Allow Claude Code to connect?" }),
    ).toBeTruthy()
    expect(screen.getByText("Read data in the organization")).toBeTruthy()
    expect(screen.getByText("Create and change data in the organization")).toBeTruthy()
    expect(screen.getByRole("combobox", { name: "Organization" })).toHaveProperty("value", "org-a")
  })

  it("sets the chosen organization active before it accepts", async () => {
    const auth = fakeAuth({ consent: vi.fn(async () => "https://auth.example.com/done") })
    render(<ConsentPage auth={auth} {...consentProps} />)
    const user = userEvent.setup()
    await user.selectOptions(await screen.findByRole("combobox", { name: "Organization" }), "org-b")
    await user.click(screen.getByRole("button", { name: "Allow" }))

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://auth.example.com/done"))
    expect(auth.setActiveOrganization).toHaveBeenCalledWith("org-b")
    expect(auth.consent).toHaveBeenCalledWith(true)
    const setActive = vi.mocked(auth.setActiveOrganization).mock.invocationCallOrder[0] ?? 0
    const accept = vi.mocked(auth.consent).mock.invocationCallOrder[0] ?? 0
    expect(setActive).toBeLessThan(accept)
  })

  it("sets the shown organization active even when it was active at load", async () => {
    // Another tab may have switched the session's active org since this page loaded; consent
    // grants whatever is active on the server, so the page must re-assert what it shows.
    const auth = fakeAuth()
    render(<ConsentPage auth={auth} {...consentProps} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Allow" }))

    await waitFor(() => expect(auth.consent).toHaveBeenCalledWith(true))
    expect(auth.setActiveOrganization).toHaveBeenCalledWith("org-a")
    const setActive = vi.mocked(auth.setActiveOrganization).mock.invocationCallOrder[0] ?? 0
    const accept = vi.mocked(auth.consent).mock.invocationCallOrder[0] ?? 0
    expect(setActive).toBeLessThan(accept)
  })

  it("denies without changing the organization", async () => {
    const auth = fakeAuth({ consent: vi.fn(async () => "https://auth.example.com/denied") })
    render(<ConsentPage auth={auth} {...consentProps} />)
    const user = userEvent.setup()
    await user.selectOptions(await screen.findByRole("combobox", { name: "Organization" }), "org-b")
    await user.click(screen.getByRole("button", { name: "Deny" }))

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://auth.example.com/denied"))
    expect(auth.consent).toHaveBeenCalledWith(false)
    expect(auth.setActiveOrganization).not.toHaveBeenCalled()
  })

  it("shows the error and re-enables the buttons when the server refuses", async () => {
    const auth = fakeAuth({
      consent: vi.fn(async () => {
        throw new Error("Scope not originally requested")
      }),
    })
    render(<ConsentPage auth={auth} {...consentProps} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Allow" }))

    expect(await screen.findByText("Scope not originally requested")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Allow" })).toHaveProperty("disabled", false)
  })

  it("asks the person to sign in when there is no session", async () => {
    render(
      <ConsentPage auth={fakeAuth({ getSession: vi.fn(async () => null) })} {...consentProps} />,
    )
    expect(await screen.findByRole("heading", { name: "Sign in to continue" })).toBeTruthy()
  })

  it("explains a request with no client id", async () => {
    render(<ConsentPage auth={fakeAuth()} clientId={undefined} scope={undefined} />)
    expect(await screen.findByText("This page needs an authorization request.")).toBeTruthy()
  })

  it("reports a failed load", async () => {
    const auth = fakeAuth({
      listOrganizations: vi.fn(async () => {
        throw new Error("Could not load organizations")
      }),
    })
    render(<ConsentPage auth={auth} {...consentProps} />)
    expect(await screen.findByText("Could not load organizations")).toBeTruthy()
  })

  it("shows the no-organization state with nothing to allow", async () => {
    const auth = fakeAuth({ listOrganizations: vi.fn(async () => []) })
    render(<ConsentPage auth={auth} {...consentProps} />)
    expect(
      await screen.findByText(
        "You do not belong to an organization, so there is nothing to grant.",
      ),
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "Allow" })).toHaveProperty("disabled", true)
  })

  it("uses a fallback client name and says when no scopes were asked for", async () => {
    const auth = fakeAuth({ getClientName: vi.fn(async () => null) })
    render(<ConsentPage auth={auth} clientId="client-2" scope={undefined} />)
    expect(
      await screen.findByRole("heading", { name: "Allow An application to connect?" }),
    ).toBeTruthy()
    expect(screen.getByText("No specific permissions were requested.")).toBeTruthy()
  })
})

describe("SelectOrganizationPage", () => {
  it("has no accessibility violations once loaded", async () => {
    const { container } = render(<SelectOrganizationPage auth={fakeAuth()} />)
    await screen.findByRole("button", { name: "Continue" })
    await expectNoA11yViolations(container.innerHTML)
  })

  it("sets the organization, then posts continue and follows it", async () => {
    const auth = fakeAuth({
      continueOAuth: vi.fn(async () => "https://auth.example.com/resumed"),
    })
    render(<SelectOrganizationPage auth={auth} />)
    const user = userEvent.setup()
    await user.selectOptions(await screen.findByRole("combobox", { name: "Organization" }), "org-b")
    await user.click(screen.getByRole("button", { name: "Continue" }))

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://auth.example.com/resumed"))
    expect(auth.setActiveOrganization).toHaveBeenCalledWith("org-b")
    expect(auth.continueOAuth).toHaveBeenCalledTimes(1)
    const setActive = vi.mocked(auth.setActiveOrganization).mock.invocationCallOrder[0] ?? 0
    const continued = vi.mocked(auth.continueOAuth).mock.invocationCallOrder[0] ?? 0
    expect(setActive).toBeLessThan(continued)
  })

  it("reports when the sign-in cannot be resumed", async () => {
    const auth = fakeAuth({ continueOAuth: vi.fn(async () => undefined) })
    render(<SelectOrganizationPage auth={auth} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Continue" }))

    expect(
      await screen.findByText(
        "The sign-in could not be resumed. Start it again from the application.",
      ),
    ).toBeTruthy()
    expect(navigate).not.toHaveBeenCalled()
  })

  it("shows the server's message when continuing fails", async () => {
    const auth = fakeAuth({
      continueOAuth: vi.fn(async () => {
        throw new Error("Could not continue")
      }),
    })
    render(<SelectOrganizationPage auth={auth} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Continue" }))
    expect(await screen.findByText("Could not continue")).toBeTruthy()
  })

  it("asks for a sign-in when there is no session", async () => {
    render(<SelectOrganizationPage auth={fakeAuth({ getSession: vi.fn(async () => null) })} />)
    expect(await screen.findByRole("heading", { name: "Sign in first" })).toBeTruthy()
  })

  it("explains when the person belongs to no organization", async () => {
    render(<SelectOrganizationPage auth={fakeAuth({ listOrganizations: vi.fn(async () => []) })} />)
    expect(await screen.findByText("You do not belong to an organization yet.")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Continue" })).toHaveProperty("disabled", true)
  })

  it("reports a failed load", async () => {
    const auth = fakeAuth({
      getSession: vi.fn(async () => {
        throw new Error("Network down")
      }),
    })
    render(<SelectOrganizationPage auth={auth} />)
    expect(await screen.findByText("Network down")).toBeTruthy()
  })
})

describe("organization choice when the active organization is not listed", () => {
  const staleSession = vi.fn(async () => ({
    user: { id: "user-1", email: "ada@example.com", name: "Ada" },
    activeOrganizationId: "org-gone",
  }))

  it("grants the first listed organization, not the stale active one", async () => {
    const auth = fakeAuth({ getSession: staleSession })
    render(<ConsentPage auth={auth} {...consentProps} />)
    await userEvent.setup().click(await screen.findByRole("button", { name: "Allow" }))

    await waitFor(() => expect(auth.consent).toHaveBeenCalledWith(true))
    expect(auth.setActiveOrganization).toHaveBeenCalledWith("org-a")
  })

  it("continues with the first listed organization, not the stale active one", async () => {
    const auth = fakeAuth({ getSession: staleSession })
    render(<SelectOrganizationPage auth={auth} />)
    await userEvent.setup().click(await screen.findByRole("button", { name: "Continue" }))

    await waitFor(() => expect(auth.continueOAuth).toHaveBeenCalled())
    expect(auth.setActiveOrganization).toHaveBeenCalledWith("org-a")
  })

  describe("ConsentPage when the session is not fresh", () => {
    const consentUrl = "/consent?client_id=client-1&scope=openid+read&sig=abc%2Bdef&exp=1"

    afterEach(() => {
      window.history.replaceState(null, "", "/")
    })

    it("asks the person to confirm it's them, then allows once more", async () => {
      window.history.replaceState(null, "", consentUrl)
      const auth = fakeAuth({
        consent: vi
          .fn()
          .mockRejectedValueOnce(notFresh())
          .mockResolvedValueOnce("https://auth.example.com/done"),
      })
      const { reauth } = renderWithReauth(<ConsentPage auth={auth} {...consentProps} />)
      const user = userEvent.setup()
      await user.click(await screen.findByRole("button", { name: "Allow" }))
      const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" })
      await user.type(within(dialog).getByLabelText("Password"), "pw")
      await user.click(within(dialog).getByRole("button", { name: "Confirm" }))

      await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://auth.example.com/done"))
      expect(auth.consent).toHaveBeenCalledTimes(2)
      expect(auth.consent).toHaveBeenLastCalledWith(true)
      expect(reauth.signInWithPassword).toHaveBeenCalledTimes(1)
      // The page's own URL, and so its signed OAuth query, is untouched by the re-sign-in.
      expect(window.location.pathname + window.location.search).toBe(consentUrl)
    })

    it("keeps the organization it was set to through the retry", async () => {
      const user = userEvent.setup()
      // The page's organization choice lands on the session the reauth client reads, as on the server.
      const reauth = fakeReauthAuth()
      const auth = fakeAuth({
        setActiveOrganization: vi.fn(async (organizationId: string) =>
          reauth.setActiveOrganization(organizationId),
        ),
        consent: vi
          .fn()
          .mockRejectedValueOnce(notFresh())
          .mockResolvedValueOnce("https://auth.example.com/done"),
      })
      renderWithReauth(<ConsentPage auth={auth} {...consentProps} />, reauth)
      await user.selectOptions(
        await screen.findByRole("combobox", { name: "Organization" }),
        "org-b",
      )
      await user.click(screen.getByRole("button", { name: "Allow" }))
      const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" })
      await user.type(within(dialog).getByLabelText("Password"), "pw")
      await user.click(within(dialog).getByRole("button", { name: "Confirm" }))

      await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://auth.example.com/done"))
      expect(reauth.setActiveOrganization).toHaveBeenLastCalledWith("org-b")
    })

    it("cancelled: shows the refusal and does not allow again", async () => {
      const user = userEvent.setup()
      const auth = fakeAuth({ consent: vi.fn().mockRejectedValue(notFresh()) })
      renderWithReauth(<ConsentPage auth={auth} {...consentProps} />)
      await user.click(await screen.findByRole("button", { name: "Allow" }))
      const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" })
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }))

      expect(
        await screen.findByText(
          "Sign in again to continue. Changes like this need a recent sign-in.",
        ),
      ).toBeTruthy()
      expect(auth.consent).toHaveBeenCalledTimes(1)
      expect(navigate).not.toHaveBeenCalled()
    })

    it("sign out and sign in again returns to the consent URL with its query", async () => {
      window.history.replaceState(null, "", consentUrl)
      const user = userEvent.setup()
      const auth = fakeAuth({ consent: vi.fn().mockRejectedValue(notFresh()) })
      const { reauth } = renderWithReauth(<ConsentPage auth={auth} {...consentProps} />)
      await user.click(await screen.findByRole("button", { name: "Allow" }))
      const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" })
      await user.click(within(dialog).getByRole("button", { name: "Sign out and sign in again" }))

      await waitFor(() =>
        expect(navigate).toHaveBeenCalledWith(`/sign-in?next=${encodeURIComponent(consentUrl)}`),
      )
      expect(reauth.signOut).toHaveBeenCalledTimes(1)
      expect(auth.consent).toHaveBeenCalledTimes(1)
    })

    it("refuses a deny the same way, and retries it once", async () => {
      const user = userEvent.setup()
      const auth = fakeAuth({
        consent: vi
          .fn()
          .mockRejectedValueOnce(notFresh())
          .mockResolvedValueOnce("https://auth.example.com/denied"),
      })
      renderWithReauth(<ConsentPage auth={auth} {...consentProps} />)
      await user.click(await screen.findByRole("button", { name: "Deny" }))
      const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" })
      await user.type(within(dialog).getByLabelText("Password"), "pw")
      await user.click(within(dialog).getByRole("button", { name: "Confirm" }))

      await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://auth.example.com/denied"))
      expect(auth.consent).toHaveBeenLastCalledWith(false)
    })
  })
})
