import { Button } from "@proof/ui/components/ui/button"
import type { ReactNode } from "react"

import type { FactoryStatus, Policy } from "../api/schemas"
import { NotConfigured } from "../components/not-configured"
import { PageHeader } from "../components/page-header"
import { Section } from "../components/section"

export const RUNNER_TITLE = "Runner and policy"
export const RUNNER_SUBTITLE = "what runs on your machine, and how much freedom it has"

/** The screen's header: no button (there is nothing the page may do). */
export function RunnerHeader() {
  return <PageHeader title={RUNNER_TITLE} subtitle={RUNNER_SUBTITLE} />
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Relative to hq's own clock (`status.now`), as the sidebar's runner card words it. */
function ago(from: string, now: string): string {
  const ms = Math.max(0, Date.parse(now) - Date.parse(from))
  if (ms < MINUTE) return "just now"
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`
  return `${Math.floor(ms / DAY)}d ago`
}

/** `2026-11-17 08:00 UTC`: a fixed zone, so the screen reads the same everywhere. */
function at(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`
}

const usd = (amount: number) => `$${amount.toFixed(2)}`
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`

/** The same percent as the sidebar's runner card (components/runner-card.tsx): remaining of cap plus grants. */
function capLeftPercent(allowance: FactoryStatus["allowance"]): number {
  const total = allowance.capUsd + allowance.grantedUsd
  if (total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((allowance.remainingUsd / total) * 100)))
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-card p-4">
      {children}
    </div>
  )
}

/** A label and its value on one line; the value wraps, never pushes the page wide. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-[13px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 text-right font-mono text-xs wrap-anywhere text-foreground">
        {children}
      </dd>
    </div>
  )
}

const NOT_SET = <span className="text-faint">not set</span>

const NOTIFICATION_ROWS = [
  "Tier 1 approval needed",
  "Guardrail tripped or auto-revert",
  "Factory silent",
  "Agent question with no default",
  "Everything else",
]

const BUDGET_LABELS = ["Attempts per item", "Attempts per day", "Turn limit", "Timeout"]

const SIGNAL_CLASSES = [
  "Sentry error",
  "CI failure on main",
  "PostHog rage clicks",
  "PostHog funnel drop",
  "Design comment",
  "Payments and auth paths",
]

const LEVELS = [
  { level: "observe", label: "Observe" },
  { level: "open_pr", label: "Open PR" },
  { level: "auto_merge", label: "Auto-merge" },
] as const

const TIERS = ["Tier 1 · Irreversible", "Tier 2 · Core journeys", "Tier 3 · Everything else"]

function LocalRunner({ status }: { status: FactoryStatus }) {
  return (
    <Card>
      <Section id="runner-local" title="Local runner">
        <dl className="m-0 flex flex-col gap-2.5">
          <Fact label="Runner status">Not reported</Fact>
        </dl>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {status.runners.map((runner) => (
            <li
              key={runner.runner}
              className="flex min-w-0 flex-col gap-0.5 rounded-control border border-border bg-muted p-3"
            >
              <span className="font-mono text-xs font-medium text-foreground">{runner.runner}</span>
              <span className="text-xs text-soft wrap-anywhere">
                Last run{" "}
                {runner.lastStartedAt ? (
                  <time dateTime={runner.lastStartedAt}>
                    {at(runner.lastStartedAt)} · {ago(runner.lastStartedAt, status.now)}
                  </time>
                ) : (
                  "none yet"
                )}
              </span>
              <span className="text-xs text-soft">
                Outcome {runner.lastOutcome ?? "not recorded"}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">Slots</span>
          <span className="flex min-h-touch items-center justify-center rounded-control border border-input font-mono text-[11px] text-faint">
            not reported
          </span>
        </div>
      </Section>
    </Card>
  )
}

function PlanHeadroom({ allowance }: { allowance: FactoryStatus["allowance"] }) {
  const percent = capLeftPercent(allowance)
  const total = allowance.capUsd + allowance.grantedUsd
  return (
    <Card>
      <Section id="runner-headroom" title="Plan headroom">
        <span id="runner-headroom-label" className="text-xs text-muted-foreground">
          Eve spend cap, not your Claude plan
        </span>
        <progress
          aria-labelledby="runner-headroom-label"
          value={percent}
          max={100}
          className="h-2.5 w-full appearance-none overflow-hidden rounded-[5px] bg-track [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-track [&::-webkit-progress-value]:bg-primary"
        />
        <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 font-mono text-xs">
          <span className="text-foreground">{percent}% left</span>
          <span className="text-soft">
            {usd(allowance.remainingUsd)} left of {usd(total)} on {allowance.day}
          </span>
        </div>
        <p className="m-0 text-xs leading-normal text-muted-foreground">
          hq counts the Eve spend cap; Claude plan quota has no API, so no plan figure is shown.
        </p>
      </Section>
    </Card>
  )
}

function Heartbeat() {
  return (
    <Card>
      <Section id="runner-beat" title="Heartbeat and notifications">
        <dl className="m-0 flex flex-col gap-2.5">
          <Fact label="Heartbeat">Not reported</Fact>
        </dl>
        <ul className="m-0 flex list-none flex-col p-0">
          {NOTIFICATION_ROWS.map((label) => (
            <li
              key={label}
              className="flex justify-between gap-3 border-t border-border py-2 text-[12.5px]"
            >
              <span className="text-soft">{label}</span>
              <span className="font-mono text-[11px] text-faint">not set</span>
            </li>
          ))}
        </ul>
        <NotConfigured phase="a later phase" what="runner heartbeat and phone alerts" />
      </Section>
    </Card>
  )
}

function Budgets() {
  return (
    <Card>
      <Section id="runner-budgets" title="Budgets per attempt">
        <dl className="m-0 flex flex-col gap-2.5">
          {BUDGET_LABELS.map((label) => (
            <Fact key={label} label={label}>
              {NOT_SET}
            </Fact>
          ))}
        </dl>
        <NotConfigured phase="Phase 5" what="the budgets of an attempt" />
      </Section>
    </Card>
  )
}

function ApprovalRules({ policy }: { policy: Policy }) {
  const { spend } = policy
  return (
    <Card>
      <Section
        id="runner-rules"
        title="Approval rules today"
        description="What hq enforces now. None of it can be set from here."
      >
        <dl className="m-0 flex flex-col gap-2.5">
          <Fact label="Daily Eve spend cap">{usd(spend.dailyCapUsd)}</Fact>
          <Fact label="Largest grant request">{usd(spend.maxGrantRequestUsd)}</Fact>
          <Fact label="Grant requests per day">{spend.maxGrantRequestsPerDay}</Fact>
          <Fact label="Slack daily grant cap">{usd(spend.slackDailyGrantCapUsd)}</Fact>
          <Fact label="Stale hold">{plural(spend.staleHoldMinutes, "minute")}</Fact>
          <Fact label="Granted today">{usd(spend.grantedTodayUsd)}</Fact>
          <Fact label="Founders">{policy.founders}</Fact>
        </dl>
        <p className="m-0 text-[13px] leading-normal text-soft">
          Only a signed-in founder decides a proposal or grants spend; keys and agents can only
          propose.
        </p>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">
            Actions only a signed-in person can take
          </span>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {policy.approvals.personOnly.map((rule) => (
              <li key={rule.resource} className="font-mono text-xs wrap-anywhere text-soft">
                {rule.resource} · {rule.actions.join(", ")}
              </li>
            ))}
          </ul>
        </div>
      </Section>
    </Card>
  )
}

function Autonomy() {
  return (
    <Card>
      <Section id="runner-autonomy" title="Autonomy by signal class">
        <p className="m-0 text-[13px] text-soft">
          Today agents can only propose; a founder decides every proposal.
        </p>
        <NotConfigured
          id="runner-autonomy-note"
          phase="Phase 5"
          what="the autonomy level of each signal class"
        />
        <ul className="m-0 flex list-none flex-col p-0">
          {SIGNAL_CLASSES.map((name) => (
            <li
              key={name}
              className="flex flex-col gap-2 border-t border-border py-2.5 text-[13px] sm:flex-row sm:items-center sm:gap-3"
            >
              <span className="min-w-0 font-medium text-foreground sm:flex-[0_0_46%]">{name}</span>
              <fieldset
                aria-describedby="runner-autonomy-note"
                className="m-0 flex min-w-0 flex-1 gap-1 border-0 p-0"
              >
                <legend className="sr-only">Level for {name}</legend>
                {LEVELS.map(({ level, label }) => (
                  <Button
                    key={level}
                    type="button"
                    variant="outline"
                    disabled
                    data-level={level}
                    className="min-h-touch min-w-0 flex-1 px-1.5 text-xs"
                  >
                    {label}
                  </Button>
                ))}
              </fieldset>
            </li>
          ))}
        </ul>
      </Section>
    </Card>
  )
}

function Tiers() {
  return (
    <Card>
      <Section id="runner-tiers" title="Tests and gates by blast radius">
        <NotConfigured phase="Phase 5" what="the checks and gates of each tier" />
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {TIERS.map((name) => (
            <li
              key={name}
              className="flex flex-wrap justify-between gap-x-3 gap-y-1 rounded-control border border-border bg-muted px-3.5 py-3"
            >
              <span className="text-[13px] font-semibold text-foreground">{name}</span>
              <span className="text-xs text-faint">Gate: not set</span>
            </li>
          ))}
        </ul>
      </Section>
    </Card>
  )
}

function Sandbox() {
  return (
    <Card>
      <Section id="runner-sandbox" title="Sandbox for every attempt">
        <dl className="m-0 flex flex-col gap-2.5">
          <Fact label="Sandbox">Not reported</Fact>
        </dl>
        <NotConfigured phase="a later phase" what="the per-attempt sandbox" />
      </Section>
    </Card>
  )
}

/**
 * Runner and policy, read-only. What hq knows (the three runners, the Eve cap, what it enforces)
 * is shown; everything it does not know or cannot set is a structure with a "not set" or "Not
 * reported" and a disabled control. Nothing here can be changed or sent.
 */
export function RunnerPage({ status, policy }: { status: FactoryStatus; policy: Policy }) {
  return (
    <>
      <RunnerHeader />
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-4">
          <LocalRunner status={status} />
          <PlanHeadroom allowance={status.allowance} />
          <Heartbeat />
          <Budgets />
        </div>
        <div className="flex min-w-0 flex-[2_1_520px] flex-col gap-4">
          <ApprovalRules policy={policy} />
          <Autonomy />
          <Tiers />
          <Sandbox />
        </div>
      </div>
    </>
  )
}
