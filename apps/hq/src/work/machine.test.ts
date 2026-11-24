import { AppError } from "@proof/errors"
import { describe, expect, it } from "vitest"

import {
  ATTEMPT_DISPATCH_MODE,
  ATTEMPT_LEASE_MINUTES,
  BOARD_COLUMN_CAP,
  DEPLOY_GRACE_MINUTES,
  MAX_QUESTION_OPTIONS,
  NOTE_MAX_CHARS,
  PAYLOAD_MAX_BYTES,
  RECURRENCE_REOPEN_DAYS,
  VERIFY_WINDOW_HOURS,
} from "./constants"
import {
  assertTransition,
  BOARD_COLUMNS,
  columnFor,
  CONNECTED_SIGNAL_SOURCES,
  deriveAttention,
  deriveCardState,
  displayId,
  findTransition,
  isInFlight,
  parseWorkRef,
  SIGNAL_SOURCES,
  TRANSITIONS,
  WORK_ACTORS,
  WORK_END_STATES,
  WORK_STAGES,
  WORK_STATES,
  type AttentionFacts,
  type CardFacts,
  type GuardFacts,
  type TransitionReason,
  type WorkActor,
  type WorkState,
} from "./machine"

// The pinned table of Task 1: 22 rows, written out literally (rows 9-13 one per line).
const PINNED = [
  "signal>triage:system reasons=[ingested] guard=null",
  "triage>plan:agent reasons=[investigation_started] guard=null",
  "plan>attempt:agent reasons=[fix_started] guard=contract_and_budget",
  "attempt>review:agent reasons=[pull_request_opened] guard=pr_open_or_merged",
  "review>attempt:agent reasons=[retry_started] guard=has_budget",
  "review>deploy:agent reasons=[pull_request_merged] guard=pr_merged",
  "review>stopped:agent reasons=[pull_request_closed] guard=pr_closed",
  "review>stopped:founder reasons=[stopped] guard=null",
  "triage>stopped:founder reasons=[stopped] guard=null",
  "plan>stopped:founder reasons=[stopped] guard=null",
  "attempt>stopped:founder reasons=[stopped] guard=null",
  "deploy>stopped:founder reasons=[stopped] guard=null",
  "verify>stopped:founder reasons=[stopped] guard=null",
  "deploy>verify:system reasons=[deploy_grace_elapsed] guard=grace_elapsed",
  "verify>done:system reasons=[window_passed] guard=window_passed",
  "verify>reopened:system reasons=[contract_failed,recurrence] guard=null",
  "verify>reopened:founder reasons=[reopened,revert_requested] guard=null",
  "deploy>reopened:founder reasons=[revert_requested] guard=null",
  "done>reopened:system reasons=[recurrence] guard=null",
  "done>reopened:founder reasons=[reopened,revert_requested] guard=null",
  "reopened>triage:system reasons=[retriaged] guard=null",
  "stopped>triage:founder reasons=[reopened] guard=null",
]

const facts = (over: Partial<GuardFacts> = {}): GuardFacts => ({
  contractItems: 1,
  pullRequest: "open",
  attemptsRemaining: true,
  graceElapsed: true,
  windowPassed: true,
  ...over,
})

function catchError(fn: () => unknown): AppError {
  try {
    fn()
  } catch (e) {
    if (e instanceof AppError) return e
    throw e
  }
  throw new Error("expected AppError")
}

describe("the states", () => {
  it("the states are the seven stages then done, reopened, stopped", () => {
    expect(WORK_STAGES).toEqual([
      "signal",
      "triage",
      "plan",
      "attempt",
      "review",
      "deploy",
      "verify",
    ])
    expect(WORK_END_STATES).toEqual(["done", "reopened", "stopped"])
    expect(WORK_STATES).toEqual([...WORK_STAGES, ...WORK_END_STATES])
    expect(WORK_ACTORS).toEqual(["agent", "founder", "system"])
    expect(isInFlight("verify")).toBe(true)
    expect(isInFlight("done")).toBe(false)
    expect(isInFlight("stopped")).toBe(false)
  })

  it("pins the numbers of constants.ts", () => {
    expect({
      VERIFY_WINDOW_HOURS,
      DEPLOY_GRACE_MINUTES,
      RECURRENCE_REOPEN_DAYS,
      ATTEMPT_LEASE_MINUTES,
      PAYLOAD_MAX_BYTES,
      NOTE_MAX_CHARS,
      BOARD_COLUMN_CAP,
      MAX_QUESTION_OPTIONS,
      ATTEMPT_DISPATCH_MODE,
    }).toEqual({
      VERIFY_WINDOW_HOURS: 6,
      DEPLOY_GRACE_MINUTES: 15,
      RECURRENCE_REOPEN_DAYS: 7,
      ATTEMPT_LEASE_MINUTES: 45,
      PAYLOAD_MAX_BYTES: 20_000,
      NOTE_MAX_CHARS: 2000,
      BOARD_COLUMN_CAP: 30,
      MAX_QUESTION_OPTIONS: 5,
      ATTEMPT_DISPATCH_MODE: "label",
    })
  })
})

