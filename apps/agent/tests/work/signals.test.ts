import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { log } from "#lib/log.js"
import { recorderStats, resetRecorderStats } from "#lib/work/recorder.js"
import {
  CI_DEFAULT_BRANCH,
  ciSignal,
  type IssueFacts,
  isFactoryRepo,
  issueSignal,
  type PrFacts,
  pullRequestRecord,
  readPrFacts,
  readSuiteFacts,
  type SuiteFacts,
  suiteChecks,
} from "#lib/work/signals.js"

/**
 * The pure mappers from a GitHub webhook to what hq records. FACTORY_REPO is acme/widgets in this
 * suite (vitest.config.ts). Every case a mapper must refuse is a case the repo is public for: a
 * stranger's issue, a fork's agent/... branch, a suite on a feature branch.
 */

const SHA = "a".repeat(40)

const issueFacts = (overrides: Partial<IssueFacts> = {}): IssueFacts => ({
  repo: "acme/widgets",
  number: 12,
  title: "Checkout fails with a 500",
  body: "Steps: pay.",
  action: "opened",
  authorAssociation: "MEMBER",
  authorLogin: "maintainer",
  authorType: "User",
  updatedAt: "2026-11-24T10:00:00Z",
  labelNames: ["bug"],
  labeledByTrusted: false,
  ...overrides,
})

