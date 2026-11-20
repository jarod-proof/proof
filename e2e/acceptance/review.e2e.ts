import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { test } from "@e2e-dev/web"
import { expect } from "e2e"

import { acceptanceSkip, agentClient, claimRun, need, runTag } from "./support"

// Phase 1 acceptance on a deployed org: the box review. A fresh branch and pull request in the
// org's repo is labeled `factory:review`; the workflow on the box posts a review comment and a
// `factory/review` status, and records the run and its cost in hq. Polls GitHub (through the logged
// in `gh` CLI) for up to 15 minutes, then CLOSES the pull request and DELETES the branch, pass or
// fail. The only model call is the one the review workflow itself makes.

const run = promisify(execFile)
const POLL_MS = 15_000
const BUDGET_MS = 15 * 60_000

/** `gh api` with the given arguments; returns the parsed JSON (null for an empty reply). */
async function gh<T = unknown>(args: string[]): Promise<T> {
  const { stdout } = await run("gh", ["api", ...args], { maxBuffer: 16 * 1024 * 1024 })
  return (stdout.trim() === "" ? null : JSON.parse(stdout)) as T
}

interface WorkflowRun {
  id: number
  display_title: string
  status: string
  conclusion: string | null
  html_url: string
}

interface HqRun {
  runner: string
  costUsd: number
  link: string | null
}

/** What the last poll read saw. */
interface Seen {
  comment?: string
  status?: { state: string; description: string }
  workflow?: WorkflowRun
  hqRun?: HqRun
}