describe("TRANSITIONS", () => {
  const line = (r: (typeof TRANSITIONS)[number]) =>
    `${r.from}>${r.to}:${r.actor} reasons=[${r.reasons.join(",")}] guard=${r.guard ?? "null"}`

  it("TRANSITIONS is exactly the pinned 22 rows with their reasons and guard names", () => {
    expect(PINNED).toHaveLength(22)
    expect(TRANSITIONS.map(line)).toEqual(PINNED)
  })

  it("each of the 10 x 10 x 3 (from, to, actor) triples is allowed exactly when the table has it", () => {
    const allowed = new Set(PINNED.map((p) => p.split(" ")[0]))
    let checked = 0
    for (const from of WORK_STATES) {
      for (const to of WORK_STATES) {
        for (const actor of WORK_ACTORS) {
          const row = findTransition(from, to, actor)
          const key = `${from}>${to}:${actor}`
          expect(row !== null, key).toBe(allowed.has(key))
          if (row) expect(line(row), key).toBe(PINNED.find((p) => p.startsWith(`${key} `)))
          checked++
        }
      }
    }
    expect(checked).toBe(300)
  })

  it("done leaves only to reopened, reopened only to triage (by the system), stopped only to triage", () => {
    const edges = (from: WorkState) => TRANSITIONS.filter((r) => r.from === from)
    expect(new Set(edges("done").map((r) => r.to))).toEqual(new Set(["reopened"]))
    expect(edges("reopened").map((r) => `${r.to}:${r.actor}`)).toEqual(["triage:system"])
    expect(edges("stopped").map((r) => `${r.to}:${r.actor}`)).toEqual(["triage:founder"])
  })

  it("no agent edge reaches done or reopened, and the only agent stop is review>stopped", () => {
    const agent = TRANSITIONS.filter((r) => r.actor === "agent")
    expect(agent.filter((r) => r.to === "done" || r.to === "reopened")).toEqual([])
    expect(agent.filter((r) => r.to === "stopped").map((r) => `${r.from}>${r.to}`)).toEqual([
      "review>stopped",
    ])
  })
})