describe("issueSignal", () => {
  test("a trusted author's opened issue maps to the pinned signal", () => {
    expect(issueSignal(issueFacts())).toEqual({
      source: "github_issue",
      externalId: "acme/widgets#12:opened:2026-11-24T10:00:00Z",
      dedupeKey: "github-issue:acme/widgets#12",
      repo: "acme/widgets",
      title: "Checkout fails with a 500",
      summary: "GitHub issue #12 opened by maintainer",
      url: "https://github.com/acme/widgets/issues/12",
      payload: {
        number: 12,
        action: "opened",
        author: "maintainer",
        labels: ["bug"],
        body: "Steps: pay.",
      },
    })
  })

  test.each(["OWNER", "MEMBER", "COLLABORATOR"])("a %s's reopened issue is recorded", (who) => {
    expect(issueSignal(issueFacts({ action: "reopened", authorAssociation: who }))).not.toBeNull()
  })

  test.each([
    "NONE",
    "CONTRIBUTOR",
    "FIRST_TIME_CONTRIBUTOR",
    "FIRST_TIMER",
    "MANNEQUIN",
    "owner",
    "",
    null,
  ])("a stranger's opened issue (author_association %s) maps to null", (who) => {
    expect(issueSignal(issueFacts({ authorAssociation: who }))).toBeNull()
    expect(issueSignal(issueFacts({ action: "reopened", authorAssociation: who }))).toBeNull()
  })

  test("a stranger's opened issue (author_association NONE or CONTRIBUTOR) maps to null", () => {
    for (const authorAssociation of ["NONE", "CONTRIBUTOR"]) {
      expect(issueSignal(issueFacts({ authorAssociation }))).toBeNull()
    }
  })

  test("a Bot author maps to null", () => {
    expect(issueSignal(issueFacts({ authorType: "Bot" }))).toBeNull()
    expect(issueSignal(issueFacts({ authorLogin: "renovate[bot]", authorType: "User" }))).toBeNull()
  })

  test("labeled with agent:build by a trusted labeler maps to a signal and by an untrusted one to null", () => {
    const labeled = {
      action: "labeled",
      authorAssociation: "NONE",
      labelNames: ["agent:build", "bug"],
    }
    const trusted = issueSignal(issueFacts({ ...labeled, labeledByTrusted: true }))
    expect(trusted?.summary).toBe("GitHub issue #12 labeled by maintainer")
    expect(trusted?.externalId).toBe("acme/widgets#12:labeled:2026-11-24T10:00:00Z")
    expect(issueSignal(issueFacts({ ...labeled, labeledByTrusted: false }))).toBeNull()
    // Another label, even from a trusted labeler, is not the factory label.
    expect(
      issueSignal(issueFacts({ ...labeled, labelNames: ["bug"], labeledByTrusted: true })),
    ).toBeNull()
  })

  test("a trusted author does not make a labeled event a signal without a trusted labeler", () => {
    expect(
      issueSignal(
        issueFacts({ action: "labeled", labelNames: ["agent:build"], labeledByTrusted: false }),
      ),
    ).toBeNull()
  })

  test("every other action is not a signal", () => {
    for (const action of ["closed", "edited", "assigned", "unlabeled", "deleted", "transferred"]) {
      expect(issueSignal(issueFacts({ action, labeledByTrusted: true }))).toBeNull()
    }
  })

  test("the same issue opened then labeled has the same dedupeKey and different externalIds", () => {
    const opened = issueSignal(issueFacts())
    const labeled = issueSignal(
      issueFacts({ action: "labeled", labelNames: ["agent:build"], labeledByTrusted: true }),
    )
    expect(opened?.dedupeKey).toBe(labeled?.dedupeKey)
    expect(opened?.externalId).not.toBe(labeled?.externalId)
  })

  test("the same webhook delivered twice has the same externalId", () => {
    expect(issueSignal(issueFacts())?.externalId).toBe(issueSignal(issueFacts())?.externalId)
  })

  test("an issue on another repo than FACTORY_REPO maps to null", () => {
    expect(issueSignal(issueFacts({ repo: "acme/mirror" }))).toBeNull()
  })

  test("a 10 000 character body is cut to 4000 and a 500 character title to 300", () => {
    const signal = issueSignal(issueFacts({ body: "b".repeat(10_000), title: "t".repeat(500) }))
    expect(signal?.title).toHaveLength(300)
    expect(String(signal?.payload?.body)).toHaveLength(4000)
  })

  test("a cut never leaves half a surrogate pair, and a NUL byte is replaced", () => {
    // 2999 + one emoji (2 UTF-16 units) puts the 300 cut inside the pair.
    const signal = issueSignal(
      issueFacts({
        title: `${"t".repeat(299)}\u{1F600}more`,
        body: `a\u0000b${"\u{1F600}".repeat(3000)}`,
      }),
    )
    // hq's own rule (isStorable): no NUL byte and no lone surrogate.
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
    const storable = (text: string) => !text.includes("\u0000") && !lone.test(text)
    expect(signal?.title.length).toBeLessThanOrEqual(300)
    expect(storable(signal?.title ?? "")).toBe(true)
    expect(storable(String(signal?.payload?.body))).toBe(true)
    expect(String(signal?.payload?.body).startsWith("a\uFFFDb")).toBe(true)
  })

  test("a body of control characters still fits hq's 20 000 byte payload cap", () => {
    const signal = issueSignal(issueFacts({ body: "\u001f".repeat(10_000) }))
    expect(Buffer.byteLength(JSON.stringify(signal?.payload))).toBeLessThanOrEqual(20_000)
  })

  test("at most 20 labels are kept", () => {
    const labelNames = Array.from({ length: 30 }, (_, i) => `l${i}`)
    expect(issueSignal(issueFacts({ labelNames }))?.payload?.labels).toHaveLength(20)
  })

  test("a mixed-case repo Acme/Web builds lower-case dedupe keys and urls", () => {
    // The factory repo compares lower-cased, so Acme/Widgets is the factory repo.
    const signal = issueSignal(issueFacts({ repo: "Acme/Widgets" }))
    expect(signal?.dedupeKey).toBe("github-issue:acme/widgets#12")
    expect(signal?.repo).toBe("acme/widgets")
    expect(signal?.url).toBe("https://github.com/acme/widgets/issues/12")
    expect(signal?.externalId.startsWith("acme/widgets#12:")).toBe(true)
  })
})

const suiteFacts = (overrides: Partial<SuiteFacts> = {}): SuiteFacts => ({
  repo: "acme/widgets",
  action: "completed",
  conclusion: "failure",
  status: "completed",
  appSlug: "github-actions",
  headBranch: "main",
  headSha: "1234567890abcdef1234567890abcdef12345678",
  suiteId: 777,
  pullRequests: [],
  defaultBranch: CI_DEFAULT_BRANCH,
  fromFork: false,
  ...overrides,
})

