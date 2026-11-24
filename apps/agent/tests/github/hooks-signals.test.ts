import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import { onCheckSuite, onComment, onIssue, onPullRequest } from "#lib/github/hooks.js"
import { log } from "#lib/log.js"
import { recorderStats, resetRecorderStats } from "#lib/work/recorder.js"
import { createHqFixture, type HqFixture } from "../hq/hq-fixture.js"

/**
 * The three hooks record what they see in hq (signals and pull requests) after they have worked
 * out their dispatch result, and never let recording change that result or throw.
 *
 * The hooks build their own hq client from the environment (`hookHq`), so nothing is mocked: the
 * environment names an hq and the global `fetch` is the hq. `hqOn` is a recording fake on the wire
 * (the real client parses its replies, so a reply of the wrong shape fails); `useRealHq` bridges
 * the same client to the real hq of the fixture, with its real key, auth and state machine.
 */
const SHA = "a".repeat(40)

type Call = { method: "recordSignal" | "recordPullRequest"; input: unknown }
type Handler = (path: string, body: unknown) => Response | Promise<Response>

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/** What a happy hq answers on each path the hooks use. */
const happy: Handler = (path) =>
  path === "/v1/signals"
    ? json({ signalId: "s", itemId: "i", displayId: "FAC-1", outcome: "created" })
    : json({ matched: true, itemId: "i", state: "review" })

/** Points the hooks' client at a fake hq on the wire; `calls` is what it was sent, by name. */
function hqOn(handler: Handler = happy) {
  const calls: Call[] = []
  vi.stubEnv("HQ_BASE_URL", "http://hq.test")
  vi.stubEnv("HQ_AGENT_API_KEY", "the-key")
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    const path = new URL(url).pathname
    const body = JSON.parse(init.body as string)
    calls.push({
      method: path === "/v1/signals" ? "recordSignal" : "recordPullRequest",
      input: body,
    })
    return handler(path, body)
  })
  return { calls }
}

/** Points the hooks' client at the real hq: each request is replayed on the fixture's own key. */
function useRealHq(hq: HqFixture) {
  vi.stubEnv("HQ_BASE_URL", "http://hq.test")
  vi.stubEnv("HQ_AGENT_API_KEY", "not-the-fixtures-key")
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const { pathname, search } = new URL(url)
    const reply = await hq.asAgent("POST", pathname + search, JSON.parse(init.body as string))
    return json(reply.body, reply.status)
  })
}

const context = (
  options: { permission?: string; senderType?: "User" | "Bot"; repo?: string } = {},
) => {
  const requests: string[] = []
  const fullName = options.repo ?? "acme/widgets"
  const ctx = {
    conversation: { issueNumber: 12, kind: "issue", pullRequestNumber: null },
    delivery: { id: "delivery-1" },
    github: {
      installationId: 99,
      request: async ({ path }: { path: string }) => {
        requests.push(path)
        return { body: { role_name: options.permission ?? "write" }, ok: true }
      },
    },
    repository: { fullName, id: 1, name: fullName.split("/")[1], owner: fullName.split("/")[0] },
    sender: { id: 583_231, login: "maintainer", type: options.senderType ?? "User" },
    thread: {},
  } as never
  return { ctx, requests }
}

const issueEvent = (action: string, raw: Record<string, unknown> = {}, number = 12) =>
  ({
    action,
    issueNumber: number,
    raw: {
      title: "Checkout fails",
      body: "Steps: pay.",
      author_association: "MEMBER",
      user: { login: "maintainer", type: "User" },
      updated_at: "2026-11-24T10:00:00Z",
      labels: [],
      ...raw,
    },
  }) as never

const suiteEvent = (overrides: Record<string, unknown> = {}) =>
  ({
    action: "completed",
    app: { slug: "github-actions" },
    checkSuiteId: 4242,
    conclusion: "failure",
    headSha: SHA,
    pullRequests: [],
    raw: { head_branch: "main", head_sha: SHA },
    status: "completed",
    ...overrides,
  }) as never