describe("guards", () => {
  const plan = (f: GuardFacts) =>
    assertTransition({
      from: "plan",
      to: "attempt",
      actor: "agent",
      reason: "fix_started",
      facts: f,
    })

  it("plan>attempt is refused with 0 contract items, refused with no attempts remaining, allowed with 1 item and budget", () => {
    expect(catchError(() => plan(facts({ contractItems: 0 }))).code).toBe("CONFLICT")
    expect(catchError(() => plan(facts({ attemptsRemaining: false }))).code).toBe("CONFLICT")
    expect(plan(facts({ contractItems: 1, attemptsRemaining: true })).guard).toBe(
      "contract_and_budget",
    )
  })

  it("attempt>review is refused with pullRequest none or closed and allowed with open or merged", () => {
    const go = (pullRequest: GuardFacts["pullRequest"]) =>
      assertTransition({
        from: "attempt",
        to: "review",
        actor: "agent",
        reason: "pull_request_opened",
        facts: facts({ pullRequest }),
      })
    expect(catchError(() => go("none")).code).toBe("CONFLICT")
    expect(catchError(() => go("closed")).code).toBe("CONFLICT")
    expect(go("open").guard).toBe("pr_open_or_merged")
    expect(go("merged").guard).toBe("pr_open_or_merged")
  })

  it("review>deploy needs merged and review>stopped by the agent needs closed", () => {
    const deploy = (pullRequest: GuardFacts["pullRequest"]) =>
      assertTransition({
        from: "review",
        to: "deploy",
        actor: "agent",
        reason: "pull_request_merged",
        facts: facts({ pullRequest }),
      })
    for (const pr of ["none", "open", "closed"] as const) {
      expect(catchError(() => deploy(pr)).code).toBe("CONFLICT")
    }
    expect(deploy("merged").guard).toBe("pr_merged")

    const stop = (pullRequest: GuardFacts["pullRequest"]) =>
      assertTransition({
        from: "review",
        to: "stopped",
        actor: "agent",
        reason: "pull_request_closed",
        facts: facts({ pullRequest }),
      })
    for (const pr of ["none", "open", "merged"] as const) {
      expect(catchError(() => stop(pr)).code).toBe("CONFLICT")
    }
    expect(stop("closed").guard).toBe("pr_closed")
  })

  it("review>attempt needs attemptsRemaining", () => {
    const retry = (attemptsRemaining: boolean) =>
      assertTransition({
        from: "review",
        to: "attempt",
        actor: "agent",
        reason: "retry_started",
        facts: facts({ attemptsRemaining }),
      })
    expect(catchError(() => retry(false)).code).toBe("CONFLICT")
    expect(retry(true).guard).toBe("has_budget")
  })

  it("deploy>verify is refused at 14 minutes after merge and allowed at 15", () => {
    expect(DEPLOY_GRACE_MINUTES).toBe(15)
    const after = (minutes: number) =>
      assertTransition({
        from: "deploy",
        to: "verify",
        actor: "system",
        reason: "deploy_grace_elapsed",
        facts: facts({ graceElapsed: minutes >= DEPLOY_GRACE_MINUTES }),
      })
    expect(catchError(() => after(14)).code).toBe("CONFLICT")
    expect(after(15).guard).toBe("grace_elapsed")
  })

  it("verify>done is refused before the window ends and allowed after", () => {
    const done = (windowPassed: boolean) =>
      assertTransition({
        from: "verify",
        to: "done",
        actor: "system",
        reason: "window_passed",
        facts: facts({ windowPassed }),
      })
    expect(catchError(() => done(false)).code).toBe("CONFLICT")
    expect(done(true).guard).toBe("window_passed")
  })
})

describe("assertTransition", () => {
  it("throws FORBIDDEN when only another actor has the edge, CONFLICT when no actor has it, CONFLICT for a reason the row does not list, CONFLICT when the guard fails", () => {
    // stopped>triage exists for the founder only
    for (const actor of ["agent", "system"] as const) {
      const e = catchError(() =>
        assertTransition({
          from: "stopped",
          to: "triage",
          actor,
          reason: "reopened",
          facts: facts(),
        }),
      )
      expect(e.code).toBe("FORBIDDEN")
    }
    // done>stopped exists for nobody
    const none = catchError(() =>
      assertTransition({
        from: "done",
        to: "stopped",
        actor: "founder",
        reason: "stopped",
        facts: facts(),
      }),
    )
    expect(none.code).toBe("CONFLICT")
    // a reason the row does not list
    const reason = catchError(() =>
      assertTransition({
        from: "triage",
        to: "stopped",
        actor: "founder",
        reason: "recurrence",
        facts: facts(),
      }),
    )
    expect(reason.code).toBe("CONFLICT")
    // a failing guard
    const guard = catchError(() =>
      assertTransition({
        from: "verify",
        to: "done",
        actor: "system",
        reason: "window_passed",
        facts: facts({ windowPassed: false }),
      }),
    )
    expect(guard.code).toBe("CONFLICT")
    // an allowed edge returns its row
    const row = assertTransition({
      from: "verify",
      to: "reopened",
      actor: "founder",
      reason: "revert_requested",
      facts: facts(),
    })
    expect(row).toMatchObject({ from: "verify", to: "reopened", actor: "founder", guard: null })
  })

  it("refuses a founder's reason from another actor on the three shared edges", () => {
    const code = (from: WorkState, to: WorkState, actor: WorkActor, reason: TransitionReason) =>
      catchError(() =>
        assertTransition({ from, to, actor, reason, facts: facts({ pullRequest: "closed" }) }),
      ).code
    expect(code("review", "stopped", "agent", "stopped")).toBe("CONFLICT")
    expect(code("verify", "reopened", "system", "revert_requested")).toBe("CONFLICT")
    expect(code("verify", "reopened", "system", "reopened")).toBe("CONFLICT")
    expect(code("done", "reopened", "system", "revert_requested")).toBe("CONFLICT")
    expect(code("done", "reopened", "agent", "recurrence")).toBe("FORBIDDEN")
  })

  it("is FORBIDDEN, not CONFLICT, for every agent attempt at a founder-only edge", () => {
    const founderOnly = TRANSITIONS.filter(
      (r) =>
        r.actor === "founder" &&
        !TRANSITIONS.some((o) => o.from === r.from && o.to === r.to && o.actor !== "founder"),
    )
    expect(founderOnly.length).toBeGreaterThan(0)
    for (const r of founderOnly) {
      for (const actor of ["agent", "system"] as WorkActor[]) {
        const reason: TransitionReason = r.reasons[0]!
        expect(
          catchError(() =>
            assertTransition({ from: r.from, to: r.to, actor, reason, facts: facts() }),
          ).code,
          `${r.from}>${r.to}:${actor}`,
        ).toBe("FORBIDDEN")
      }
    }
  })
})