describe("ciSignal", () => {
  test("a CI suite failing on main with no pull request maps to ci_failure", () => {
    expect(ciSignal(suiteFacts())).toEqual({
      source: "ci_failure",
      externalId: "acme/widgets:check_suite:777",
      dedupeKey: "ci:acme/widgets:main:github-actions",
      repo: "acme/widgets",
      title: "CI failed on main: github-actions",
      summary: "github-actions check suite failed on main at 1234567",
      url: "https://github.com/acme/widgets/commit/1234567890abcdef1234567890abcdef12345678",
    })
  })

  test("the default branch is the constant main", () => {
    expect(CI_DEFAULT_BRANCH).toBe("main")
  })

  test("a CI suite failing on main with no pull request maps to ci_failure, on a feature branch or with a pull request or when it succeeded to null", () => {
    expect(ciSignal(suiteFacts())?.source).toBe("ci_failure")
    expect(ciSignal(suiteFacts({ headBranch: "feature/x" }))).toBeNull()
    expect(ciSignal(suiteFacts({ pullRequests: [34] }))).toBeNull()
    expect(ciSignal(suiteFacts({ conclusion: "success" }))).toBeNull()
  })

  test.each<[string, Partial<SuiteFacts>]>([
    ["a feature branch", { headBranch: "feature/x" }],
    ["a factory branch", { headBranch: "agent/fix-x" }],
    ["a suite with a pull request", { pullRequests: [34] }],
    ["a success", { conclusion: "success" }],
    ["a cancelled suite", { conclusion: "cancelled" }],
    ["no conclusion yet (vercel's suite)", { conclusion: null }],
    ["a suite that was only requested", { action: "requested" }],
    ["no branch", { headBranch: null }],
    ["no app slug", { appSlug: null }],
    ["another repo", { repo: "acme/mirror" }],
  ])("%s maps to null", (_name, overrides) => {
    expect(ciSignal(suiteFacts(overrides))).toBeNull()
  })

  test("two apps failing on main are two signals: the key names the app, not an index", () => {
    const a = ciSignal(suiteFacts({ appSlug: "vercel", suiteId: 1 }))
    const b = ciSignal(suiteFacts({ appSlug: "github-actions", suiteId: 2 }))
    expect(a?.dedupeKey).toBe("ci:acme/widgets:main:vercel")
    expect(b?.dedupeKey).toBe("ci:acme/widgets:main:github-actions")
  })

  test("an app slug hq's dedupe pattern would refuse maps to null", () => {
    expect(ciSignal(suiteFacts({ appSlug: "a b" }))).toBeNull()
    expect(ciSignal(suiteFacts({ appSlug: "a:b" }))).toBeNull()
  })
})

describe("readSuiteFacts", () => {
  const ctx = { repository: { fullName: "Acme/Widgets" } } as never
  const event = (overrides: Record<string, unknown> = {}) =>
    ({
      action: "completed",
      app: { slug: "github-actions" },
      checkSuiteId: 9,
      conclusion: "failure",
      headSha: "abc1234",
      pullRequests: [],
      raw: { head_branch: "main", head_sha: SHA },
      status: "completed",
      ...overrides,
    }) as never

  test("reads the app, conclusion, branch and the repo from the context", () => {
    expect(readSuiteFacts(ctx, event())).toEqual({
      repo: "acme/widgets",
      action: "completed",
      conclusion: "failure",
      status: "completed",
      appSlug: "github-actions",
      headBranch: "main",
      headSha: "abc1234",
      suiteId: 9,
      pullRequests: [],
      defaultBranch: "main",
      fromFork: false,
    })
  })

  test("the branch is also read from raw.check_suite", () => {
    expect(
      readSuiteFacts(ctx, event({ raw: { check_suite: { head_branch: "agent/x" } } })).headBranch,
    ).toBe("agent/x")
  })

  test("a suite whose pull request comes from another repository is a fork's", () => {
    const raw = {
      head_branch: "agent/x",
      pull_requests: [
        { number: 34, head: { repo: { id: 99 } }, base: { repo: { id: 1 } } },
        { number: 35, head: { repo: { id: 1 } }, base: { repo: { id: 1 } } },
      ],
    }
    expect(readSuiteFacts(ctx, event({ pullRequests: [34], raw })).fromFork).toBe(true)
    expect(readSuiteFacts(ctx, event({ pullRequests: [35], raw })).fromFork).toBe(false)
  })

  test("a payload of the wrong shape does not throw", () => {
    expect(() => readSuiteFacts(ctx, event({ raw: null, app: null }))).not.toThrow()
  })
})

