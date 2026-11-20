// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { fakeAuth } from "../test/fake-auth"
import { renderWithClient } from "../test/render"
import { customerTicket, fakeSupportClient } from "../test/fake-support"
import { SupportTicketContainer } from "./support-ticket"

function render(ticketId: string | undefined, client = fakeSupportClient(), onNavigate = vi.fn()) {
  renderWithClient(
    <SupportTicketContainer
      auth={fakeAuth({ support: client })}
      client={client}
      ticketId={ticketId}
      onNavigate={onNavigate}
      pollInterval={0}
    />,
  )
  return client
}

describe("SupportTicketContainer", () => {
  it("shows the requester's ticket thread in the page, not in a popover", async () => {
    const client = render("t1", fakeSupportClient({ tickets: [customerTicket()] }))
    expect(screen.getByRole("heading", { name: "Support tickets" })).toBeTruthy()
    await waitFor(() => expect(client.support.ticket).toHaveBeenCalledWith({ query: { id: "t1" } }))
    expect(await screen.findByRole("button", { name: "Back" })).toBeTruthy()
    expect(screen.queryByRole("dialog")).toBeNull()
    await expectNoA11yViolations(document.body.innerHTML)
  })

  it("shows the thread's error when the ticket can't be read", async () => {
    render("someone-elses")
    expect(await screen.findByRole("alert")).toBeTruthy()
  })

  it("moves the URL with the person: Back to the list, a row to its ticket", async () => {
    const onNavigate = vi.fn()
    render("t1", fakeSupportClient({ tickets: [customerTicket()] }), onNavigate)
    // The ticket the URL opened is not reported back.
    await userEvent.click(await screen.findByRole("button", { name: "Back" }))
    expect(onNavigate).toHaveBeenCalledWith("/account/support")
    expect(onNavigate).toHaveBeenCalledTimes(1)
    await userEvent.click(await screen.findByRole("button", { name: /Can't export runs/ }))
    expect(onNavigate).toHaveBeenLastCalledWith("/account/support/t1")
  })

  it("lists the person's tickets without an id", async () => {
    render(undefined, fakeSupportClient({ tickets: [customerTicket()] }))
    expect(await screen.findByRole("heading", { name: "My tickets" })).toBeTruthy()
    expect(screen.getByRole("button", { name: /Can't export runs/ })).toBeTruthy()
  })
})