const base: AttentionFacts = {
  state: "attempt",
  pendingMergeApproval: false,
  openQuestion: false,
  attemptsUsed: 0,
  attemptLimit: 3,
  activeAttempt: "none",
  newestFixResult: null,
}
const att = (over: Partial<AttentionFacts>): AttentionFacts => ({ ...base, ...over })

describe("deriveAttention", () => {
  it("merge pending beats question beats budget beats stuck", () => {
    const all = att({
      state: "review",
      pendingMergeApproval: true,
      openQuestion: true,
      attemptsUsed: 3,
      newestFixResult: "failed",
    })
    expect(deriveAttention(all)).toBe("merge_approval")
    expect(deriveAttention({ ...all, pendingMergeApproval: false })).toBe("agent_question")
    expect(deriveAttention({ ...all, pendingMergeApproval: false, openQuestion: false })).toBe(
      "attempt_budget",
    )
    expect(
      deriveAttention(att({ activeAttempt: "stale", attemptsUsed: 1, newestFixResult: "failed" })),
    ).toBe("stuck_attempt")
    // a stale attempt never hides a question or a merge approval
    expect(deriveAttention(att({ activeAttempt: "stale", openQuestion: true }))).toBe(
      "agent_question",
    )
    expect(
      deriveAttention(att({ state: "review", activeAttempt: "stale", pendingMergeApproval: true })),
    ).toBe("merge_approval")
    // a stale attempt is an active one, so the budget does not apply while it is open
    expect(
      deriveAttention(att({ activeAttempt: "stale", attemptsUsed: 3, newestFixResult: "failed" })),
    ).toBe("stuck_attempt")
  })

  it("attempt_budget applies in triage, plan, attempt and review when the limit is set and spent", () => {
    for (const state of ["triage", "plan", "attempt", "review"] as const) {
      expect(deriveAttention(att({ state, attemptsUsed: 3 })), state).toBe("attempt_budget")
      expect(
        deriveAttention(att({ state, attemptsUsed: 4, newestFixResult: "abandoned" })),
        state,
      ).toBe("attempt_budget")
      expect(deriveAttention(att({ state, attemptsUsed: 2 })), state).toBeNull()
    }
    for (const state of ["signal", "deploy", "verify", "reopened"] as const) {
      expect(deriveAttention(att({ state, attemptsUsed: 3 })), state).toBeNull()
    }
  })

  it("limit null is never attempt_budget; a running attempt or an approved fix is not exhausted", () => {
    expect(deriveAttention(att({ attemptLimit: null, attemptsUsed: 99 }))).toBeNull()
    expect(deriveAttention(att({ attemptsUsed: 3, activeAttempt: "fresh" }))).toBeNull()
    expect(deriveAttention(att({ attemptsUsed: 3, newestFixResult: "needs_answer" }))).toBeNull()
  })

  it("an item whose last fix ended failed with no pull request is attempt_budget in attempt", () => {
    expect(
      deriveAttention(att({ state: "attempt", attemptsUsed: 3, newestFixResult: "failed" })),
    ).toBe("attempt_budget")
  })

  it("a stale active attempt is stuck_attempt, a fresh one is not", () => {
    expect(deriveAttention(att({ activeAttempt: "stale" }))).toBe("stuck_attempt")
    expect(deriveAttention(att({ activeAttempt: "fresh" }))).toBeNull()
  })

  it("done and stopped have no attention", () => {
    for (const state of ["done", "stopped"] as const) {
      expect(
        deriveAttention(
          att({
            state,
            pendingMergeApproval: true,
            openQuestion: true,
            attemptsUsed: 3,
            activeAttempt: "stale",
          }),
        ),
      ).toBeNull()
    }
  })

  it("an approved third fix in review with an approved merge has no attention", () => {
    const f = att({
      state: "review",
      attemptsUsed: 3,
      newestFixResult: "approved",
      pendingMergeApproval: false,
    })
    expect(deriveAttention(f)).toBeNull()
    expect(deriveAttention({ ...f, state: "attempt" })).toBeNull()
  })

  it("a rejected third fix in attempt is attempt_budget", () => {
    expect(
      deriveAttention(att({ state: "attempt", attemptsUsed: 3, newestFixResult: "rejected" })),
    ).toBe("attempt_budget")
  })

  it("a reopened item in cycle 2 with used 0 of 3 has no attention although cycle 1 spent 3", () => {
    // attemptsUsed and newestFixResult are the current cycle's: nothing finished yet
    expect(
      deriveAttention(att({ state: "triage", attemptsUsed: 0, newestFixResult: null })),
    ).toBeNull()
  })
})