const prObject = (overrides: Record<string, unknown> = {}) => ({
  number: 34,
  state: "open",
  draft: false,
  merged: false,
  merged_at: null,
  merged_by: null,
  additions: 10,
  deletions: 2,
  changed_files: 3,
  html_url: "https://evil.example/pull/34",
  head: { ref: "agent/fix-x", sha: SHA, repo: { full_name: "acme/widgets" } },
  base: { ref: "main", repo: { full_name: "acme/widgets", default_branch: "main" } },
  ...overrides,
})
const prEvent = (action: string, overrides: Record<string, unknown> = {}) =>
  ({ action, headSha: SHA, pullRequestNumber: 34, raw: prObject(overrides) }) as never

beforeEach(() => {
  vi.stubEnv("FACTORY_BOT_NAME", "foreman")
  vi.stubGlobal("fetch", () => {
    throw new Error("The network was used: this suite must stay offline.")
  })
  resetRecorderStats()
  vi.spyOn(log, "warn").mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("onIssue records the signal and returns what it returned before", () => {
  test("onIssue returns the same dispatch result as before and records the signal: a trusted labeler's agent:build label dispatches and records once", async () => {
    const { calls } = hqOn()
    const { ctx, requests } = context()
    const result = await onIssue(
      ctx,
      issueEvent("labeled", { labels: [{ name: "agent:build" }], author_association: "NONE" }),
    )
    expect(result).not.toBeNull()
    expect(result?.context).toHaveLength(1)
    // One permission lookup, reused: the hook asks GitHub once, not twice.
    expect(requests).toHaveLength(1)
    expect(calls.map((c) => c.method)).toEqual(["recordSignal"])
    expect(calls[0]?.input).toMatchObject({
      source: "github_issue",
      dedupeKey: "github-issue:acme/widgets#12",
      externalId: "acme/widgets#12:labeled:2026-11-24T10:00:00Z",
      title: "Checkout fails",
    })
  })

  test("an opened issue by a MEMBER records a signal, dispatches nothing and asks GitHub nothing", async () => {
    const { calls } = hqOn()
    const { ctx, requests } = context()
    expect(await onIssue(ctx, issueEvent("opened"))).toBeNull()
    expect(requests).toEqual([])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: "recordSignal",
      input: { externalId: "acme/widgets#12:opened:2026-11-24T10:00:00Z" },
    })
  })

  test.each(["NONE", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR"])(
    "a stranger's (%s) opened issue on the public repo records nothing and starts nothing",
    async (association) => {
      const { calls } = hqOn()
      expect(
        await onIssue(context().ctx, issueEvent("opened", { author_association: association })),
      ).toBeNull()
      expect(
        await onIssue(context().ctx, issueEvent("reopened", { author_association: association })),
      ).toBeNull()
      expect(calls).toEqual([])
    },
  )

  test("a stranger's agent:build label from an UNTRUSTED labeler records nothing", async () => {
    const { calls } = hqOn()
    const { ctx } = context({ permission: "read" })
    const result = await onIssue(
      ctx,
      issueEvent("labeled", { labels: [{ name: "agent:build" }], author_association: "NONE" }),
    )
    expect(result).toBeNull()
    expect(calls).toEqual([])
  })

  test("a bot sender's label records nothing and asks GitHub nothing", async () => {
    const { calls } = hqOn()
    const { ctx, requests } = context({ senderType: "Bot" })
    expect(
      await onIssue(ctx, issueEvent("labeled", { labels: [{ name: "agent:build" }] })),
    ).toBeNull()
    expect(requests).toEqual([])
    expect(calls).toEqual([])
  })

  test("a signal is never recorded for an event the hook ignores", async () => {
    const { calls } = hqOn()
    for (const action of ["closed", "edited", "assigned", "unlabeled"]) {
      expect(await onIssue(context().ctx, issueEvent(action))).toBeNull()
    }
    expect(
      await onIssue(context().ctx, issueEvent("labeled", { labels: [{ name: "bug" }] })),
    ).toBeNull()
    expect(calls).toEqual([])
  })

  test("an issue on a mirror repo the App is also installed on is never a signal", async () => {
    const { calls } = hqOn()
    expect(await onIssue(context({ repo: "acme/mirror" }).ctx, issueEvent("opened"))).toBeNull()
    expect(calls).toEqual([])
  })

  test("hq not configured: nothing is recorded and nothing is logged", async () => {
    expect(await onIssue(context().ctx, issueEvent("opened"))).toBeNull()
    expect(log.warn).not.toHaveBeenCalled()
  })

  test("a signal never labels or comments: the only calls to GitHub are the permission lookup", async () => {
    hqOn()
    const { ctx, requests } = context()
    await onIssue(ctx, issueEvent("labeled", { labels: [{ name: "agent:build" }] }))
    expect(requests.every((path) => path.includes("/permission"))).toBe(true)
  })
})

describe("onCheckSuite", () => {
  test("onCheckSuite on main returns null and records one ci_failure; on a factory branch it still returns the CI-fix dispatch and records the check", async () => {
    const main = hqOn()
    expect(await onCheckSuite(context().ctx, suiteEvent())).toBeNull()
    expect(main.calls.map((c) => c.method)).toEqual(["recordSignal"])
    const branch = hqOn()
    const result = await onCheckSuite(
      context().ctx,
      suiteEvent({ pullRequests: [34], raw: { head_branch: "agent/bug-y", head_sha: SHA } }),
    )
    expect(result?.context).toHaveLength(1)
    expect(branch.calls.map((c) => c.method)).toEqual(["recordPullRequest"])
  })

  test("a failure on main returns null and records exactly one ci_failure", async () => {
    const { calls } = hqOn()
    expect(await onCheckSuite(context().ctx, suiteEvent())).toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: "recordSignal",
      input: {
        source: "ci_failure",
        dedupeKey: "ci:acme/widgets:main:github-actions",
        externalId: "acme/widgets:check_suite:4242",
      },
    })
  })

  test("a failure on a factory branch still returns the CI-fix dispatch and records the check", async () => {
    const { calls } = hqOn()
    const result = await onCheckSuite(
      context().ctx,
      suiteEvent({ pullRequests: [34], raw: { head_branch: "agent/bug-y", head_sha: SHA } }),
    )
    expect(result?.context).toHaveLength(1)
    expect(calls.map((c) => c.method)).toEqual(["recordPullRequest"])
    expect(calls[0]?.input).toEqual({
      branch: "agent/bug-y",
      number: 34,
      url: "https://github.com/acme/widgets/pull/34",
      checks: [{ name: "github-actions", state: "failed" }],
    })
  })

  test("a passing suite on a factory branch dispatches nothing and records the passed check", async () => {
    const { calls } = hqOn()
    const result = await onCheckSuite(
      context().ctx,
      suiteEvent({
        conclusion: "success",
        pullRequests: [34],
        raw: { head_branch: "agent/bug-y", head_sha: SHA },
      }),
    )
    expect(result).toBeNull()
    expect(calls[0]?.input).toMatchObject({ checks: [{ name: "github-actions", state: "passed" }] })
  })

  test("the signal keys on the event's app and conclusion, whatever other suites the commit has", async () => {
    const { calls } = hqOn()
    await onCheckSuite(
      context().ctx,
      suiteEvent({
        app: { slug: "vercel" },
        raw: { head_branch: "main", head_sha: SHA, check_suites: [{ conclusion: null }] },
      }),
    )
    expect(calls[0]?.input).toMatchObject({ dedupeKey: "ci:acme/widgets:main:vercel" })
  })

  test.each<[string, Record<string, unknown>]>([
    ["a passing suite on main", { conclusion: "success" }],
    ["a suite with no conclusion yet", { conclusion: null }],
    ["a suite that was only requested", { action: "requested" }],
    ["a failing suite on a person's branch", { raw: { head_branch: "feature/x" } }],
    [
      "a failing suite on a closed pull request's head, no PR attached",
      { raw: { head_branch: "agent/x" } },
    ],
  ])("%s records nothing", async (_name, overrides) => {
    const { calls } = hqOn()
    await onCheckSuite(context().ctx, suiteEvent(overrides))
    expect(calls).toEqual([])
  })

  test("a suite on a fork's pull request records no check", async () => {
    const { calls } = hqOn()
    await onCheckSuite(
      context().ctx,
      suiteEvent({
        pullRequests: [34],
        raw: {
          head_branch: "agent/x",
          pull_requests: [{ number: 34, head: { repo: { id: 9 } }, base: { repo: { id: 1 } } }],
        },
      }),
    )
    expect(calls).toEqual([])
  })
})