describe("suiteChecks", () => {
  test("a completed suite on a factory branch with a pull request is a checks-only update", () => {
    const facts = suiteFacts({ headBranch: "agent/fix-x", pullRequests: [34] })
    expect(suiteChecks(facts)).toEqual({
      branch: "agent/fix-x",
      number: 34,
      url: "https://github.com/acme/widgets/pull/34",
      checks: [{ name: "github-actions", state: "failed" }],
    })
    expect(suiteChecks({ ...facts, conclusion: "success" })?.checks).toEqual([
      { name: "github-actions", state: "passed" },
    ])
    for (const conclusion of ["cancelled", "timed_out", "neutral", null]) {
      expect(suiteChecks({ ...facts, conclusion })?.checks).toEqual([
        { name: "github-actions", state: "pending" },
      ])
    }
  })

  test("it sends no head sha: a late suite for an older commit must not move the head", () => {
    const record = suiteChecks(suiteFacts({ headBranch: "agent/fix-x", pullRequests: [34] }))
    expect(record).not.toHaveProperty("headSha")
    expect(record).not.toHaveProperty("state")
  })

  test.each<[string, Partial<SuiteFacts>]>([
    ["a branch a person pushed", { headBranch: "feature/x", pullRequests: [34] }],
    ["main", { headBranch: "main", pullRequests: [] }],
    ["no pull request", { headBranch: "agent/x", pullRequests: [] }],
    ["a suite not completed", { headBranch: "agent/x", pullRequests: [34], action: "requested" }],
    ["no app slug", { headBranch: "agent/x", pullRequests: [34], appSlug: null }],
    ["a fork's suite", { headBranch: "agent/x", pullRequests: [34], fromFork: true }],
    ["another repo", { headBranch: "agent/x", pullRequests: [34], repo: "acme/mirror" }],
  ])("%s maps to null", (_name, overrides) => {
    expect(suiteChecks(suiteFacts(overrides))).toBeNull()
  })
})

const prFacts = (overrides: Partial<PrFacts> = {}): PrFacts => ({
  repo: "acme/widgets",
  number: 34,
  action: "opened",
  headRef: "agent/fix-x",
  headSha: SHA,
  base: "main",
  draft: false,
  headRepo: "acme/widgets",
  merged: false,
  mergedAt: null,
  mergedBy: null,
  prState: "open",
  additions: 10,
  deletions: 2,
  changedFiles: 3,
  ...overrides,
})