const NOW = new Date("2026-11-17T12:00:00Z")
const card = (over: Partial<CardFacts>): CardFacts => ({
  ...base,
  attention: null,
  activeKind: null,
  windowEndsAt: null,
  now: NOW,
  ...over,
})
const minutesFromNow = (m: number) => new Date(NOW.getTime() + m * 60_000)

describe("deriveCardState", () => {
  it("shows the attention kinds, amber, before anything else", () => {
    expect(
      deriveCardState(
        card({ attention: "agent_question", activeAttempt: "fresh", activeKind: "fix" }),
      ),
    ).toEqual({
      label: "asking you",
      tone: "amber",
      detail: "waits for your answer",
    })
    expect(deriveCardState(card({ state: "review", attention: "merge_approval" }))).toEqual({
      label: "needs you",
      tone: "amber",
      detail: "merge approval",
    })
    expect(deriveCardState(card({ attention: "attempt_budget", attemptsUsed: 3 }))).toEqual({
      label: "needs you",
      tone: "amber",
      detail: "attempt 3 of 3",
    })
    expect(deriveCardState(card({ attention: "stuck_attempt", activeAttempt: "stale" }))).toEqual({
      label: "needs you",
      tone: "amber",
      detail: "attempt stopped reporting",
    })
  })

  it("running attempts", () => {
    expect(
      deriveCardState(
        card({ activeAttempt: "fresh", activeKind: "fix", attemptsUsed: 2, attemptLimit: 3 }),
      ),
    ).toEqual({ label: "running", tone: "blue", detail: "fixer · attempt 2 of 3" })
    expect(
      deriveCardState(
        card({ activeAttempt: "fresh", activeKind: "fix", attemptsUsed: 2, attemptLimit: null }),
      ),
    ).toEqual({ label: "running", tone: "blue", detail: "fixer · attempt 2" })
    expect(
      deriveCardState(card({ state: "triage", activeAttempt: "fresh", activeKind: "investigate" })),
    ).toEqual({
      label: "running",
      tone: "blue",
      detail: "investigator",
    })
  })

  it("queued, waiting, watching", () => {
    expect(deriveCardState(card({ state: "triage" }))).toEqual({
      label: "queued",
      tone: "dim",
      detail: "waits for a founder to start",
    })
    expect(deriveCardState(card({ state: "deploy" }))).toEqual({
      label: "waiting",
      tone: "dim",
      detail: "merged · deploy not observed",
    })
    expect(deriveCardState(card({ state: "verify", windowEndsAt: minutesFromNow(134) }))).toEqual({
      label: "watching",
      tone: "teal",
      detail: "verifier · 2h14m left",
    })
    expect(deriveCardState(card({ state: "verify", windowEndsAt: minutesFromNow(45) }))).toEqual({
      label: "watching",
      tone: "teal",
      detail: "verifier · 45m left",
    })
  })

  it("end states", () => {
    expect(deriveCardState(card({ state: "done" }))).toEqual({
      label: "verified",
      tone: "teal",
      detail: "no recurrence in 6 h",
    })
    expect(deriveCardState(card({ state: "reopened" }))).toEqual({
      label: "reopened",
      tone: "coral",
      detail: "back in triage",
    })
    expect(deriveCardState(card({ state: "stopped" }))).toEqual({
      label: "stopped",
      tone: "dim",
      detail: "stopped by a founder",
    })
  })

  it("never claims what it does not know: an unset or past window, an in-review item with no attempt", () => {
    expect(deriveCardState(card({ state: "verify", windowEndsAt: null })).detail).toBe(
      "verifier · window not set",
    )
    expect(
      deriveCardState(card({ state: "verify", windowEndsAt: minutesFromNow(-5) })).detail,
    ).toBe("verifier · closing")
    expect(deriveCardState(card({ state: "review" })).label).toBe("waiting")
    expect(deriveCardState(card({ state: "review", newestFixResult: "approved" })).detail).toBe(
      "in review · waits for the merge",
    )
    for (const newestFixResult of [null, "rejected", "failed"] as const) {
      expect(deriveCardState(card({ state: "review", newestFixResult })).detail).toBe(
        "in review · waits for the next attempt",
      )
    }
    expect(deriveCardState(card({ state: "signal" })).label).toBe("queued")
    expect(deriveCardState(card({ state: "plan" })).label).toBe("queued")
    expect(deriveCardState(card({ state: "attempt" })).label).toBe("queued")
  })
})

