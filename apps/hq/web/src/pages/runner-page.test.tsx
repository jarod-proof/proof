// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { FactoryStatus, Policy } from "../api/schemas"
import { RunnerCard } from "../components/runner-card"
import { factoryStatusFixture, policyFixture } from "../test/fixtures"
import { renderInRouter } from "../test/render"
import { RunnerPage } from "./runner-page"

function page(status: FactoryStatus = factoryStatusFixture(), policy: Policy = policyFixture()) {
  return render(<RunnerPage status={status} policy={policy} />)
}

const region = (view: ReturnType<typeof page>, name: string) =>
  within(view.getByRole("region", { name }))

describe("RunnerPage header", () => {
  it("is 'Runner and policy' with the mock's subtitle and no header button", () => {
    const view = page()
    expect(view.getByRole("heading", { level: 1, name: "Runner and policy" })).toBeTruthy()
    expect(view.getByText("what runs on your machine, and how much freedom it has")).toBeTruthy()
    const header = view.getByRole("banner")
    expect(within(header).queryAllByRole("button")).toHaveLength(0)
  })
})

describe("Local runner", () => {
  it("lists the three runners with last run, and 'not recorded' for a null outcome", () => {
    const base = factoryStatusFixture()
    const status = {
      ...base,
      runners: [
        {
          runner: "eve" as const,
          lastStartedAt: "2026-11-17T08:00:00.000Z",
          lastOutcome: "failed" as const,
        },
        { runner: "sandbox" as const, lastStartedAt: null, lastOutcome: null },
        // a box-review run: it started and never closes, so its outcome stays null
        { runner: "box" as const, lastStartedAt: "2026-11-17T10:30:00.000Z", lastOutcome: null },
      ],
    }
    const local = region(page(status), "Local runner")
    const rows = local.getAllByRole("listitem")
    expect(rows).toHaveLength(3)
    const [eve, sandbox, box] = rows.map((row) => row.textContent ?? "")
    expect(eve).toContain("eve")
    expect(eve).toContain("2026-11-17 08:00 UTC")
    expect(eve).toContain("4h ago")
    expect(eve).toContain("failed")
    expect(sandbox).toContain("sandbox")
    expect(sandbox).toContain("none yet")
    expect(sandbox).toContain("not recorded")
    expect(box).toContain("box")
    expect(box).toContain("1h ago")
    expect(box).toContain("not recorded")
  })

  it("never says online, busy or stuck, and the status is Not reported", () => {
    const view = page()
    const local = region(view, "Local runner")
    expect(local.getByText("Runner status")).toBeTruthy()
    expect(local.getAllByText("Not reported").length).toBeGreaterThan(0)
    expect(view.container.textContent).not.toMatch(/\b(online|offline|busy|stuck|idle)\b/i)
  })

  it("has one Slots cell, 44 px tall, that reads 'not reported'", () => {
    const local = region(page(), "Local runner")
    expect(local.getByText("Slots")).toBeTruthy()
    const cell = local.getByText("not reported")
    expect(cell.className).toContain("min-h-touch")
  })
})

describe("Plan headroom", () => {
  it("is a progress element labelled as the Eve spend cap, with the percent and dollars", () => {
    const view = page()
    const bar = view.getByRole("progressbar", { name: "Eve spend cap, not your Claude plan" })
    expect(bar.tagName).toBe("PROGRESS")
    expect(bar.getAttribute("value")).toBe("62")
    expect(bar.getAttribute("max")).toBe("100")
    const headroom = region(view, "Plan headroom")
    expect(headroom.getByText("62% left")).toBeTruthy()
    expect(headroom.getByText(/\$6\.20 left of \$10\.00/)).toBeTruthy()
    expect(
      headroom.getByText(/Claude plan quota has no API, so no plan figure is shown/),
    ).toBeTruthy()
  })

  it("reads the same percent as the sidebar's runner card, with and without a grant", async () => {
    const base = factoryStatusFixture()
    const cases = [
      base,
      { ...base, allowance: { ...base.allowance, grantedUsd: 5, remainingUsd: 11.2 } },
      { ...base, allowance: { ...base.allowance, capUsd: 0, grantedUsd: 0, remainingUsd: 0 } },
      { ...base, allowance: { ...base.allowance, remainingUsd: 0, spentUsd: 10 } },
    ]
    for (const status of cases) {
      const card = await renderInRouter(<RunnerCard state="ready" status={status} />)
      const fromCard = card.getByRole("progressbar").getAttribute("value")
      card.unmount()
      const view = page(status)
      const bar = view.getByRole("progressbar", { name: "Eve spend cap, not your Claude plan" })
      expect(bar.getAttribute("value")).toBe(fromCard)
      expect(view.getByText(`${fromCard}% left`)).toBeTruthy()
      view.unmount()
    }
  })

  it("shows no reserve marker", () => {
    expect(page().container.textContent).not.toMatch(/reserve/i)
  })
})

