import { afterEach, describe, expect, test, vi } from "vitest"
import { bashPolicy } from "#lib/github/approval.js"
import { slackConfig } from "#lib/slack/config.js"
import { allowedSlackAuth, isAllowedSlackPrincipal } from "#lib/slack/policy.js"
import { postCapRefusal } from "#lib/slack/refusal.js"
import { refusalText } from "#lib/spend/cap.js"
import { EMPTY_SPEND_STATE, type SpendState, type SpendStore } from "#lib/spend/hooks.js"
import { approvalContext, CALLERS, ghCommand, outcome } from "../helpers.js"

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("who may start a Slack turn", () => {
  test("only a person from a listed workspace", () => {
    const teams = ["T0", "T1"]
    expect(isAllowedSlackPrincipal("slack:T0:U1", teams)).toBe(true)
    expect(isAllowedSlackPrincipal("slack:T9:U1", teams)).toBe(false)
    expect(isAllowedSlackPrincipal("github:42", teams)).toBe(false)
    expect(isAllowedSlackPrincipal("slack:T0:", teams)).toBe(false)
    expect(isAllowedSlackPrincipal("slack:T0:U1:extra", teams)).toBe(false)
    expect(isAllowedSlackPrincipal("local-dev", teams)).toBe(false)
  })

  test("with no workspace listed nobody gets a turn", () => {
    vi.stubEnv("SLACK_ALLOWED_TEAM_IDS", "")
    const auth = { ...CALLERS.untrusted, principalId: "slack:T0:U1" }
    expect(allowedSlackAuth(auth)).toBeNull()
    expect(allowedSlackAuth(null)).toBeNull()
  })

  test("a listed workspace's person keeps their identity and is not stamped trusted", () => {
    vi.stubEnv("SLACK_ALLOWED_TEAM_IDS", "T0")
    const auth = { ...CALLERS.untrusted, principalId: "slack:T0:U1" }
    const allowed = allowedSlackAuth(auth)
    expect(allowed?.principalId).toBe("slack:T0:U1")
    expect(allowed?.attributes.trusted).toBeUndefined()
  })
})

describe("who may answer an approval in Slack", () => {
  const person = (principalId: string) => ({ ...CALLERS.untrusted, principalId })
  const answer = (principalId: string) =>
    slackConfig.onAnswers({ defaultAuth: person(principalId) } as never)

  test("a Slack caller's repository write and the ship gate both ask a person", () => {
    const slackCaller = person("slack:T0:UASKER")
    // Routine write (an issue) and ship (marking a pull request ready): neither runs unasked.
    for (const args of [
      ["issue", "create", "--title", "T", "--body", "B"],
      ["pr", "ready", "34"],
    ]) {
      const verdict = outcome(
        bashPolicy("orchestrator")(approvalContext(slackCaller, { command: ghCommand(args) })),
      )
      expect(verdict, args.join(" ")).toBe("user-approval")
    }
  })

  test("a founder's answer is admitted under their own identity", () => {
    vi.stubEnv("SLACK_ALLOWED_TEAM_IDS", "T0")
    vi.stubEnv("AGENT_FOUNDER_PRINCIPALS", "slack:T0:UFOUNDER")
    expect(answer("slack:T0:UFOUNDER")).toEqual({
      auth: expect.objectContaining({ principalId: "slack:T0:UFOUNDER" }),
    })
  })

  test("a non-founder in the workspace, even the person who asked, is rejected and the request stays open", () => {
    vi.stubEnv("SLACK_ALLOWED_TEAM_IDS", "T0")
    vi.stubEnv("AGENT_FOUNDER_PRINCIPALS", "slack:T0:UFOUNDER")
    expect(answer("slack:T0:UASKER")).toBeNull()
  })

  test("an outsider is rejected, a founder id from another workspace too, and with none listed nobody answers", () => {
    vi.stubEnv("SLACK_ALLOWED_TEAM_IDS", "T0")
    vi.stubEnv("AGENT_FOUNDER_PRINCIPALS", "slack:T0:UFOUNDER, slack:T9:UFOUNDER")
    expect(answer("slack:T9:UFOUNDER")).toBeNull()
    vi.stubEnv("AGENT_FOUNDER_PRINCIPALS", "")
    expect(answer("slack:T0:UFOUNDER")).toBeNull()
  })
})

const memoryStore = (state: Partial<SpendState>): SpendStore & { state: () => SpendState } => {
  let current: SpendState = { ...EMPTY_SPEND_STATE, ...state }
  return {
    get: () => current,
    update: (fn) => {
      current = fn(current)
    },
    state: () => current,
  }
}

describe("telling the thread a turn was refused", () => {
  const thread = () => {
    const posts: string[] = []
    return {
      posts,
      post: (message: { text: string }) => {
        posts.push(message.text)
        return Promise.resolve()
      },
    }
  }

  test("a refused turn gets the refusal text, naming what is left, once", async () => {
    const store = memoryStore({ refusal: { remainingUsd: 0.04, unavailable: false } })
    const t = thread()
    expect(await postCapRefusal({ data: { outcome: "cancelled" } }, t, store)).toBe(true)
    expect(t.posts).toEqual([refusalText({ remainingUsd: 0.04 })])
    expect(t.posts[0]).toContain("$0.04")
    expect(t.posts[0]).toContain("founder can raise today's allowance")
    // Posted once: the note is cleared.
    expect(await postCapRefusal({ data: { outcome: "cancelled" } }, t, store)).toBe(false)
    expect(t.posts).toHaveLength(1)
  })

  test("when the cap could not be checked the thread is told that, not a number", async () => {
    const store = memoryStore({ refusal: { remainingUsd: 0, unavailable: true } })
    const t = thread()
    await postCapRefusal({ data: { outcome: "cancelled" } }, t, store)
    expect(t.posts[0]).toContain("can't check")
    expect(t.posts[0]).not.toContain("$")
  })

  test("a turn that ran, or was cancelled for another reason, posts nothing", async () => {
    const t = thread()
    const ran = memoryStore({ refusal: { remainingUsd: 0, unavailable: false } })
    expect(await postCapRefusal({ data: { outcome: "completed" } }, t, ran)).toBe(false)
    expect(await postCapRefusal({ data: { outcome: "cancelled" } }, t, memoryStore({}))).toBe(false)
    expect(t.posts).toEqual([])
  })
})