describe("columnFor", () => {
  it("has the five rows of BOARD_COLUMNS", () => {
    expect(BOARD_COLUMNS.map((c) => c.key)).toEqual([
      "triage",
      "fixing",
      "in_review",
      "verifying",
      "done_today",
    ])
    expect(BOARD_COLUMNS.map((c) => c.label)).toEqual([
      "Triage",
      "Fixing",
      "In review",
      "Verifying",
      "Done today",
    ])
    const t = new Date("2026-11-17T01:00:00Z")
    const expected: Record<string, string> = {
      signal: "triage",
      triage: "triage",
      plan: "fixing",
      attempt: "fixing",
      review: "in_review",
      deploy: "verifying",
      verify: "verifying",
      done: "done_today",
      reopened: "done_today",
      stopped: "done_today",
    }
    for (const s of WORK_STATES) expect(columnFor(s, t, t), s).toBe(expected[s])
  })

  it("puts an end state in done_today only on the same UTC day as now", () => {
    const now = new Date("2026-11-18T00:01:00Z")
    expect(columnFor("done", new Date("2026-11-17T23:59:00Z"), now)).toBeNull()
    expect(columnFor("done", new Date("2026-11-18T00:00:00Z"), now)).toBe("done_today")
    expect(columnFor("stopped", new Date("2026-11-17T23:59:00Z"), now)).toBeNull()
    expect(columnFor("verify", new Date("2026-11-01T00:00:00Z"), now)).toBe("verifying")
  })
})

describe("ids and sources", () => {
  it("displays and parses work refs", () => {
    expect(displayId(141)).toBe("FAC-141")
    expect(parseWorkRef("fac-141")).toEqual({ kind: "number", number: 141 })
    expect(parseWorkRef("FAC-7")).toEqual({ kind: "number", number: 7 })
    const id = "0b9f3c1e-5d2a-4c3b-8a61-2f7e9d4c1a05"
    expect(parseWorkRef(id)).toEqual({ kind: "id", id })
    expect(parseWorkRef(id.toUpperCase())).toEqual({ kind: "id", id })
    for (const bad of ["FAC-0", "FAC-1x", "", "FAC-", "FAC-01x", " FAC-1", "FAC--1", "x"]) {
      expect(parseWorkRef(bad), bad).toBeNull()
    }
  })

  it("SIGNAL_SOURCES holds github_issue, ci_failure, manual, sentry, posthog and CONNECTED excludes the last two", () => {
    expect(SIGNAL_SOURCES).toEqual(["github_issue", "ci_failure", "manual", "sentry", "posthog"])
    expect(CONNECTED_SIGNAL_SOURCES).toEqual(["github_issue", "ci_failure", "manual"])
    expect(CONNECTED_SIGNAL_SOURCES).not.toContain("sentry")
    expect(CONNECTED_SIGNAL_SOURCES).not.toContain("posthog")
  })
})