describe("onPullRequest", () => {
  test("onPullRequest by a bot on agent/fix-x records the pull request and still returns null (in full)", async () => {
    const { calls } = hqOn()
    expect(await onPullRequest(context({ senderType: "Bot" }).ctx, prEvent("opened"))).toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      method: "recordPullRequest",
      input: {
        branch: "agent/fix-x",
        number: 34,
        url: "https://github.com/acme/widgets/pull/34",
        base: "main",
        headSha: SHA,
        isDraft: false,
        state: "open",
        additions: 10,
        deletions: 2,
        files: 3,
      },
    })
  })

  test("every action sends the full record, so a lost first record is healed by the next event", async () => {
    const { calls } = hqOn()
    for (const action of ["synchronize", "edited", "labeled", "ready_for_review", "reopened"]) {
      await onPullRequest(context({ senderType: "Bot" }).ctx, prEvent(action))
    }
    expect(calls).toHaveLength(5)
    for (const call of calls) {
      expect(call.input).toMatchObject({
        base: "main",
        headSha: SHA,
        isDraft: false,
        state: "open",
      })
    }
  })

  test("a merge sends state merged with mergedAt and mergedBy", async () => {
    const { calls } = hqOn()
    await onPullRequest(
      context({ senderType: "Bot" }).ctx,
      prEvent("closed", {
        state: "closed",
        merged: true,
        merged_at: "2026-11-24T11:00:00Z",
        merged_by: { login: "maintainer" },
      }),
    )
    expect(calls[0]?.input).toMatchObject({
      state: "merged",
      mergedAt: "2026-11-24T11:00:00Z",
      mergedBy: "maintainer",
    })
  })

  test("a close without a merge sends state closed and no merge fields", async () => {
    const { calls } = hqOn()
    await onPullRequest(context().ctx, prEvent("closed", { state: "closed" }))
    expect(calls[0]?.input).toMatchObject({ state: "closed" })
    expect(calls[0]?.input).not.toHaveProperty("mergedAt")
  })

  test("a person's factory PR is recorded and still gets its summary run", async () => {
    const { calls } = hqOn()
    const result = await onPullRequest(context().ctx, prEvent("opened"))
    expect(result).not.toBeNull()
    expect(calls).toHaveLength(1)
  })

  test("a fork's PR with an agent/... ref is not recorded as a work pull request", async () => {
    const { calls } = hqOn()
    for (const repo of [{ full_name: "stranger/widgets" }, null]) {
      const raw = { head: { ref: "agent/fix-x", sha: SHA, repo } }
      const result = await onPullRequest(context().ctx, prEvent("opened", raw))
      expect(result?.context).toHaveLength(1)
    }
    expect(calls).toEqual([])
  })

  test.each([
    ["another repository", { full_name: "stranger/widgets" }],
    ["an upper-case spelling of another repository", { full_name: "Stranger/Widgets" }],
    ["a deleted fork (no head.repo)", null],
  ])(
    "a fork's agent/... PR (head.repo %s) is not recorded and the result is unchanged",
    async (_name, repo) => {
      const { calls } = hqOn()
      const raw = { head: { ref: "agent/fix-x", sha: SHA, repo } }
      const result = await onPullRequest(context().ctx, prEvent("opened", raw))
      // The summary run for an outside contributor's pull request is dispatched exactly as before.
      expect(result?.context).toHaveLength(1)
      expect(calls).toEqual([])
    },
  )

  test("head.repo in another case is the same repository and is recorded", async () => {
    const { calls } = hqOn()
    const raw = { head: { ref: "agent/fix-x", sha: SHA, repo: { full_name: "Acme/Widgets" } } }
    await onPullRequest(context({ senderType: "Bot" }).ctx, prEvent("opened", raw))
    expect(calls).toHaveLength(1)
  })

  test.each(["feature/x", "deps/npm-2026-w47", "my-agent/x"])(
    "a PR on a non-factory branch (%s) is not recorded",
    async (ref) => {
      const { calls } = hqOn()
      const raw = { head: { ref, sha: SHA, repo: { full_name: "acme/widgets" } } }
      await onPullRequest(context().ctx, prEvent("opened", raw))
      expect(calls).toEqual([])
    },
  )

  test("a PR in another repo than FACTORY_REPO is not recorded", async () => {
    const { calls } = hqOn()
    await onPullRequest(context({ repo: "acme/mirror" }).ctx, prEvent("opened"))
    expect(calls).toEqual([])
  })

  test("a factory PR whose payload has no base is dropped as unmappable, and the result is unchanged", async () => {
    const { calls } = hqOn()
    const result = await onPullRequest(
      context({ senderType: "Bot" }).ctx,
      prEvent("opened", { base: undefined }),
    )
    expect(result).toBeNull()
    expect(calls).toEqual([])
    expect(log.warn).toHaveBeenCalledWith(
      "work_record_dropped",
      expect.objectContaining({ kind: "unmappable" }),
    )
  })

  test("the url comes from repo and number, never from the payload", async () => {
    const { calls } = hqOn()
    await onPullRequest(
      context({ senderType: "Bot" }).ctx,
      prEvent("opened", { html_url: "https://evil.example/x", url: "https://evil.example/y" }),
    )
    expect(calls[0]?.input).toMatchObject({ url: "https://github.com/acme/widgets/pull/34" })
  })

  test("a summary-run dispatch and a hq not configured: no call, no log", async () => {
    expect(await onPullRequest(context().ctx, prEvent("opened"))).not.toBeNull()
    expect(log.warn).not.toHaveBeenCalled()
  })
})

