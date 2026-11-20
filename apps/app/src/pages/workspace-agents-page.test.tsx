// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { AgentView } from "../lib/workspace-agents"
import type { WorkspaceAgent } from "../lib/workspace-agents-api"
import { renderWithClient } from "../test/render"
import { type WorkspaceAgentsPageProps, WorkspaceAgentsPage } from "./workspace-agents-page"

const agent: WorkspaceAgent = {
  id: "agent-1",
  name: "Release triage",
  description: "Groups release blockers",
  autonomy: "ask_first",
  alwaysAskExternalPost: true,
  alwaysAskMergeOrDeploy: true,
  alwaysAskOverEnergyBudget: false,
  energyBudgetWh: null,
  pinned: true,
  activity: "running",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
}

function props(overrides: Partial<WorkspaceAgentsPageProps> = {}): WorkspaceAgentsPageProps {
  return {
    organization: { id: "org-a", name: "Acme Inc", slug: "acme" },
    roleLabel: "Owner",
    view: "permissions",
    connected: () => <p>Connected view</p>,
    canRead: true,
    canCreate: true,
    canUpdate: true,
    canDelete: true,
    agents: [agent],
    agentsPending: false,
    agentsError: null,
    onRetry: vi.fn(),
    selected: agent,
    runCount: 2,
    actionError: null,
    onSelect: vi.fn(),
    onCreate: vi.fn(async () => undefined),
    onUpdate: vi.fn(async () => undefined),
    onRemove: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe("WorkspaceAgentsPage", () => {
  it("shows the list, the permissions and the delete consequence for an owner", () => {
    renderWithClient(<WorkspaceAgentsPage {...props()} />)
    expect(screen.getByRole("heading", { name: "Agent permissions" })).toBeTruthy()
    expect(screen.getByText("Running")).toBeTruthy()
    expect(screen.getByRole("switch", { name: "Pin Release triage to the sidebar" })).toBeTruthy()
    expect(
      screen
        .getByRole("switch", { name: "Post outside the organization" })
        .getAttribute("aria-checked"),
    ).toBe("true")
    expect(
      screen.getByText(
        "Deletes Release triage and its 2 runs and their history. This can't be undone.",
      ),
    ).toBeTruthy()
    expect(screen.getByRole("link", { name: "Connected" }).getAttribute("href")).toBe(
      "/acme/settings/agents?view=connected",
    )
  })

  it("explains the empty state and how an agent connects", () => {
    renderWithClient(<WorkspaceAgentsPage {...props({ agents: [], selected: undefined })} />)
    expect(screen.getByRole("heading", { name: "No agents yet" })).toBeTruthy()
    const empty = within(screen.getByRole("region", { name: "No agents yet" }))
    expect(empty.getByRole("link", { name: "API keys" }).getAttribute("href")).toBe(
      "/acme/settings/api-keys",
    )
    expect(
      screen.getByRole("link", { name: "Install snippets (llms.txt)" }).getAttribute("href"),
    ).toBe("/llms.txt")
  })

  it("marks the unsupported Guardrails tab as a placeholder", () => {
    renderWithClient(<WorkspaceAgentsPage {...props({ view: "guardrails" })} />)
    expect(screen.getByText(/\[PLACEHOLDER\] The API has no guardrail settings/)).toBeTruthy()
  })

  it("saves the selected agent's energy budget, and clears it when left empty", async () => {
    const onUpdate = vi.fn(async () => undefined)
    const { user } = renderBudget({ onUpdate })
    const input = screen.getByRole("textbox", { name: "Energy budget per run (Wh)" })
    await user.type(input, "2.5")
    await user.click(screen.getByRole("button", { name: "Save budget" }))
    expect(onUpdate).toHaveBeenCalledWith(agent.id, { energyBudgetWh: 2.5 })
    await user.clear(input)
    await user.click(screen.getByRole("button", { name: "Save budget" }))
    expect(onUpdate).toHaveBeenLastCalledWith(agent.id, { energyBudgetWh: null })
  })

  it("refuses a budget that is not a positive number, without saving", async () => {
    const onUpdate = vi.fn(async () => undefined)
    const { user } = renderBudget({ onUpdate })
    await user.type(screen.getByRole("textbox", { name: "Energy budget per run (Wh)" }), "-3")
    await user.click(screen.getByRole("button", { name: "Save budget" }))
    expect(
      await screen.findByText("Enter watt-hours above 0, or leave it empty for no budget."),
    ).toBeTruthy()
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it("shows a viewer the budget read-only", () => {
    renderWithClient(<WorkspaceAgentsPage {...props({ view: "budgets", canUpdate: false })} />)
    expect(screen.queryByRole("button", { name: "Save budget" })).toBeNull()
    expect(screen.getByText(/Viewers can read the budget/)).toBeTruthy()
  })

  it("has exactly one h1 on the connected view, the settings header's", () => {
    renderWithClient(
      <WorkspaceAgentsPage
        {...props({ view: "connected", connected: () => <h2>Connected view</h2> })}
      />,
    )
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1)
  })

  it("puts the level-2 pills in each view's section heading row, marking the current one", () => {
    const pillLabel: Record<AgentView, string> = {
      permissions: "Permissions",
      guardrails: "Guardrails",
      budgets: "Budgets & footprint",
      connected: "Connected",
    }
    const cases: [AgentView, string][] = [
      ["permissions", "Agent permissions"],
      ["guardrails", "Guardrails"],
      ["budgets", "Budgets and footprint"],
    ]
    for (const [view, heading] of cases) {
      const { unmount } = renderWithClient(
        <WorkspaceAgentsPage {...props({ view, selected: undefined })} />,
      )
      const nav = screen.getByRole("navigation", { name: "Organization settings sub-sections" })
      const row = screen.getByRole("heading", { name: heading }).parentElement?.parentElement
      expect(row?.contains(nav)).toBe(true)
      expect(screen.getByRole("link", { name: "Connected" }).getAttribute("href")).toBe(
        "/acme/settings/agents?view=connected",
      )
      const current = within(nav).getByRole("link", { name: pillLabel[view] })
      expect(current.getAttribute("aria-current")).toBe("page")
      unmount()
    }
  })

  it("renders the connected view in place of the board", () => {
    renderWithClient(<WorkspaceAgentsPage {...props({ view: "connected" })} />)
    expect(screen.getByText("Connected view")).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "Agent permissions" })).toBeNull()
  })

  it("is view-only for a viewer, and says why create and delete are off", () => {
    renderWithClient(
      <WorkspaceAgentsPage
        {...props({ roleLabel: "Viewer", canCreate: false, canUpdate: false, canDelete: false })}
      />,
    )
    expect(screen.getByRole("region", { name: "View-only access" })).toBeTruthy()
    expect(
      screen.getByText("Viewers can't create agents. Ask an owner, admin or member."),
    ).toBeTruthy()
    expect(screen.getByText("Only owners and admins can delete agents.")).toBeTruthy()
  })

  it("shows the list error with a retry", () => {
    const onRetry = vi.fn()
    renderWithClient(
      <WorkspaceAgentsPage
        {...props({ agents: undefined, agentsError: "Service unavailable", onRetry })}
      />,
    )
    expect(screen.getByRole("alert").textContent).toContain("Service unavailable")
    screen.getByRole("button", { name: "Try again" }).click()
    expect(onRetry).toHaveBeenCalled()
  })

  it("has no accessibility violations (owner, empty, viewer)", async () => {
    renderWithClient(<WorkspaceAgentsPage {...props()} />)
    await expectNoA11yViolations(document.body.innerHTML)
  })

  it("has no accessibility violations on the empty state", async () => {
    renderWithClient(<WorkspaceAgentsPage {...props({ agents: [], selected: undefined })} />)
    await expectNoA11yViolations(document.body.innerHTML)
  })
})

