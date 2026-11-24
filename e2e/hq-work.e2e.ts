import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { test } from "@e2e-dev/web"
import { expect } from "e2e"

import { HQ_FOUNDER_EMAIL, HQ_FOUNDER_PASSWORD } from "./support/hq-stack"

const run = promisify(execFile)

// The work pipeline in the hq app (apps/hq/web, served at /app by the `hq` target): a founder sees
// a seeded pipeline on /app/work, opens an item, approves its merge on /app/approvals and answers
// an agent question there. The pipeline is seeded through hq's public /v1 operations with the
// founder's own session (apps/hq/scripts/seed-work.mjs, loopback only): a founder session may
// call the agent-side operations, which is how the seed records signals, attempts and pull
// requests. No model, no sleep. The other targets serve the product, so the test does nothing
// there. This file is not in `e2e:hq` (its script lives in a patch target): run it by name,
// `pnpm exec e2e run e2e/hq-work.e2e.ts --target hq`.

/** What a clean database holds in flight after this test's own seed (8 items) with room to spare. */
const MAX_IN_FLIGHT = 40

type Need = {
  kind: string
  itemId: string
  displayId: string
  title: string
  merge?: { headSha: string; number: number }
  question?: {
    questionId: string
    options: { id: string; label: string }[]
    defaultOptionId?: string
  }
}