describe("hooks never throw and recording never changes a result", () => {
  const failures: [string, Handler][] = [
    ["a 409", () => json({ error: { code: "CONFLICT", message: "SECRET issue text" } }, 409)],
    ["a 400", () => json({ error: { code: "BAD_REQUEST", message: "bad" } }, 400)],
    ["a 503", () => json({ error: { code: "UNAVAILABLE", message: "down" } }, 503)],
    ["a reply of the wrong shape", () => json({ nope: true })],
    ["a body that is not JSON", () => new Response("<html>", { status: 502 })],
    ["a timeout", () => Promise.reject(new DOMException("timed out", "TimeoutError"))],
    [
      "a synchronous throw",
      () => {
        throw new Error("sync")
      },
    ],
  ]

  test.each(failures)(
    "with hq answering %s, every hook returns its result and throws nothing",
    async (_name, fail) => {
      hqOn(fail)
      const labeled = issueEvent("labeled", { labels: [{ name: "agent:build" }] })
      expect(await onIssue(context().ctx, labeled)).not.toBeNull()
      expect(await onIssue(context().ctx, issueEvent("opened"))).toBeNull()
      expect(await onCheckSuite(context().ctx, suiteEvent())).toBeNull()
      expect(
        await onCheckSuite(
          context().ctx,
          suiteEvent({ pullRequests: [34], raw: { head_branch: "agent/bug-y" } }),
        ),
      ).not.toBeNull()
      expect(await onPullRequest(context({ senderType: "Bot" }).ctx, prEvent("opened"))).toBeNull()
      expect(await onPullRequest(context().ctx, prEvent("opened"))).not.toBeNull()
      expect(recorderStats().dropped).toBe(6)
      expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain("SECRET")
    },
  )

  test("a failing or hanging hq (3 s timeout) never changes a hook's result and never throws: a hq that never answers is dropped and the hook goes on", async () => {
    vi.stubEnv("HQ_BASE_URL", "http://hq.test")
    vi.stubEnv("HQ_AGENT_API_KEY", "k")
    // The client's own AbortSignal.timeout(3000) is replaced by one that has already fired, and
    // the fetch rejects the way a real one does when its signal aborts: no waiting in the test.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const fired = new AbortController()
      fired.abort(new DOMException("The operation timed out", "TimeoutError"))
      return fired.signal
    })
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) =>
      init.signal?.aborted
        ? Promise.reject(init.signal.reason)
        : new Promise<Response>(() => undefined),
    )
    expect(await onIssue(context().ctx, issueEvent("opened"))).toBeNull()
    expect(await onPullRequest(context().ctx, prEvent("opened"))).not.toBeNull()
    expect(timeout).toHaveBeenCalledWith(3000)
    expect(recorderStats()).toMatchObject({ dropped: 2, unavailable: 2 })
  })

  test("odd payloads (labels a string, user null, head null) never throw out of a hook", async () => {
    const { calls } = hqOn()
    await expect(
      onIssue(context().ctx, issueEvent("opened", { user: null, labels: "agent:build" })),
    ).resolves.toBeNull()
    await expect(
      onPullRequest(
        context({ senderType: "Bot" }).ctx,
        prEvent("opened", { head: null, base: "x" }),
      ),
    ).resolves.toBeNull()
    await expect(
      onCheckSuite(context().ctx, suiteEvent({ raw: { head_branch: 7 }, app: null })),
    ).resolves.toBeNull()
    // Only the issue with a trusted association (a deleted author is "unknown") was recorded.
    expect(calls.map((c) => c.method)).toEqual(["recordSignal"])
  })

  test("onComment is untouched: it never records", async () => {
    const { calls } = hqOn()
    const comment = {
      author: { id: 1, login: "maintainer", type: "User" },
      body: "@foreman fix this",
      raw: { author_association: "MEMBER" },
    } as never
    expect(await onComment(context().ctx, comment)).not.toBeNull()
    expect(calls).toEqual([])
  })
})

