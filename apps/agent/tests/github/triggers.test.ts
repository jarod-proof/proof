import { afterEach, describe, expect, test, vi } from "vitest"

/**
 * Global constraint: no label or branch triggers another system. The agent's build starts from the
 * label `agent:build` and works on `agent/*` branches; box review is `factory:review` and
 * dependency updates are `deps/<group>-<year>-w<week>`. None of them may start a build.
 */
afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

const constants = async () => {
  vi.resetModules()
  return await import("#lib/constants.js")
}

describe("the dispatch hooks: no other system's label or branch starts the agent", () => {
  const ctx = {
    conversation: { issueNumber: 12, kind: "issue", pullRequestNumber: null },
    delivery: { id: "delivery-1" },
    github: { installationId: 99 },
    repository: { fullName: "acme/widgets", id: 1, name: "widgets", owner: "acme" },
    sender: { id: 1, login: "someone", type: "User" },
    thread: {},
  } as never
  const issueLabeled = (name: string) =>
    ({ action: "labeled", issueNumber: 12, raw: { labels: [{ name }] } }) as never
  const checkSuite = (headBranch: string) =>
    ({
      action: "completed",
      conclusion: "failure",
      pullRequests: [34],
      raw: { head_branch: headBranch },
    }) as never
  const opened = (raw: object) =>
    ({ action: "opened", headSha: "abc", pullRequestNumber: 34, raw }) as never

  test("the box review label or a deps label on an issue starts nothing", async () => {
    const hooks = await import("#lib/github/hooks.js")
    expect(await hooks.onIssue(ctx, issueLabeled("factory:review"))).toBeNull()
    expect(await hooks.onIssue(ctx, issueLabeled("deps/anything"))).toBeNull()
  })

  test("red CI on a deps/* branch starts no fix run, and on an agent/* branch it does", async () => {
    const hooks = await import("#lib/github/hooks.js")
    expect(await hooks.onCheckSuite(ctx, checkSuite("deps/npm-2026-w47"))).toBeNull()
    expect(await hooks.onCheckSuite(ctx, checkSuite("agent/bug-fix-login"))).not.toBeNull()
  })

  test("a pull request on a deps/* branch or labeled factory:review gets no summary run", async () => {
    const hooks = await import("#lib/github/hooks.js")
    const plain = { pull_request: { head: { ref: "feature/x" }, labels: [] } }
    expect(await hooks.onPullRequest(ctx, opened(plain))).not.toBeNull()
    expect(
      await hooks.onPullRequest(
        ctx,
        opened({ pull_request: { head: { ref: "deps/npm-2026-w47" } } }),
      ),
    ).toBeNull()
    expect(
      await hooks.onPullRequest(ctx, opened({ head: { ref: "deps/npm-2026-w47" } })),
    ).toBeNull()
    expect(
      await hooks.onPullRequest(
        ctx,
        opened({
          pull_request: { head: { ref: "feature/x" }, labels: [{ name: "factory:review" }] },
        }),
      ),
    ).toBeNull()
  })
})

describe("what starts and what the agent works on", () => {
  test("the build label is agent:build, and the factory:review label is not it", async () => {
    const { FACTORY_LABEL } = await constants()
    expect(FACTORY_LABEL).toBe("agent:build")
    expect(FACTORY_LABEL).not.toBe("factory:review")
  })

  test("the agent's branches are agent/*, which never match deps/* or the review label's branches", async () => {
    const { FACTORY_BRANCH_PREFIX } = await constants()
    expect(FACTORY_BRANCH_PREFIX).toBe("agent/")
    for (const other of ["deps/npm-2026-w47", "deps/", "factory:review", "factory/x"]) {
      expect(other.startsWith(FACTORY_BRANCH_PREFIX)).toBe(false)
    }
    expect("agent/bug-fix-login".startsWith(FACTORY_BRANCH_PREFIX)).toBe(true)
  })
})