describe("pullRequestRecord", () => {
  test("an opened factory PR maps to a full record: base, headSha, isDraft, state open", () => {
    expect(pullRequestRecord(prFacts())).toEqual({
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
    })
  })

  test("a draft PR maps isDraft true", () => {
    expect(pullRequestRecord(prFacts({ draft: true }))?.isDraft).toBe(true)
  })

  test("a merged PR carries mergedAt and mergedBy from merged_at and merged_by.login", () => {
    const record = pullRequestRecord(
      prFacts({
        action: "closed",
        merged: true,
        prState: "closed",
        mergedAt: "2026-11-24T11:00:00Z",
        mergedBy: "maintainer",
      }),
    )
    expect(record).toMatchObject({
      state: "merged",
      mergedAt: "2026-11-24T11:00:00Z",
      mergedBy: "maintainer",
    })
  })

  test("merged closed is merged, unmerged closed is closed, and neither sends merge fields when not merged", () => {
    const merged = pullRequestRecord(
      prFacts({
        action: "closed",
        merged: true,
        prState: "closed",
        mergedAt: "2026-11-24T11:00:00Z",
      }),
    )
    expect(merged?.state).toBe("merged")
    const closed = pullRequestRecord(
      prFacts({
        action: "closed",
        prState: "closed",
        mergedAt: "2026-11-24T11:00:00Z",
        mergedBy: "x",
      }),
    )
    expect(closed?.state).toBe("closed")
    expect(closed).not.toHaveProperty("mergedAt")
    expect(closed).not.toHaveProperty("mergedBy")
  })

  test("a later label or edit on a closed, unmerged PR still says closed, never open", () => {
    expect(pullRequestRecord(prFacts({ action: "labeled", prState: "closed" }))?.state).toBe(
      "closed",
    )
    expect(pullRequestRecord(prFacts({ action: "edited", prState: "closed" }))?.state).toBe(
      "closed",
    )
  })

  test("a later event on a merged PR still says merged, with the merge facts", () => {
    const record = pullRequestRecord(
      prFacts({
        action: "labeled",
        merged: true,
        prState: "closed",
        mergedAt: "2026-11-24T11:00:00Z",
        mergedBy: "maintainer",
      }),
    )
    expect(record?.state).toBe("merged")
    expect(record?.mergedBy).toBe("maintainer")
  })

  test("every action maps (the full record on every event heals a lost first one)", () => {
    for (const action of [
      "opened",
      "synchronize",
      "reopened",
      "edited",
      "labeled",
      "ready_for_review",
    ]) {
      expect(pullRequestRecord(prFacts({ action }))).not.toBeNull()
    }
  })

  test("a pull request url is built from repo and number even when the payload carries another url", () => {
    const record = pullRequestRecord(prFacts({ repo: "Acme/Widgets", headRepo: "acme/widgets" }))
    expect(record?.url).toBe("https://github.com/acme/widgets/pull/34")
  })

  test("a PR on a non-factory branch maps to null", () => {
    for (const headRef of ["feature/x", "my-agent/x", "deps/npm", "main"]) {
      expect(pullRequestRecord(prFacts({ headRef }))).toBeNull()
    }
  })

  test("a PR whose head.repo is another repository or absent maps to null (a fork's agent/ branch)", () => {
    expect(pullRequestRecord(prFacts({ headRepo: "stranger/widgets" }))).toBeNull()
    expect(pullRequestRecord(prFacts({ headRepo: null }))).toBeNull()
  })

  test("repos compare lower-cased: head.repo Acme/Widgets against acme/widgets is the same repo", () => {
    expect(
      pullRequestRecord(prFacts({ repo: "acme/widgets", headRepo: "acme/widgets" })),
    ).not.toBeNull()
    expect(
      pullRequestRecord(prFacts({ repo: "Acme/Widgets", headRepo: "acme/widgets" })),
    ).not.toBeNull()
  })

  test("a PR on another repo than FACTORY_REPO maps to null", () => {
    expect(pullRequestRecord(prFacts({ repo: "acme/mirror", headRepo: "acme/mirror" }))).toBeNull()
  })

  test("it sends no checks: the record never invents what GitHub did not report", () => {
    expect(pullRequestRecord(prFacts())).not.toHaveProperty("checks")
  })
})