describe("Heartbeat and notifications", () => {
  it("says the heartbeat is not reported, lists the alert rows as not set, and is not configured", () => {
    const beat = region(page(), "Heartbeat and notifications")
    expect(beat.getByText("Heartbeat")).toBeTruthy()
    expect(beat.getAllByText("Not reported").length).toBeGreaterThan(0)
    expect(beat.getAllByText("not set").length).toBe(5)
    expect(beat.getByRole("note").textContent).toBe(
      "Not configured: runner heartbeat and phone alerts. Arrives in a later phase.",
    )
    expect(beat.queryByText(/Beat \d+ s ago/)).toBeNull()
    expect(beat.queryByText(/Pushes today/)).toBeNull()
  })
})

describe("Budgets per attempt", () => {
  it("lists the four labels as not set and never the mock's numbers", () => {
    const budgets = region(page(), "Budgets per attempt")
    for (const label of ["Attempts per item", "Attempts per day", "Turn limit", "Timeout"]) {
      expect(budgets.getByText(label)).toBeTruthy()
    }
    expect(budgets.getAllByText("not set")).toHaveLength(4)
    expect(budgets.getByRole("note").textContent).toContain("Arrives in Phase 5.")
    expect(budgets.queryByText(/\b(3|40|60)\b|20 min/)).toBeNull()
  })
})

describe("Approval rules today", () => {
  const policy: Policy = {
    spend: {
      dailyCapUsd: 12.5,
      maxGrantRequestUsd: 33,
      maxGrantRequestsPerDay: 7,
      staleHoldMinutes: 9,
      slackDailyGrantCapUsd: 44,
      grantedTodayUsd: 5,
    },
    approvals: {
      personOnly: [
        { resource: "hq_entry", actions: ["update"] },
        { resource: "hq_proposal", actions: ["decide", "revert"] },
      ],
    },
    founders: 2,
  }

  it("shows the cap, grant limits, Slack cap, stale hold, granted today and founders from get_policy", () => {
    const rules = region(page(factoryStatusFixture(), policy), "Approval rules today")
    const fact = (label: string) => rules.getByText(label).closest("div")?.textContent ?? ""
    expect(fact("Daily Eve spend cap")).toContain("$12.50")
    expect(fact("Largest grant request")).toContain("$33.00")
    expect(fact("Grant requests per day")).toContain("7")
    expect(fact("Slack daily grant cap")).toContain("$44.00")
    expect(fact("Stale hold")).toContain("9 minutes")
    expect(fact("Granted today")).toContain("$5.00")
    expect(fact("Founders")).toContain("2")
  })

  it("says who decides, and lists the person-only actions", () => {
    const rules = region(page(factoryStatusFixture(), policy), "Approval rules today")
    expect(
      rules.getByText(
        "Only a signed-in founder decides a proposal or grants spend; keys and agents can only propose.",
      ),
    ).toBeTruthy()
    const items = rules.getAllByRole("listitem").map((li) => li.textContent)
    expect(items).toEqual(["hq_entry · update", "hq_proposal · decide, revert"])
  })

  it("reads 1 minute and 1 founder in the singular", () => {
    const one = { ...policy, spend: { ...policy.spend, staleHoldMinutes: 1 }, founders: 1 }
    const rules = region(page(factoryStatusFixture(), one), "Approval rules today")
    expect(rules.getByText("1 minute")).toBeTruthy()
    expect(rules.getByText("Founders").closest("div")?.textContent).toContain("1")
  })
})

