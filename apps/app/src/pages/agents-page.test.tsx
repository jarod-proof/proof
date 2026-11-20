// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { AgentsApi, AuditEvent, ConnectedAgent } from "../lib/agents-api"
import { SESSION_NOT_FRESH_CODE, withReauth } from "../lib/reauth"
import { WebError } from "../lib/web-auth"
import { type CallGuard, AgentsPage } from "./agents-page"

const agent: ConnectedAgent = {
  id: "agent-1",
  type: "oauthClient",
  name: "Claude Code",
  createdAt: "2026-10-01T10:00:00Z",
  lastUsedAt: null,
  access: ["read", "write"],
}

const event: AuditEvent = {
  id: "evt-1",
  at: "2026-10-02T10:00:00Z",
  actor: { type: "user", id: "u1" },
  clientId: "agent-1",
  operation: "create_project",
  outcome: "ok",
  requestId: "req-1",
}

function fakeApi(overrides: Partial<AgentsApi> = {}): AgentsApi {
  return {
    listAgents: vi.fn(async () => [agent]),
    revokeAgent: vi.fn(async () => undefined),
    listAuditEvents: vi.fn(async () => ({ events: [event], nextCursor: null })),
    ...overrides,
  }
}

describe("AgentsPage", () => {
  it("lists connected agents and recent activity without accessibility violations", async () => {
    const api = fakeApi()
    const { container } = render(<AgentsPage api={api} />)
    expect(await screen.findByText("Claude Code")).toBeTruthy()
    expect(screen.getByText("Access: read, write")).toBeTruthy()
    expect(screen.getByText("create_project")).toBeTruthy()
    await expectNoA11yViolations(container.innerHTML)
  })

  it("says so when there are no agents and no activity", async () => {
    const api = fakeApi({
      listAgents: vi.fn(async () => []),
      listAuditEvents: vi.fn(async () => ({ events: [], nextCursor: null })),
    })
    render(<AgentsPage api={api} />)
    expect(await screen.findByText("No agents are connected.")).toBeTruthy()
    expect(screen.getByText("No activity yet.")).toBeTruthy()
  })

  it("revokes an agent after confirmation and removes it from the list", async () => {
    const api = fakeApi()
    render(<AgentsPage api={api} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Revoke access" }))

    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Revoke access" }))

    await waitFor(() => expect(api.revokeAgent).toHaveBeenCalledWith("agent-1"))
    await waitFor(() => expect(screen.getByText("No agents are connected.")).toBeTruthy())
  })

  it("runs the revoke through the guard, and retries it once after a re-sign-in", async () => {
    const api = fakeApi({
      revokeAgent: vi
        .fn()
        .mockRejectedValueOnce(new WebError("Sign in again", 403, SESSION_NOT_FRESH_CODE))
        .mockResolvedValueOnce(undefined),
    })
    // The guard the route passes: the real withReauth, with a person who confirms.
    const guarded: string[] = []
    const guard: CallGuard = (action) => {
      guarded.push("revoke")
      return withReauth(action, async () => true)
    }
    render(<AgentsPage api={api} guard={guard} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Revoke access" }))
    const dialog = await screen.findByRole("alertdialog")
    await user.click(within(dialog).getByRole("button", { name: "Revoke access" }))
    await waitFor(() => expect(screen.getByText("No agents are connected.")).toBeTruthy())
    expect(guarded).toEqual(["revoke"])
    expect(api.revokeAgent).toHaveBeenCalledTimes(2)
  })

  it("revokes once when the confirm is clicked twice", async () => {
    let finish: () => void = () => {}
    const api = fakeApi({
      revokeAgent: vi.fn(
        () =>
          new Promise<undefined>((resolve) => {
            finish = () => resolve(undefined)
          }),
      ),
    })
    const user = userEvent.setup()
    render(<AgentsPage api={api} />)
    await user.click(await screen.findByRole("button", { name: "Revoke access" }))
    const confirm = within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Revoke access",
    })
    await user.click(confirm)
    await user.click(confirm)
    expect(api.revokeAgent).toHaveBeenCalledTimes(1)
    finish()
    await waitFor(() => expect(screen.queryByText("Claude Code")).toBeNull())
  })

  it("loads the next page of activity", async () => {
    const api = fakeApi({
      listAuditEvents: vi
        .fn()
        .mockResolvedValueOnce({ events: [event], nextCursor: "c1" })
        .mockResolvedValueOnce({
          events: [{ ...event, id: "evt-2", operation: "whoami" }],
          nextCursor: null,
        }),
    })
    render(<AgentsPage api={api} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Load more" }))

    expect(await screen.findByText("whoami")).toBeTruthy()
    expect(api.listAuditEvents).toHaveBeenLastCalledWith("c1")
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull()
  })

  it("shows the server's message when the list cannot be loaded", async () => {
    const api = fakeApi({
      listAgents: vi.fn(async () => {
        throw new Error("Sign in to see your agents")
      }),
    })
    render(<AgentsPage api={api} />)
    expect(await screen.findByText("Sign in to see your agents")).toBeTruthy()
  })

  it("shows the server's message when a revoke is refused", async () => {
    const api = fakeApi({
      revokeAgent: vi.fn(async () => {
        throw new Error("Needs the admin permission")
      }),
    })
    render(<AgentsPage api={api} />)
    const user = userEvent.setup()
    await user.click(await screen.findByRole("button", { name: "Revoke access" }))
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revoke access" }),
    )
    expect(await screen.findByText("Needs the admin permission")).toBeTruthy()
  })

  it("names an API key and shows when it was last used", async () => {
    const key: ConnectedAgent = {
      ...agent,
      id: "key-1",
      type: "apiKey",
      name: "CI bot",
      lastUsedAt: "2026-10-05T08:00:00Z",
      access: [],
    }
    const api = fakeApi({ listAgents: vi.fn(async () => [key]) })
    render(<AgentsPage api={api} />)
    expect(await screen.findByText("API key")).toBeTruthy()
    expect(screen.getByText("Access: none")).toBeTruthy()
  })
})

describe("AgentsPage landmark", () => {
  it("leaves the landmark to the app shell rather than nesting a main", () => {
    render(<AgentsPage api={fakeApi()} />)
    expect(document.querySelector("main")).toBeNull()
  })
})
