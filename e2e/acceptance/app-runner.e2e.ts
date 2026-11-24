import { test } from "@e2e-dev/web"
import { expect } from "e2e"

import {
  acceptanceSkip,
  assertAppIsHq,
  claimRun,
  expectPageToAgreeWithHq,
  founderClient,
  openAppAsFounder,
  readAround,
} from "./support"

const usd = (amount: number) => `$${amount.toFixed(2)}`
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
/** A label and its value read one after the other in a region's text; the value stands alone. */
const fact = (label: string, value: string) =>
  new RegExp(`${escape(label)}\\s*${escape(value)}(?!\\d)`)

interface SpendPolicy {
  dailyCapUsd: number
  maxGrantRequestUsd: number
  maxGrantRequestsPerDay: number
  staleHoldMinutes: number
  slackDailyGrantCapUsd: number
  grantedTodayUsd: number
}
interface Allowance {
  day: string
  capUsd: number
  grantedUsd: number
  remainingUsd: number
}
interface PersonOnly {
  resource: string
  actions: string[]
}
/** What hq says that the screen shows (only Phase 3's fields: an extra key is ignored). */
interface RunnerFacts {
  allowance: Allowance
  spend: SpendPolicy
  founders: number
  personOnly: PersonOnly[]
}

/** What the headroom card and the rules card do not show of what hq says. */
function runnerDifferences(headroom: string, rules: string, hq: RunnerFacts): string[] {
  const lacks: string[] = []
  const needs = (text: string, pattern: RegExp | string, what: string) => {
    if (typeof pattern === "string" ? !text.includes(pattern) : !pattern.test(text)) {
      lacks.push(what)
    }
  }
  const { day, capUsd, grantedUsd, remainingUsd } = hq.allowance
  const total = capUsd + grantedUsd
  const percent =
    total <= 0 ? 0 : Math.min(100, Math.max(0, Math.round((remainingUsd / total) * 100)))
  needs(headroom, "Eve spend cap, not your Claude plan", "the Eve cap label")
  needs(
    headroom,
    new RegExp(
      `(?<![\\d.])${escape(usd(remainingUsd))} left of ${escape(usd(total))} on ${escape(day)}(?!\\d)`,
    ),
    "remaining of total",
  )
  needs(headroom, new RegExp(`(?<!\\d)${percent}% left`), "percent left")
  const { spend } = hq
  const minutes = `${spend.staleHoldMinutes} ${spend.staleHoldMinutes === 1 ? "minute" : "minutes"}`
  needs(rules, fact("Daily Eve spend cap", usd(spend.dailyCapUsd)), "daily cap")
  needs(rules, fact("Largest grant request", usd(spend.maxGrantRequestUsd)), "largest grant")
  needs(rules, fact("Grant requests per day", String(spend.maxGrantRequestsPerDay)), "per day")
  needs(rules, fact("Slack daily grant cap", usd(spend.slackDailyGrantCapUsd)), "slack cap")
  needs(rules, fact("Stale hold", minutes), "stale hold")
  needs(rules, fact("Granted today", usd(spend.grantedTodayUsd)), "granted today")
  needs(rules, fact("Founders", String(hq.founders)), "founders")
  for (const rule of hq.personOnly) {
    const line = `${rule.resource} · ${rule.actions.join(", ")}`
    needs(rules, new RegExp(`${escape(line)}(?!, )`), `rule ${rule.resource}`)
  }
  return lacks
}

// Phase 3 acceptance on a deployed org: the Runner and policy screen of the hq app, read-only. It
// shows the Eve spend cap as hq counts it, the approval rules hq enforces today, and every
// autonomy control disabled (Phase 3 builds no way to change what an agent may do), with no
// "Pause all agents". Reads only: it spends and grants nothing, so it can run at any point of the
// suite. Phase 4 adds a `work` key to get_factory_status (null until its step has run): only
// Phase 3's fields are read here. On a live org Eve can spend between the page's fetch and the
// journey's, so the screen is compared with hq read before and after it, and a difference reloads
// the page and tries again (up to 90 seconds).
test("Runner and policy shows the Eve cap remaining from get_spend_allowance, the approval rules from get_policy, every autonomy button disabled, and no Pause all agents", {
  // The founder's session cookie is put in the browser: no trace, no video, so it is not recorded.
  // Room for the sign-in fallback of openAppAsFounder waiting out a rate limit.
  timeout: 240_000,
  skip: acceptanceSkip,
  trace: "off",
  video: "off",
}, async ({ app, browser, screen }) => {
  claimRun("app-runner")
  assertAppIsHq(app)

  await openAppAsFounder(app, browser, screen, "/runner")
  const heading = screen.getByRole("heading", "Runner and policy")
  await expect(heading).toBeVisible()
  const headroom = screen.getByRole("region", "Plan headroom")
  const rules = screen.getByRole("region", "Approval rules today")
  await expect(headroom).toBeVisible()

  const founder = await founderClient()
  const readHq = async (): Promise<RunnerFacts> => {
    const allowance = await founder.get("/v1/spend/allowance")
    expect(allowance.status).toBe(200)
    const policy = await founder.get("/v1/policy")
    expect(policy.status).toBe(200)
    return {
      allowance: {
        day: allowance.json.day as string,
        capUsd: allowance.json.capUsd as number,
        grantedUsd: allowance.json.grantedUsd as number,
        remainingUsd: allowance.json.remainingUsd as number,
      },
      spend: policy.json.spend as SpendPolicy,
      founders: policy.json.founders as number,
      personOnly: (policy.json.approvals as { personOnly: PersonOnly[] }).personOnly,
    }
  }
  await expectPageToAgreeWithHq(browser, heading, async () => {
    const { hq, seen, held } = await readAround(readHq, async () => ({
      headroom: (await headroom.textContent()) ?? "",
      rules: (await rules.textContent()) ?? "",
    }))
    if (!held) return "hq changed while the screen was read"
    if (hq.personOnly.length === 0) return "get_policy lists no person-only rule"
    const lacks = runnerDifferences(seen.headroom, seen.rules, hq)
    return lacks.length === 0
      ? ""
      : `the screen lacks ${lacks.join(", ")}: "${seen.headroom}" / "${seen.rules}" for ${JSON.stringify(hq)}`
  })

  // Nothing can be changed: every autonomy button is disabled (six signal classes, three levels
  // each: 18 in all), none is enabled, and there is no way to pause the agents.
  for (const level of ["Observe", "Open PR", "Auto-merge"]) {
    await expect(screen.getByRole("button", level, { disabled: true })).toHaveCount(6)
    await expect(screen.getByRole("button", level, { disabled: false })).toHaveCount(0)
  }
  await expect(screen.getByRole("button", /pause all agents/i)).toHaveCount(0)
  await expect(screen.getByText("Pause all agents", { exact: false })).toHaveCount(0)
})