test("a PR labeled factory:review gets a review comment, a factory/review status and a box spend row", {
  timeout: 20 * 60_000,
  skip: acceptanceSkip,
}, async () => {
  claimRun("review")
  const repo = need("ACCEPTANCE_GITHUB_REPO")
  const agent = agentClient()
  const tag = runTag()
  const branch = `acceptance/${tag}`
  let pr: number | undefined
  let created = false
  const problems: string[] = []

  try {
    // A fresh branch with one new file, so every run has a head commit with no verdict yet.
    const base = (await gh<{ default_branch: string }>([`repos/${repo}`])).default_branch
    const baseSha = (await gh<{ object: { sha: string } }>([`repos/${repo}/git/ref/heads/${base}`]))
      .object.sha
    await gh([
      "-X",
      "POST",
      `repos/${repo}/git/refs`,
      "-f",
      `ref=refs/heads/${branch}`,
      "-f",
      `sha=${baseSha}`,
    ])
    created = true
    const content = Buffer.from(
      `# ${tag}\n\nA throwaway file for the acceptance run. The pull request is closed and the\nbranch deleted when the run ends.\n`,
    ).toString("base64")
    await gh([
      "-X",
      "PUT",
      `repos/${repo}/contents/.acceptance/${tag}.md`,
      "-f",
      `message=test: acceptance ${tag}`,
      "-f",
      `content=${content}`,
      "-f",
      `branch=${branch}`,
    ])
    const opened = await gh<{ number: number; head: { sha: string } }>([
      "-X",
      "POST",
      `repos/${repo}/pulls`,
      "-f",
      `title=${tag}`,
      "-f",
      `head=${branch}`,
      "-f",
      `base=${base}`,
      "-f",
      "body=Opened by the acceptance run; it closes this pull request itself.",
    ])
    pr = opened.number
    const sha = opened.head.sha

    const labeledAt = new Date(Date.now() - 60_000).toISOString()
    await gh(["-X", "POST", `repos/${repo}/issues/${pr}/labels`, "-f", "labels[]=factory:review"])

    // Poll: the comment, the status, then the run recorded in hq (its last step). Each read looks
    // at GitHub and hq afresh and keeps what it saw in `seen`; the poll is settled when all three
    // are there, or when the workflow run has ended without success (nothing more will come).
    // A throw inside a poll's read is only retried, so the failed run is reported after the poll.
    const seen: Seen = {}
    await expect
      .poll(
        async () => {
          const comments = await gh<{ user: { login: string }; body: string }[]>([
            `repos/${repo}/issues/${pr}/comments`,
          ])
          seen.comment = comments.find(
            (c) => c.user.login === "github-actions[bot]" && c.body.includes("**Factory review**"),
          )?.body
          const statuses = await gh<{ context: string; state: string; description: string }[]>([
            `repos/${repo}/commits/${sha}/statuses`,
          ])
          seen.status = statuses.find((s) => s.context === "factory/review")
          const runs = await gh<{ workflow_runs: WorkflowRun[] }>([
            "--method",
            "GET",
            `repos/${repo}/actions/workflows/factory-review.yml/runs`,
            "-f",
            "event=pull_request_target",
            "-f",
            `created=>=${labeledAt}`,
            "-f",
            "per_page=50",
          ])
          const workflow = runs.workflow_runs.find((r) => r.display_title === tag)
          seen.workflow = workflow
          if (workflow) {
            const known = await agent.get("/v1/runs?limit=100")
            seen.hqRun = (known.json.runs as HqRun[]).find((r) =>
              r.link?.endsWith(`/actions/runs/${workflow.id}`),
            )
          }
          const ended = workflow?.status === "completed" && workflow.conclusion !== "success"
          return Boolean(ended || (seen.comment && seen.status && seen.hqRun))
        },
        {
          timeout: BUDGET_MS,
          interval: POLL_MS,
          message: `no verdict, status and hq run for the review of PR #${pr} within 15 minutes`,
        },
      )
      .toBe(true)

    const { comment, status, workflow, hqRun } = seen
    if (workflow?.status === "completed" && workflow.conclusion !== "success") {
      // Say what the run was, not only that no comment came: the logs are at html_url.
      throw new Error(
        `the review workflow run ended ${workflow.conclusion}: ${workflow.html_url} ` +
          `(comment ${comment ? "posted" : "missing"}, status ${status?.state ?? "missing"})`,
      )
    }

    // The comment is a verdict, not "could not complete".
    expect(comment, "a review comment on the pull request").toBeDefined()
    expect(comment).toMatch(
      new RegExp(`\\*\\*Factory review\\*\\* of \`${sha.slice(0, 7)}\`: \\*\\*(pass|fail)\\*\\*`),
    )
    // The status is a real verdict too: an `error` state means the run could not complete.
    expect(status?.state, `factory/review status: ${status?.description ?? "missing"}`).toMatch(
      /^(success|failure)$/,
    )
    // The run is in hq as a box run with a cost, and the day's box spend holds at least that.
    expect(hqRun, "a box run recorded in hq for the workflow run").toBeDefined()
    expect(hqRun?.runner).toBe("box")
    expect(hqRun?.costUsd, "the run's spend rows add up to a cost").toBeGreaterThan(0)
    const day = new Date().toISOString().slice(0, 10)
    const summary = await agent.get(`/v1/spend/summary?day=${day}`)
    const box = (summary.json.bySource as { source: string; amountUsd: number }[]).find(
      (s) => s.source === "box",
    )
    expect(box?.amountUsd ?? 0).toBeGreaterThanOrEqual(hqRun?.costUsd ?? Number.POSITIVE_INFINITY)
  } finally {
    // Always: close the pull request and delete the branch. A failure here is written to stderr
    // (the body may have thrown already) and fails the test below when the body itself passed.
    if (pr !== undefined) {
      await gh(["-X", "PATCH", `repos/${repo}/pulls/${pr}`, "-f", "state=closed"]).catch(
        (e: Error) => problems.push(`closing PR #${pr}: ${e.message}`),
      )
    }
    if (created) {
      await gh(["-X", "DELETE", `repos/${repo}/git/refs/heads/${branch}`]).catch((e: Error) =>
        problems.push(`deleting ${branch}: ${e.message}`),
      )
    }
    for (const problem of problems) process.stderr.write(`cleanup: ${problem}\n`)
  }
  expect(problems, "the pull request is closed and the branch deleted").toEqual([])
})