test("a founder sees a seeded pipeline on /app/work, opens an item, approves its merge on /app/approvals and the board shows it approved", async ({
  app,
  browser,
  screen,
}) => {
  if (!app.baseUrl) throw new Error("the app has no base URL")
  const baseUrl = app.baseUrl
  const product = await fetch(new URL("/v1/whoami", baseUrl))
  if (product.status === 401) return

  // The founder's session, for the seed and for reading hq as the app does.
  const signIn = await fetch(new URL("/api/auth/sign-in/email", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ email: HQ_FOUNDER_EMAIL, password: HQ_FOUNDER_PASSWORD }),
  })
  expect(signIn.status).toBe(200)
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ")
  const read = async <T>(path: string): Promise<T> => {
    const response = await fetch(new URL(path, baseUrl), { headers: { cookie } })
    expect(response.status).toBe(200)
    return (await response.json()) as T
  }

  // A repo of this run's own: work history is never deleted, so a second run on the same database
  // seeds a fresh pipeline (the seed is idempotent per repo) and finds its own cards by repo.
  const repo = `e2e/work-${Date.now().toString(36)}`
  const dir = await mkdtemp(join(tmpdir(), "hq-work-e2e-"))
  try {
    const cookieFile = join(dir, "cookie")
    await writeFile(cookieFile, cookie, { mode: 0o600 })
    await run(process.execPath, ["apps/hq/scripts/seed-work.mjs", baseUrl, cookieFile, repo], {
      cwd: process.cwd(),
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  // What hq says waits for a founder, read before the screen is: the test names cards by it.
  const board = await read<{
    columns: { items: { id: string; repo: string; state: string }[] }[]
    stats: { inFlight: number }
    needsYou?: Need[]
  }>("/v1/work/board")
  // Every write on /app/approvals holds its card until hq has been read again, so the screen is only
  // as quick as hq's board and status reads. A database that other suites filled (the real-Postgres
  // race tests write hundreds of in-flight items to a worktree's database) makes those reads take
  // seconds and the journey time out without saying why: say why, before anything is written.
  if (board.stats.inFlight > MAX_IN_FLIGHT) {
    throw new Error(
      `the hq database holds ${board.stats.inFlight} in-flight work items, more than this test's own seed ` +
        "explains (the race tests leave theirs behind); run `pnpm wt reset-db` and try again",
    )
  }
  const own = board.columns.flatMap((column) => column.items).filter((item) => item.repo === repo)
  const mine = new Set<string>(own.map((item) => item.id))

  // The run's items are stopped at the end, so a database that runs this again stays small. Only
  // the sweep moves a reopened item on (to triage, where it can be stopped), so one sweep runs
  // first; a done or stopped item cannot be stopped. Every other reply must be a success, so a
  // leak fails loudly.
  const founderPost = (path: string) =>
    fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: { cookie, origin: baseUrl, "content-type": "application/json" },
      body: "{}",
    })
  const stopMine = async (): Promise<string[]> => {
    const problems: string[] = []
    const states = new Map<string, string>()
    for (const item of own) {
      const detail = await read<{ state: string }>(`/v1/work-items/${item.id}`)
      states.set(item.id, detail.state)
    }
    if ([...states.values()].includes("reopened")) {
      const sweep = await founderPost("/v1/work/verification-sweep")
      if (!sweep.ok) problems.push(`the sweep answered ${sweep.status}`)
    }
    for (const item of own) {
      const before = states.get(item.id)
      if (before === "done" || before === "stopped") continue
      const response = await founderPost(`/v1/work-items/${item.id}/stop`)
      if (!response.ok) problems.push(`stopping ${item.id} (${before}) answered ${response.status}`)
    }
    return problems
  }

  // The journey's own error is kept: the cleanup reads hq again (a read can throw), and an error
  // thrown from a `finally` would replace the journey's. Both are collected and rethrown, the
  // journey's first.
  let journeyError: { error: unknown } | null = null
  try {
    const needs = (board.needsYou ?? []).filter((n) => mine.has(n.itemId))
    const merge = needs.find((n) => n.kind === "merge_approval")
    const question = needs.find((n) => n.kind === "agent_question")
    if (!merge?.merge || !question?.question) {
      throw new Error("the seed left no merge approval and no agent question waiting")
    }
    const defaultOption = question.question.options.find(
      (o) => o.id === question.question?.defaultOptionId,
    )
    if (!defaultOption) throw new Error("the seeded question has no default option")

    // Earlier runs leave their items (work history is never deleted): a card is found by its title
    // and its display id, which is unique to the item.
    const cardOf = (region: ReturnType<typeof screen.getByRole>, need: Need) =>
      region
        .getByRole("article", need.title)
        .filter({ hasText: new RegExp(`^\\s*${need.displayId}(?!\\d)`) })

    // Signed out, the app asks for sign-in; then the founder lands where they were going.
    await app.open("/app/work")
    await expect(browser).toHaveURL(/\/app\/sign-in\?next=%2Fwork/)
    await screen.getByLabel("Email").fill(HQ_FOUNDER_EMAIL)
    await screen.getByLabel("Password").fill(HQ_FOUNDER_PASSWORD)
    await screen.getByRole("button", "Sign in").tap()
    await expect(screen.getByRole("heading", "Work")).toBeVisible()
    await expect(browser).toHaveURL(/\/app\/work$/)

    // The board's own Needs you holds the merge approval; its title links to the item.
    const boardNeeds = screen.getByRole("region", /^Needs you/)
    await expect(cardOf(boardNeeds, merge)).toBeVisible()
    // The item opens from its card in the In review column.
    await cardOf(screen.getByRole("region", "In review"), merge)
      .getByRole("link", merge.title)
      .tap()
    await expect(browser).toHaveURL(new RegExp(`/app/work/${merge.displayId}$`))

    // Approvals: the pipeline's cards sit in their own section; approve the merge once.
    await screen.getByRole("link", /^Approvals/).tap()
    await expect(screen.getByRole("heading", "Approvals")).toBeVisible()
    await expect(browser).toHaveURL(/\/app\/approvals$/)
    const pipeline = screen.getByRole("region", /^From the pipeline/)
    const mergeCard = cardOf(pipeline, merge)
    await expect(mergeCard).toBeVisible()
    await expect(
      mergeCard.getByText(new RegExp(`head ${merge.merge.headSha.slice(0, 7)} · ready for review`)),
    ).toBeVisible()
    await mergeCard.getByRole("button", "Approve merge").tap()
    await mergeCard.getByRole("button", "Confirm").tap()
    await expect(screen.getByText(/Nothing was merged: merge it on GitHub\./)).toBeVisible()
    await expect(cardOf(pipeline, merge)).toBeHidden()

    // hq recorded one approval for that head, and nothing moved: the item is still in review.
    const approved = await read<{
      state: string
      mergeApproval: { status: string; headSha: string }
      pullRequest: { state: string }
    }>(`/v1/work-items/${merge.itemId}`)
    expect(approved.state).toBe("review")
    expect(approved.mergeApproval).toMatchObject({
      status: "approved",
      headSha: merge.merge.headSha,
    })
    expect(approved.pullRequest.state).toBe("open")

    // The agent question is answered in the same section, with the recommended option.
    await cardOf(pipeline, question).getByRole("button", `${defaultOption.label} (default)`).tap()
    await expect(screen.getByText(`Answer sent for ${question.displayId}.`)).toBeVisible()
    await expect(cardOf(pipeline, question)).toBeHidden()
    const answered = await read<{ questions: { id: string; status: string }[] }>(
      `/v1/work-items/${question.itemId}`,
    )
    const answeredQuestion = answered.questions.find((q) => q.id === question.question?.questionId)
    expect(answeredQuestion?.status).toBe("answered")

    // The board shows the item approved: it left Needs you and still sits in In review.
    await screen.getByRole("link", "Work").tap()
    await expect(screen.getByRole("heading", "Work")).toBeVisible()
    await expect(cardOf(screen.getByRole("region", /^Needs you/), merge)).toBeHidden()
    await expect(cardOf(screen.getByRole("region", "In review"), merge)).toBeVisible()
  } catch (error) {
    journeyError = { error }
  }

  let problems: string[]
  let cleanupError: { error: unknown } | null = null
  try {
    problems = await stopMine()
  } catch (error) {
    problems = []
    cleanupError = { error }
  }
  const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
  const cleanup = [
    ...(cleanupError ? [`the cleanup threw: ${messageOf(cleanupError.error)}`] : []),
    ...(problems.length > 0 ? [`the e2e left work behind: ${problems.join("; ")}`] : []),
  ]
  if (journeyError) {
    if (cleanup.length === 0) throw journeyError.error
    throw new AggregateError(
      [journeyError.error, ...(cleanupError ? [cleanupError.error] : [])],
      `${messageOf(journeyError.error)} (and the cleanup failed too: ${cleanup.join("; ")})`,
      { cause: journeyError.error },
    )
  }
  if (cleanup.length > 0) {
    throw new Error(cleanup.join("; "), cleanupError ? { cause: cleanupError.error } : undefined)
  }
})
