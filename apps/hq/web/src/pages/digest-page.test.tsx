// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { describe, expect, it, vi } from "vitest"

import { type Digest, digestSchema } from "../api/schemas"
import {
  digestFixture,
  digestPipelineFixture,
  emptyDigestPipeline,
  factoryStatusFixture,
} from "../test/fixtures"
import { renderInRouter } from "../test/render"
import { DigestPage } from "./digest-page"

const allowance = factoryStatusFixture().allowance

async function show(
  digest: Digest = digestFixture(),
  props: { readMarked?: boolean; onMarkRead?: () => void; cap?: typeof allowance | null } = {},
) {
  return renderInRouter(
    <DigestPage
      digest={digest}
      allowance={props.cap === undefined ? allowance : props.cap}
      readMarked={props.readMarked ?? false}
      onMarkRead={props.onMarkRead ?? (() => {})}
    />,
  )
}

const pending = (n: number): Digest["decisions"] =>
  Array.from({ length: n }, (_, i) => ({
    proposalId: `proposal-${i + 1}`,
    entryKind: "fact" as const,
    title: `Proposal title ${i + 1}`,
    reason: `Reason ${i + 1}`,
    createdAt: "2026-11-17T09:00:00.000Z",
  }))

describe("DigestPage", () => {
  it("renders the quiet banner with counts from get_digest", async () => {
    const view = await show(
      digestFixture({
        summary: { tone: "quiet", runsFinished: 3, runsFailed: 0, pendingProposals: 2 },
      }),
    )
    const banner = view.getByRole("status", { name: "Digest summary" })
    expect(banner.textContent).toBe(
      "Quiet since Nov 16, 00:00 UTC. 3 runs finished, 0 failed, 2 need a decision.",
    )
    expect(banner.className).toContain("bg-ok-surface")
    expect(banner.className).toContain("border-ok-border")
    expect(view.getByRole("heading", { name: "Digest" })).toBeTruthy()
    expect(view.getByText("since Nov 16, 00:00 UTC · 36 h")).toBeTruthy()
  })

  it("an attention banner when a run failed or is stuck", async () => {
    const failed = await show(
      digestFixture({
        summary: { tone: "attention", runsFinished: 4, runsFailed: 1, pendingProposals: 1 },
      }),
    )
    const banner = failed.getByRole("status", { name: "Digest summary" })
    expect(banner.textContent).toContain("4 runs finished, 1 failed, 1 needs a decision")
    expect(banner.textContent).not.toMatch(/^Quiet/)
    expect(banner.className).toContain("bg-attention-surface")
    expect(banner.className).toContain("border-attention-border")
    failed.unmount()

    const stuck = await show(
      digestFixture({
        summary: { tone: "attention", runsFinished: 0, runsFailed: 0, pendingProposals: 0 },
        health: { stuckRuns: 2, lastRunStartedAt: null },
      }),
    )
    expect(stuck.getByRole("status", { name: "Digest summary" }).textContent).toContain("2 stuck")
  })

  it("product health shows the three mock labels, each Not connected, and no number", async () => {
    const view = await show()
    const section = view.getByRole("region", { name: "Product health" })
    for (const label of ["Errors per hour", "Checkout completion", "People struggling"]) {
      expect(section.textContent).toContain(label)
    }
    expect(section.textContent?.match(/Not connected/g)).toHaveLength(3)
    expect(section.textContent).toContain("Sentry")
    expect(section.textContent).toContain("PostHog")
    expect(section.textContent).not.toMatch(/\d/)
  })

  it("production changes is Not connected", async () => {
    const view = await show()
    const section = view.getByRole("region", { name: "What changed in production" })
    expect(section.textContent).toContain("Not connected")
    expect(section.textContent).not.toMatch(/\d/)
  })

  it("Needs a decision shows up to 5 with Decide linking to /app/approvals and 'See all 9 in Approvals'", async () => {
    const view = await show(
      digestFixture({
        summary: { tone: "quiet", runsFinished: 0, runsFailed: 0, pendingProposals: 9 },
        decisions: pending(5),
      }),
    )
    const section = view.getByRole("region", { name: /Needs a decision/ })
    expect(section.textContent).toContain("proposal-1 · proposal · fact")
    expect(section.textContent).toContain("Proposal title 3")
    expect(section.textContent).toContain("Why: Reason 5")
    const decide = view.getAllByRole("link", { name: /^Decide/ })
    expect(decide).toHaveLength(5)
    expect(decide[0]?.getAttribute("href")).toBe("/app/approvals")
    expect(view.getByRole("link", { name: "See all 9 in Approvals" }).getAttribute("href")).toBe(
      "/app/approvals",
    )
  })

  it("Needs a decision says so when nothing is pending", async () => {
    const view = await show(
      digestFixture({
        summary: { tone: "quiet", runsFinished: 0, runsFailed: 0, pendingProposals: 0 },
        decisions: [],
      }),
    )
    expect(view.getByText("Nothing needs a decision")).toBeTruthy()
    expect(view.queryByRole("link", { name: /See all/ })).toBeNull()
  })

  it("What the factory did lists events newest first with the outcome text", async () => {
    const view = await show(
      digestFixture({
        events: [
          {
            at: "2026-11-17T08:30:00.000Z",
            kind: "run",
            ref: "run-1",
            text: "Older run",
            result: "succeeded",
            costUsd: 0.4,
          },
          {
            at: "2026-11-17T10:15:00.000Z",
            kind: "run",
            ref: "run-2",
            text: "Newer run",
            result: "failed",
            costUsd: 1.25,
          },
          {
            at: "2026-11-17T11:00:00.000Z",
            kind: "proposal",
            ref: "proposal-1",
            text: "Pricing",
            result: "proposed",
            costUsd: null,
          },
        ],
      }),
    )
    const section = view.getByRole("region", { name: "What the factory did" })
    const items = section.querySelectorAll("li")
    expect(items).toHaveLength(3)
    expect(items[0]?.textContent).toContain("Pricing")
    expect(items[0]?.textContent).toContain("proposed")
    expect(items[1]?.textContent).toContain("Newer run")
    expect(items[1]?.textContent).toContain("failed")
    expect(items[1]?.textContent).toContain("$1.25")
    expect(items[1]?.textContent).toContain("Nov 17, 10:15 UTC")
    expect(items[2]?.textContent).toContain("Older run")
    expect(items[2]?.textContent).toContain("$0.40")
    // A proposal has no cost to show.
    expect(items[0]?.textContent).not.toContain("$")
  })

  it("an open run's cost reads as spend recorded so far, never as a final cost", async () => {
    const view = await show(
      digestFixture({
        events: [
          {
            at: "2026-11-17T08:30:00.000Z",
            kind: "run",
            ref: "run-1",
            text: "Review on the box",
            result: "started",
            costUsd: 0,
          },
        ],
      }),
    )
    const item = view.getByRole("region", { name: "What the factory did" }).querySelector("li")
    expect(item?.textContent).toContain("started")
    expect(item?.textContent).toContain("spend recorded so far $0.00")
    expect(item?.textContent).not.toMatch(/online|busy|stuck|running/i)
  })

  it("renders a run's text as text, never as markup", async () => {
    const view = await show(
      digestFixture({
        events: [
          {
            at: "2026-11-17T08:30:00.000Z",
            kind: "run",
            ref: "run-1",
            text: '<img src=x onerror="alert(1)"> **bold**',
            result: "succeeded",
            costUsd: 0.1,
          },
        ],
      }),
    )
    expect(view.container.querySelector("img")).toBeNull()
    expect(view.getByText('<img src=x onerror="alert(1)"> **bold**')).toBeTruthy()
  })

  it("Factory health shows Not reported for runner and heartbeat, the stuck count, and the window spend with its estimated part", async () => {
    const view = await show(
      digestFixture({
        health: { stuckRuns: 1, lastRunStartedAt: "2026-11-17T08:00:00.000Z" },
        spend: {
          totalUsd: 5.5,
          estimatedUsd: 0.5,
          bySource: [
            { source: "eve", amountUsd: 3.8 },
            { source: "build", amountUsd: 1.7 },
          ],
        },
      }),
    )
    const section = view.getByRole("region", { name: "Factory health" })
    const fact = (name: string) =>
      Array.from(section.querySelectorAll("dt")).find((dt) => dt.textContent === name)
        ?.nextElementSibling?.textContent
    expect(fact("Runner")).toBe("Not reported")
    expect(fact("Last heartbeat")).toBe("Not reported")
    expect(fact("Stuck runs")).toContain("1")
    expect(fact("Eve spend cap")).toBe("62% left")
    expect(fact("Last run started")).toBe("Nov 17, 08:00 UTC")
    expect(fact("Spend in this window")).toBe(
      "$5.50 (eve $3.80, build $1.70), $0.50 of it estimated",
    )
    expect(section.textContent?.toLowerCase()).not.toContain("online")
  })

  it("Factory health leaves out 'of it estimated' when nothing is estimated and says no runs yet", async () => {
    const view = await show(
      digestFixture({
        health: { stuckRuns: 0, lastRunStartedAt: null },
        spend: { totalUsd: 0, estimatedUsd: 0, bySource: [] },
      }),
    )
    const section = view.getByRole("region", { name: "Factory health" })
    expect(section.textContent).toContain("$0.00")
    expect(section.textContent).not.toContain("estimated")
    expect(section.textContent).toContain("No runs yet")
  })

  it("the Eve spend cap line says unavailable when the allowance is not there", async () => {
    const view = await show(digestFixture(), { cap: null })
    expect(view.getByRole("region", { name: "Factory health" }).textContent).toContain(
      "Unavailable",
    )
  })

  it("an empty window shows 'Nothing ran in this window'", async () => {
    const view = await show(digestFixture({ events: [] }))
    expect(view.getByText("Nothing ran in this window")).toBeTruthy()
  })

  it("Mark as read calls back once, and reads as done when marked", async () => {
    const onMarkRead = vi.fn()
    const view = await show(digestFixture(), { onMarkRead })
    const button = view.getByRole("button", { name: "Mark as read" })
    button.click()
    expect(onMarkRead).toHaveBeenCalledTimes(1)
    view.unmount()

    const done = await show(digestFixture(), { readMarked: true })
    const marked = done.getByRole("button", { name: "Marked as read" }) as HTMLButtonElement
    expect(marked.disabled).toBe(true)
  })

  it("every link and button is at least 44 px (class min-h-touch)", async () => {
    const view = await show(
      digestFixture({
        summary: { tone: "quiet", runsFinished: 0, runsFailed: 0, pendingProposals: 2 },
        decisions: pending(2),
      }),
    )
    const controls = Array.from(view.container.querySelectorAll("a, button"))
    // Mark as read, two Decide links, See all.
    expect(controls).toHaveLength(4)
    for (const control of controls) {
      expect(control.className, control.textContent ?? "").toContain("min-h-touch")
    }
  })

  it("renders a proposal's title and reason as text, never as markup", async () => {
    const hostile = {
      proposalId: "proposal-x",
      entryKind: "fact" as const,
      title: '<img src=x onerror="alert(1)"> [click](https://evil.example)',
      reason: "<script>alert(1)</script> **not bold** [link](https://evil.example)",
      createdAt: "2026-11-17T09:00:00.000Z",
    }
    const view = await show(
      digestFixture({
        summary: { tone: "quiet", runsFinished: 0, runsFailed: 0, pendingProposals: 1 },
        decisions: [hostile],
      }),
    )
    expect(view.container.querySelector("img, script")).toBeNull()
    expect(view.container.querySelector("a[href^='https://evil']")).toBeNull()
    expect(view.getByText(hostile.title)).toBeTruthy()
    expect(view.getByText(`Why: ${hostile.reason}`)).toBeTruthy()
  })

  it("has no inline style", async () => {
    const view = await show(
      digestFixture({ decisions: pending(2), summary: digestFixture().summary }),
    )
    expect(view.container.querySelectorAll("[style]")).toHaveLength(0)
  })

  it("has no accessibility violations", async () => {
    const view = await show(digestFixture({ decisions: pending(2) }))
    await expectNoA11yViolations(view.container.innerHTML)
  })
})