describe("against the real hq of the fixture", () => {
  let hq: HqFixture
  beforeAll(async () => {
    hq = await createHqFixture()
  }, 60_000)
  afterAll(async () => {
    await hq.close()
  })

  test("a trusted member's issue becomes a work item, once, even when the webhook is redelivered", async () => {
    useRealHq(hq)
    const event = issueEvent("opened", { title: "Real issue" }, 301)
    await onIssue(context().ctx, event)
    await onIssue(context().ctx, event)
    const items = await hq.client.listWorkItems({ dedupeKey: "github-issue:acme/widgets#301" })
    expect(items.items).toHaveLength(1)
    expect(items.items[0]).toMatchObject({
      title: "Real issue",
      state: "triage",
      source: "github_issue",
    })
    expect(recorderStats().dropped).toBe(0)
  })

  test("a stranger's issue makes no item", async () => {
    useRealHq(hq)
    await onIssue(context().ctx, issueEvent("opened", { author_association: "NONE" }, 302))
    expect(
      (await hq.client.listWorkItems({ dedupeKey: "github-issue:acme/widgets#302" })).items,
    ).toEqual([])
  })

  test("onPullRequest records the first PR record with base, headSha, isDraft and state: not BAD_REQUEST against the real hq, it finds the item by branch and moves it to review", async () => {
    useRealHq(hq)
    const { itemId } = await hq.client.recordSignal({
      source: "github_issue",
      externalId: "acme/widgets#303:opened:t",
      dedupeKey: "github-issue:acme/widgets#303",
      repo: "acme/widgets",
      title: "Needs a fix",
      summary: "GitHub issue #303 opened by maintainer",
    })
    const investigation = await hq.client.startAttempt({ itemId, kind: "investigate" })
    await hq.client.finishAttempt({ attemptId: investigation.id, result: "investigated" })
    await hq.client.setContract({
      itemId,
      items: [{ text: "Works", verifier: { kind: "reviewer" } }],
    })
    const fix = await hq.client.startAttempt({ itemId, kind: "fix", attemptLimit: 3 })
    await hq.client.heartbeatAttempt({ attemptId: fix.id, branch: "agent/fix-x" })

    await onPullRequest(context({ senderType: "Bot" }).ctx, prEvent("opened"))
    expect(recorderStats()).toEqual({ dropped: 0, conflicts: 0, rejected: 0, unavailable: 0 })
    const detail = await hq.client.getWorkItem({ itemId })
    expect(detail.state).toBe("review")
    expect(detail.pullRequest).toMatchObject({
      number: 34,
      url: "https://github.com/acme/widgets/pull/34",
      branch: "agent/fix-x",
      base: "main",
      headSha: SHA,
      isDraft: false,
      state: "open",
      additions: 10,
      deletions: 2,
      files: 3,
    })

    // A passing suite lands on the same row without touching the head.
    await onCheckSuite(
      context().ctx,
      suiteEvent({
        conclusion: "success",
        pullRequests: [34],
        raw: { head_branch: "agent/fix-x", head_sha: "c".repeat(40) },
      }),
    )
    const checked = await hq.client.getWorkItem({ itemId })
    expect(checked.pullRequest).toMatchObject({
      headSha: SHA,
      checks: [{ name: "github-actions", state: "passed" }],
    })

    // A fork's agent/fix-x PR with the same number and branch changes nothing.
    const forkRaw = {
      head: { ref: "agent/fix-x", sha: "d".repeat(40), repo: { full_name: "evil/widgets" } },
    }
    await onPullRequest(context().ctx, prEvent("synchronize", forkRaw))
    expect((await hq.client.getWorkItem({ itemId })).pullRequest?.headSha).toBe(SHA)

    // The merge: state, who and when from the webhook.
    await onPullRequest(
      context({ senderType: "Bot" }).ctx,
      prEvent("closed", {
        state: "closed",
        merged: true,
        merged_at: "2030-12-31T10:00:00Z",
        merged_by: { login: "maintainer" },
      }),
    )
    const merged = await hq.client.getWorkItem({ itemId })
    expect(merged.state).toBe("deploy")
    expect(merged.pullRequest).toMatchObject({ state: "merged", mergedBy: "maintainer" })
    expect(recorderStats().dropped).toBe(0)
  })

  test("a CI failure on main becomes one ci_failure item, a second failure of the same app attaches", async () => {
    useRealHq(hq)
    await onCheckSuite(context().ctx, suiteEvent({ checkSuiteId: 1 }))
    await onCheckSuite(context().ctx, suiteEvent({ checkSuiteId: 2 }))
    const items = await hq.client.listWorkItems({
      dedupeKey: "ci:acme/widgets:main:github-actions",
    })
    expect(items.items).toHaveLength(1)
    expect(items.items[0]?.source).toBe("ci_failure")
    const detail = await hq.client.getWorkItem({ itemId: items.items[0]?.id ?? "" })
    expect(detail.signal?.occurrences).toBe(2)
  })
})