describe("readPrFacts", () => {
  const ctx = { repository: { fullName: "Acme/Widgets" }, sender: { type: "Bot" } } as never
  /** A pull_request object as GitHub sends it (the fields the mapper reads). */
  const pr = (overrides: Record<string, unknown> = {}) => ({
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
    head: { ref: "agent/fix-x", sha: SHA, repo: { full_name: "Acme/Widgets" } },
    base: { ref: "main", repo: { full_name: "Acme/Widgets", default_branch: "main" } },
    ...overrides,
  })
  const event = (raw: object, action = "opened") =>
    ({ action, headSha: SHA, pullRequestNumber: 34, raw }) as never

  beforeEach(() => {
    resetRecorderStats()
    vi.spyOn(log, "warn").mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test("an opened factory PR built from the real webhook shape (raw.pull_request from P1's payload, sender type Bot) maps to a record with base, headSha, isDraft false, state open", () => {
    const facts = readPrFacts(ctx, event({ action: "opened", pull_request: pr() }))
    expect(facts).not.toBeNull()
    const record = pullRequestRecord(facts as PrFacts)
    expect(record).toMatchObject({
      branch: "agent/fix-x",
      number: 34,
      url: "https://github.com/acme/widgets/pull/34",
      base: "main",
      headSha: SHA,
      isDraft: false,
      state: "open",
    })
  })

  test("the flat shape (raw is the pull request) maps the same", () => {
    expect(readPrFacts(ctx, event(pr()))).toEqual(readPrFacts(ctx, event({ pull_request: pr() })))
  })

  test("a merged PR carries merged_at and merged_by.login", () => {
    const facts = readPrFacts(
      ctx,
      event(
        pr({
          state: "closed",
          merged: true,
          merged_at: "2026-11-24T11:00:00Z",
          merged_by: { login: "maintainer" },
        }),
        "closed",
      ),
    )
    expect(pullRequestRecord(facts as PrFacts)).toMatchObject({
      state: "merged",
      mergedAt: "2026-11-24T11:00:00Z",
      mergedBy: "maintainer",
    })
  })

  test("the head sha falls back to the event's headSha", () => {
    const raw = pr({ head: { ref: "agent/x", repo: { full_name: "acme/widgets" } } })
    expect(readPrFacts(ctx, event(raw))?.headSha).toBe(SHA)
  })

  test.each([
    ["base", { base: undefined }],
    ["draft", { draft: undefined }],
    ["head sha", { head: { ref: "agent/x", repo: { full_name: "acme/widgets" } } }],
  ])("a payload with no %s maps to null and logs work_record_dropped", (_name, overrides) => {
    const noEventSha = {
      action: "opened",
      headSha: null,
      pullRequestNumber: 34,
      raw: pr(overrides),
    }
    expect(readPrFacts(ctx, noEventSha as never)).toBeNull()
    expect(log.warn).toHaveBeenCalledWith(
      "work_record_dropped",
      expect.objectContaining({ kind: "unmappable" }),
    )
    expect(recorderStats().dropped).toBe(1)
  })

  test("a payload with no base maps to null and logs work_record_dropped", () => {
    const noBase = {
      action: "opened",
      headSha: null,
      pullRequestNumber: 34,
      raw: pr({ base: undefined }),
    }
    expect(readPrFacts(ctx, noBase as never)).toBeNull()
    expect(log.warn).toHaveBeenCalledWith(
      "work_record_dropped",
      expect.objectContaining({ kind: "unmappable" }),
    )
  })

  test("a head sha that is not a commit id is unmappable", () => {
    const raw = pr({
      head: { ref: "agent/x", sha: "not-a-sha", repo: { full_name: "acme/widgets" } },
    })
    expect(
      readPrFacts(ctx, { action: "opened", headSha: null, pullRequestNumber: 34, raw } as never),
    ).toBeNull()
  })

  test("a deleted fork (head.repo absent) reads as headRepo null", () => {
    const raw = pr({ head: { ref: "agent/x", sha: SHA, repo: null } })
    expect(readPrFacts(ctx, event(raw))?.headRepo).toBeNull()
  })

  test("head.repo is lower-cased", () => {
    expect(readPrFacts(ctx, event(pr()))?.headRepo).toBe("acme/widgets")
  })

  test("a payload of the wrong shape does not throw", () => {
    for (const raw of [{}, { pull_request: null }, { head: "x", base: 7 }]) {
      expect(() => readPrFacts(ctx, event(raw))).not.toThrow()
    }
  })
})

describe("isFactoryRepo", () => {
  test("is lower-cased equality with FACTORY_REPO", () => {
    expect(isFactoryRepo("acme/widgets")).toBe(true)
    expect(isFactoryRepo("ACME/Widgets")).toBe(true)
    expect(isFactoryRepo("acme/widgets2")).toBe(false)
    expect(isFactoryRepo("evil/widgets")).toBe(false)
  })
})