describe("Autonomy by signal class", () => {
  const SIGNALS = [
    "Sentry error",
    "CI failure on main",
    "PostHog rage clicks",
    "PostHog funnel drop",
    "Design comment",
    "Payments and auth paths",
  ]

  it("has six rows, each with Observe, Open PR and Auto-merge, every one disabled and none pressed", () => {
    const autonomy = region(page(), "Autonomy by signal class")
    for (const name of SIGNALS) {
      const group = autonomy.getByRole("group", { name: `Level for ${name}` })
      const buttons = within(group).getAllByRole("button")
      expect(buttons.map((b) => b.textContent)).toEqual(["Observe", "Open PR", "Auto-merge"])
      expect(buttons.map((b) => b.getAttribute("data-level"))).toEqual([
        "observe",
        "open_pr",
        "auto_merge",
      ])
      for (const button of buttons) {
        expect((button as HTMLButtonElement).disabled).toBe(true)
        expect(button.hasAttribute("aria-pressed")).toBe(false)
        expect(button.className).toContain("min-h-touch")
      }
    }
    expect(autonomy.getAllByRole("button")).toHaveLength(18)
  })

  it("says today agents can only propose and carries a Phase 5 note", () => {
    const autonomy = region(page(), "Autonomy by signal class")
    expect(
      autonomy.getByText("Today agents can only propose; a founder decides every proposal."),
    ).toBeTruthy()
    expect(autonomy.getByRole("note").textContent).toBe(
      "Not configured: the autonomy level of each signal class. Arrives in Phase 5.",
    )
  })

  it("links every level group to the Not configured note by aria-describedby", () => {
    const autonomy = region(page(), "Autonomy by signal class")
    const note = autonomy.getByRole("note")
    expect(note.id).not.toBe("")
    for (const group of autonomy.getAllByRole("group")) {
      expect(group.getAttribute("aria-describedby")).toBe(note.id)
    }
  })

  it("keeps the mock's per-row notes out: they state rules hq does not enforce", () => {
    const text = region(page(), "Autonomy by signal class").getByRole("list").textContent ?? ""
    expect(text).not.toMatch(/50 or more|quarantined|10 or more|still being tuned|accept/i)
  })
})

describe("Tests and gates by blast radius", () => {
  it("names the three tiers only, with no gate text, paths or caption", () => {
    const tiers = region(page(), "Tests and gates by blast radius")
    expect(tiers.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Tier 1 · IrreversibleGate: not set",
      "Tier 2 · Core journeysGate: not set",
      "Tier 3 · Everything elseGate: not set",
    ])
    expect(tiers.getByRole("note").textContent).toContain("Arrives in Phase 5.")
    expect(tiers.queryByText(/payments\/\*\*/)).toBeNull()
  })
})

describe("Sandbox for every attempt", () => {
  it("makes no claim: not reported, and a note that names a later phase", () => {
    const sandbox = region(page(), "Sandbox for every attempt")
    expect(sandbox.getByText("Not reported")).toBeTruthy()
    expect(sandbox.getByRole("note").textContent).toBe(
      "Not configured: the per-attempt sandbox. Arrives in a later phase.",
    )
    expect(sandbox.queryByText(/worktree|secrets/i)).toBeNull()
  })
})

describe("what the page never says", () => {
  it("has no Pause all agents, Draft PR, auto-merge caption or tier gate text", () => {
    const text = page().container.textContent ?? ""
    expect(text).not.toMatch(/pause all agents/i)
    expect(text).not.toMatch(/draft pr/i)
    expect(text).not.toMatch(/auto-merge behind a flag/i)
    expect(text).not.toMatch(/always needs green CI/i)
    expect(text).not.toMatch(/human approval, always/i)
  })

  it("every control is a disabled level button: the page can send nothing", () => {
    const view = page()
    const buttons = view.getAllByRole("button")
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
    expect(view.container.querySelector("a, form, input, select, textarea")).toBeNull()
  })

  it("carries no inline style and passes the a11y check", async () => {
    const view = page()
    expect(view.container.querySelector("[style]")).toBeNull()
    await expectNoA11yViolations(view.container.innerHTML)
  })
})
