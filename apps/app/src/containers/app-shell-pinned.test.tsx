// @vitest-environment jsdom
import { anchorLink } from "@proof/ui/dplus/shell/link"
import { screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { WorkspaceAgent, WorkspaceAgentsApi } from "../lib/workspace-agents-api"
import { fakeAuth } from "../test/fake-auth"
import { renderWithClient } from "../test/render"
import { AppShellContainer } from "./app-shell"

const pinned: WorkspaceAgent = {
  id: "agent-1",
  name: "Release triage",
  description: null,
  autonomy: "ask_first",
  alwaysAskExternalPost: true,
  alwaysAskMergeOrDeploy: true,
  alwaysAskOverEnergyBudget: true,
  energyBudgetWh: null,
  pinned: true,
  activity: "needs_you",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
}

function agentsApi(): WorkspaceAgentsApi {
  return {
    list: vi.fn(async () => [pinned]),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    countRuns: vi.fn(),
  } as unknown as WorkspaceAgentsApi
}

function renderShell(auth: ReturnType<typeof fakeAuth>, agents: WorkspaceAgentsApi) {
  renderWithClient(
    <AppShellContainer
      auth={auth}
      slug="analytical"
      activeNav="agents"
      crumbs={[{ label: "Analytical Ltd" }]}
      onNavigate={vi.fn()}
      onSignedOut={vi.fn()}
      renderLink={anchorLink}
      agents={agents}
    >
      <h1>Analytical Ltd</h1>
    </AppShellContainer>,
  )
}

describe("AppShellContainer pinned agents", () => {
  it("lists the pinned agents once the session is on this organization", async () => {
    const agents = agentsApi()
    renderShell(fakeAuth(), agents)
    const list = await screen.findByRole("list", { name: "Pinned agents" })
    const link = within(list).getByRole("link", { name: /Release triage/ })
    expect(link.getAttribute("href")).toBe("/analytical/settings/agents?agent=agent-1")
    expect(agents.list).toHaveBeenCalledWith("org-a")
  })

  it("does not ask for agents while the session is on another organization (the server would refuse)", async () => {
    const agents = agentsApi()
    const auth = fakeAuth({
      getSession: vi.fn(async () => ({
        user: { id: "user-1", email: "ada@example.com", name: "Ada" },
        activeOrganizationId: "org-b",
      })),
    })
    renderShell(auth, agents)
    await screen.findByRole("button", { name: /current Analytical Ltd/ })
    expect(agents.list).not.toHaveBeenCalled()
    expect(screen.queryByRole("list", { name: "Pinned agents" })).toBeNull()
  })
})