// The pipeline's parts (Task 19): the mock's sections, fed by get_digest's `pipeline`.
describe("DigestPage with the pipeline", () => {
  const needs = (
    kind: "merge_approval" | "agent_question" | "attempt_budget" | "stuck_attempt",
    n: number,
    over: Partial<NonNullable<Digest["pipeline"]>["needsYou"][number]> = {},
  ) => ({
    kind,
    itemId: `00000000-0000-4000-8000-00000000000${n}`,
    displayId: `FAC-${n}`,
    title: `Item ${n}`,
    reason: `Reason ${n}`,
    since: "2026-11-17T09:00:00.000Z",
    ...over,
  })
  const withPipeline = (pipeline: Partial<NonNullable<Digest["pipeline"]>>, over = {}) =>
    digestFixture({
      pipeline: { ...emptyDigestPipeline(), ...pipeline },
      ...over,
    })

  it("a null pipeline renders the Digest exactly as Phase 3 did", async () => {
    const view = await show(digestFixture({ pipeline: null }))
    expect(view.queryByText("Stuck attempts")).toBeNull()
    expect(view.queryByText(/Merged by the factory/)).toBeNull()
    expect(view.getByRole("status", { name: "Digest summary" }).textContent).toBe(
      "Quiet since Nov 16, 00:00 UTC. 1 run finished, 0 failed, 1 needs a decision.",
    )
  })

  it("a reply with no pipeline key (an older hq) renders the same as a null pipeline", async () => {
    const nulled = await show(digestFixture({ pipeline: null }))
    const html = nulled.container.innerHTML
    nulled.unmount()
    const { pipeline: _gone, ...older } = digestFixture()
    // through the client's own schema, as the client reads a reply
    const parsed = digestSchema.parse(older)
    expect(parsed.pipeline).toBeUndefined()
    const view = await show(parsed)
    expect(view.container.innerHTML).toBe(html)
  })

  it("an empty pipeline adds one row, Stuck attempts 0, and nothing else", async () => {
    const sections = [/^Needs a decision/, "What the factory did", "What changed in production"]
    const read = async (digest: Digest) => {
      const view = await show(digest)
      const texts = sections.map((name) => view.getByRole("region", { name }).textContent)
      const health = view.getByRole("region", { name: "Factory health" }).textContent
      view.unmount()
      return { texts, health }
    }
    const empty = await read(digestFixture())
    const none = await read(digestFixture({ pipeline: null }))
    expect(empty.health).toContain("Stuck attempts0")
    expect(none.health).not.toContain("Stuck attempts")
    expect(empty.texts).toEqual(none.texts)
  })

  it("the banner counts proposals plus pipeline needs", async () => {
    const view = await show(
      withPipeline(
        { needsYou: [needs("merge_approval", 1)], needsYouTotal: 3, resolved: 4, reopened: 1 },
        { summary: { tone: "quiet", runsFinished: 2, runsFailed: 0, pendingProposals: 2 } },
      ),
    )
    expect(view.getByRole("status", { name: "Digest summary" }).textContent).toBe(
      "Quiet since Nov 16, 00:00 UTC. 2 runs finished, 0 failed, 4 verified, 1 reopened, 5 need a decision.",
    )
    expect(view.getByRole("region", { name: /Needs a decision/ }).textContent).toContain("5")
  })

  it("the banner names stuck attempts and the section is attention-toned", async () => {
    const view = await show(
      withPipeline(
        { stuckAttempts: 2 },
        { summary: { tone: "attention", runsFinished: 0, runsFailed: 0, pendingProposals: 0 } },
      ),
    )
    const banner = view.getByRole("status", { name: "Digest summary" })
    expect(banner.textContent).toContain("2 attempts stuck")
    expect(banner.className).toContain("bg-attention-surface")
    const one = await show(
      withPipeline(
        { stuckAttempts: 1 },
        { summary: { tone: "attention", runsFinished: 0, runsFailed: 0, pendingProposals: 0 } },
      ),
    )
    expect(one.getAllByRole("status", { name: "Digest summary" }).at(-1)?.textContent).toContain(
      "1 attempt stuck",
    )
  })

  it("Needs a decision shows a merge approval entry with Decide to /app/approvals", async () => {
    const view = await show(
      withPipeline(
        { needsYou: [needs("merge_approval", 6)], needsYouTotal: 1 },
        {
          summary: { tone: "quiet", runsFinished: 0, runsFailed: 0, pendingProposals: 0 },
          decisions: [],
        },
      ),
    )
    const section = view.getByRole("region", { name: /Needs a decision/ })
    expect(section.textContent).toContain("FAC-6 · merge approval")
    expect(section.textContent).toContain("Item 6")
    expect(section.textContent).toContain("Why: Reason 6")
    const decide = view.getByRole("link", { name: "Decide Item 6" })
    expect(decide.getAttribute("href")).toBe("/app/approvals")
    expect(view.getByRole("link", { name: "See all 1 in Approvals" })).toBeTruthy()
  })

  it("an agent question goes to Approvals and an exhausted or stuck item to its own page", async () => {
    const view = await show(
      withPipeline(
        {
          needsYou: [
            needs("agent_question", 2),
            needs("attempt_budget", 5),
            needs("stuck_attempt", 8),
          ],
          needsYouTotal: 3,
        },
        {
          summary: { tone: "quiet", runsFinished: 0, runsFailed: 0, pendingProposals: 0 },
          decisions: [],
        },
      ),
    )
    const section = view.getByRole("region", { name: /Needs a decision/ })
    expect(section.textContent).toContain("FAC-2 · agent question")
    expect(section.textContent).toContain("FAC-5 · attempt budget")
    expect(section.textContent).toContain("FAC-8 · stuck attempt")
    const href = (name: string) => view.getByRole("link", { name }).getAttribute("href")
    expect(href("Decide Item 2")).toBe("/app/approvals")
    expect(href("Decide Item 5")).toBe("/app/work/00000000-0000-4000-8000-000000000005")
    expect(href("Decide Item 8")).toBe("/app/work/00000000-0000-4000-8000-000000000008")
  })

  it("proposals and pipeline entries sit in one list, proposals first, and 'See all' counts both", async () => {
    const view = await show(
      withPipeline(
        { needsYou: [needs("merge_approval", 6)], needsYouTotal: 7 },
        {
          summary: { tone: "quiet", runsFinished: 0, runsFailed: 0, pendingProposals: 2 },
          decisions: pending(2),
        },
      ),
    )
    const items = view.getByRole("region", { name: /Needs a decision/ }).querySelectorAll("ul > li")
    expect(items).toHaveLength(3)
    expect(items[0]?.textContent).toContain("proposal-1")
    expect(items[2]?.textContent).toContain("FAC-6")
    expect(view.getByRole("link", { name: "See all 9 in Approvals" })).toBeTruthy()
  })

  it("says nothing needs a decision only when neither a proposal nor an item waits", async () => {
    const waiting = await show(
      withPipeline(
        { needsYou: [needs("attempt_budget", 5)], needsYouTotal: 1 },
        {
          decisions: [],
          summary: { tone: "quiet", runsFinished: 0, runsFailed: 0, pendingProposals: 0 },
        },
      ),
    )
    expect(waiting.queryByText("Nothing needs a decision")).toBeNull()
    waiting.unmount()
    const empty = await show(
      withPipeline(
        {},
        {
          decisions: [],
          summary: { tone: "quiet", runsFinished: 0, runsFailed: 0, pendingProposals: 0 },
        },
      ),
    )
    expect(empty.getAllByText("Nothing needs a decision")).toHaveLength(1)
  })

  it("What the factory did merges pipeline events into the time order", async () => {
    const view = await show(
      withPipeline({
        events: [
          {
            at: "2026-11-17T10:00:00.000Z",
            displayId: "FAC-7",
            text: "Sign-in link",
            result: "merged",
          },
          {
            at: "2026-11-17T07:00:00.000Z",
            displayId: "FAC-9",
            text: "Totals drift",
            result: "reopened",
          },
        ],
      }),
    )
    const items = view.getByRole("region", { name: "What the factory did" }).querySelectorAll("li")
    // the fixture's run is at 08:30
    expect(Array.from(items).map((li) => li.textContent)).toEqual([
      expect.stringContaining("FAC-7 merged: Sign-in link"),
      expect.stringContaining("Triage the inbox"),
      expect.stringContaining("FAC-9 reopened: Totals drift"),
    ])
    expect(items[0]?.textContent).toContain("Nov 17, 10:00 UTC")
    expect(items[0]?.textContent).toContain("merged")
    expect(items[2]?.textContent).toContain("reopened")
  })

  it("an events window with only pipeline events is not 'Nothing ran'", async () => {
    const view = await show(
      withPipeline(
        {
          events: [
            {
              at: "2026-11-17T10:00:00.000Z",
              displayId: "FAC-1",
              text: "Blank page",
              result: "opened",
            },
          ],
        },
        { events: [] },
      ),
    )
    expect(view.queryByText("Nothing ran in this window")).toBeNull()
    expect(view.getByText(/FAC-1 opened: Blank page/)).toBeTruthy()
  })

  it("production changes still says Not connected for deploys and lists merged pull requests labelled 'deploy not observed'", async () => {
    const view = await show(
      withPipeline({
        merged: [
          {
            at: "2026-11-17T10:00:00.000Z",
            displayId: "FAC-7",
            title: "Sign-in link opens the wrong page",
            pullRequestUrl: "https://github.com/acme/web/pull/107",
            repo: "acme/web",
            number: 107,
            state: "verifying",
          },
          {
            at: "2026-11-17T05:00:00.000Z",
            displayId: "FAC-10",
            title: "Avatar upload",
            pullRequestUrl: "https://github.com/acme/web/pull/110",
            repo: "acme/web",
            number: 110,
            state: "verified",
          },
        ],
      }),
    )
    const section = view.getByRole("region", { name: "What changed in production" })
    expect(section.textContent).toContain("Not connected")
    expect(section.textContent).toContain("Merged by the factory (deploy not observed)")
    expect(section.textContent).toContain("FAC-7")
    expect(section.textContent).toContain("Sign-in link opens the wrong page")
    expect(section.textContent).toContain("verifying")
    expect(section.textContent).toContain("verified")
    expect(section.textContent).not.toMatch(/live|deployed to production/i)
    const link = view.getByRole("link", { name: /Pull request 107/ })
    expect(link.getAttribute("href")).toBe("https://github.com/acme/web/pull/107")
    expect(link.className).toContain("min-h-touch")
  })

  it("a pull request url that is not a github pull request page is text, never a link", async () => {
    const view = await show(
      withPipeline({
        merged: [
          {
            at: "2026-11-17T10:00:00.000Z",
            displayId: "FAC-7",
            title: "Hostile",
            pullRequestUrl: "javascript:alert(1)",
            repo: "acme/web",
            number: 107,
            state: "merged",
          },
          {
            at: "2026-11-17T09:00:00.000Z",
            displayId: "FAC-8",
            title: "Elsewhere",
            pullRequestUrl: "https://evil.example/acme/web/pull/1",
            repo: "acme/web",
            number: 1,
            state: "merged",
          },
        ],
      }),
    )
    const section = view.getByRole("region", { name: "What changed in production" })
    expect(section.querySelector("a")).toBeNull()
    expect(section.textContent).toContain("Hostile")
  })

  it("the pull request link is the one W16's pullRequestLink builds: another repo, number or case of host is no link", async () => {
    // The full table of hostile urls is lib/pull-request-link.test.ts; these are the rows the
    // Digest's own fields (repo and number beside the url) can disagree on.
    const row = (displayId: string, pullRequestUrl: string, number: number, repo = "acme/web") => ({
      at: "2026-11-17T10:00:00.000Z",
      displayId,
      title: displayId,
      pullRequestUrl,
      repo,
      number,
      state: "merged" as const,
    })
    const view = await show(
      withPipeline({
        merged: [
          row("FAC-1", "https://github.com/acme/web/pull/5", 5),
          row("FAC-2", "https://github.com/ACME/Web/pull/6", 6),
          // the url names another number, another repo, a query, userinfo or http
          row("FAC-3", "https://github.com/acme/web/pull/7", 8),
          row("FAC-4", "https://github.com/other/web/pull/9", 9),
          row("FAC-5", "https://github.com/acme/web/pull/10?x=1", 10),
          row("FAC-6", "https://user@github.com/acme/web/pull/11", 11),
          row("FAC-7", "http://github.com/acme/web/pull/12", 12),
          row("FAC-8", "https://github.com/acme/web/pull/13/", 13),
        ],
      }),
    )
    const hrefs = Array.from(
      view.getByRole("region", { name: "What changed in production" }).querySelectorAll("a"),
    ).map((a) => a.getAttribute("href"))
    // the built url, never the given string: the second row is lower-cased by the repo it matched
    expect(hrefs).toEqual([
      "https://github.com/acme/web/pull/5",
      "https://github.com/acme/web/pull/6",
    ])
  })

  it("Factory health shows Stuck attempts", async () => {
    const view = await show(withPipeline({ stuckAttempts: 3 }))
    const section = view.getByRole("region", { name: "Factory health" })
    const fact = (name: string) =>
      Array.from(section.querySelectorAll("dt")).find((dt) => dt.textContent === name)
        ?.nextElementSibling?.textContent
    expect(fact("Stuck attempts")).toBe("3")
    expect(fact("Stuck runs")).toBe("0")
  })

  it("renders every pipeline text as text, never as markup, and long text stays inside its row", async () => {
    const hostile = '<img src=x onerror="alert(1)"> **bold** [click](https://evil.example)'
    const long = "x".repeat(40_000)
    const view = await show(
      withPipeline(
        {
          needsYou: [needs("merge_approval", 1, { title: hostile, reason: long })],
          needsYouTotal: 1,
          merged: [
            {
              at: "2026-11-17T10:00:00.000Z",
              displayId: "FAC-7",
              title: hostile,
              pullRequestUrl: "https://github.com/acme/web/pull/107",
              repo: "acme/web",
              number: 107,
              state: "merged",
            },
          ],
          events: [
            { at: "2026-11-17T10:00:00.000Z", displayId: "FAC-7", text: hostile, result: "merged" },
          ],
        },
        { decisions: [] },
      ),
    )
    expect(view.container.querySelector("img, script")).toBeNull()
    expect(view.container.querySelector("a[href^='https://evil']")).toBeNull()
    expect(view.getAllByText(hostile, { exact: false }).length).toBeGreaterThanOrEqual(3)
    const decide = view.getByRole("link", { name: /^Decide/ })
    expect(decide.className).toContain("shrink-0")
    expect(view.getByText(`Why: ${long}`).className).toContain("wrap-anywhere")
  })

  it("every pipeline link is at least 44 px (class min-h-touch)", async () => {
    const view = await show(
      withPipeline({
        needsYou: [needs("merge_approval", 1), needs("attempt_budget", 2)],
        needsYouTotal: 2,
        merged: digestPipelineFixture().merged,
      }),
    )
    const controls = Array.from(view.container.querySelectorAll("a, button"))
    expect(controls.length).toBeGreaterThan(5)
    for (const control of controls) {
      expect(control.className, control.textContent ?? "").toContain("min-h-touch")
    }
  })

  it("has no inline style with the pipeline", async () => {
    const view = await show(digestFixture({ pipeline: digestPipelineFixture() }))
    expect(view.container.querySelectorAll("[style]")).toHaveLength(0)
  })

  it("has no accessibility violations with the seeded pipeline", async () => {
    const view = await show(digestFixture({ pipeline: digestPipelineFixture() }))
    await expectNoA11yViolations(view.container.innerHTML)
  })
})