function renderBudget(overrides: Partial<WorkspaceAgentsPageProps>) {
  const onUpdate = overrides.onUpdate ?? vi.fn(async () => undefined)
  const rendered = renderWithClient(
    <WorkspaceAgentsPage {...props({ view: "budgets", onUpdate, ...overrides })} />,
  )
  return { ...rendered, onUpdate, user: userEvent.setup() }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("WorkspaceAgentsPage writes", () => {
  it("creates an agent once when Create agent is clicked twice", async () => {
    const user = userEvent.setup()
    const pending = deferred()
    const onCreate = vi.fn(() => pending.promise)
    renderWithClient(<WorkspaceAgentsPage {...props({ onCreate })} />)
    await user.click(screen.getByRole("button", { name: "Create agent" }))
    const dialog = await screen.findByRole("dialog")
    await user.type(within(dialog).getByLabelText("Name"), "Support triage")
    const submit = within(dialog).getByRole("button", { name: "Create agent" })
    await user.click(submit)
    await waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(true))
    fireEvent.click(submit)
    expect(onCreate).toHaveBeenCalledTimes(1)
    pending.resolve()
  })

  it("deletes an agent once when its confirm button is clicked twice", async () => {
    const user = userEvent.setup()
    const pending = deferred()
    const onRemove = vi.fn(() => pending.promise)
    renderWithClient(<WorkspaceAgentsPage {...props({ onRemove })} />)
    await user.click(screen.getByRole("button", { name: "Delete agent" }))
    const confirm = within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Delete agent",
    })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    expect(onRemove).toHaveBeenCalledTimes(1)
    pending.resolve()
  })

  it("names an element for every aria-labelledby on the page", () => {
    renderWithClient(<WorkspaceAgentsPage {...props()} />)
    const labelled = document.querySelectorAll<HTMLElement>("[aria-labelledby]")
    expect(labelled.length).toBeGreaterThan(0)
    for (const element of labelled) {
      for (const id of element.getAttribute("aria-labelledby")?.split(" ") ?? []) {
        expect(document.getElementById(id), `aria-labelledby="${id}"`).not.toBeNull()
      }
    }
  })

  it("leaves the landmark to the app shell rather than nesting a main", () => {
    renderWithClient(<WorkspaceAgentsPage {...props()} />)
    expect(document.querySelector("main")).toBeNull()
  })
})
