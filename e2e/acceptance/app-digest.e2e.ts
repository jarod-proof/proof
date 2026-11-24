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

/** What `get_digest` says that the screen shows (only Phase 3's fields: an extra key is ignored). */
interface DigestFacts {
  tone: string
  runsFinished: number
  runsFailed: number
  pendingProposals: number
  stuckRuns: number
}

/**
 * Which of hq's numbers the banner and the section heading do not show. A number must stand alone
 * (not inside a longer one: "0 failed" is not found in "10 failed").
 */
function digestDifferences(banner: string, heading: string, hq: DigestFacts): string[] {
  const lacks: string[] = []
  const needs = (text: string, pattern: RegExp, what: string) => {
    if (!pattern.test(text)) lacks.push(what)
  }
  const runs = hq.runsFinished === 1 ? "run" : "runs"
  const need = hq.pendingProposals === 1 ? "needs" : "need"
  needs(banner, hq.tone === "quiet" ? /^Quiet since/ : /^Attention since/, `tone ${hq.tone}`)
  needs(banner, new RegExp(`(?<!\\d)${hq.runsFinished} ${runs} finished`), "runs finished")
  needs(banner, new RegExp(`(?<!\\d)${hq.runsFailed} failed`), "runs failed")
  needs(banner, new RegExp(`(?<!\\d)${hq.pendingProposals} ${need} a decision`), "pending")
  needs(heading, new RegExp(`Needs a decision\\s*${hq.pendingProposals}(?!\\d)`), "heading count")
  // The banner names stuck runs only when there are some.
  if (hq.stuckRuns > 0) {
    needs(banner, new RegExp(`(?<!\\d)${hq.stuckRuns} stuck`), "stuck runs")
  } else if (/stuck/.test(banner)) {
    lacks.push("no stuck runs")
  }
  return lacks
}

// Phase 3 acceptance on a deployed org: the Digest screen of the hq app. The banner says what
// get_digest says (runs finished and failed, and how many proposals need a decision), and what hq
// has no source for (product health, deploys) reads "Not connected", never a number. Phase 4 adds a
// `pipeline` key to get_digest (null until its step has run): only Phase 3's fields are read here,
// so an extra key or a null changes nothing. Read-only, deterministic, no model. On a live org hq
// can change between the page's fetch and the journey's, so the screen is compared with hq read
// before and after it, and a difference reloads the page and tries again (up to 90 seconds).
test("Digest shows the pending count get_digest reports, and Product health is Not connected", {
  // The founder's session cookie is put in the browser: no trace, no video, so it is not recorded.
  // Room for the sign-in fallback of openAppAsFounder waiting out a rate limit.
  timeout: 240_000,
  skip: acceptanceSkip,
  trace: "off",
  video: "off",
}, async ({ app, browser, screen }) => {
  claimRun("app-digest")
  assertAppIsHq(app)

  await openAppAsFounder(app, browser, screen, "/digest")
  await expect(screen.getByRole("heading", "Digest")).toBeVisible()
  const banner = screen.getByRole("status", "Digest summary")
  await expect(banner).toBeVisible()
  const section = screen.getByRole("region", "Needs a decision", { exact: false })

  const founder = await founderClient()
  const readDigest = async (): Promise<DigestFacts> => {
    const reply = await founder.get("/v1/digest")
    expect(reply.status).toBe(200)
    const summary = reply.json.summary as Omit<DigestFacts, "stuckRuns">
    const health = reply.json.health as { stuckRuns: number }
    return { ...summary, stuckRuns: health.stuckRuns }
  }
  await expectPageToAgreeWithHq(browser, banner, async () => {
    const { hq, seen, held } = await readAround(readDigest, async () => ({
      banner: (await banner.textContent()) ?? "",
      heading: (await section.getByRole("heading").textContent()) ?? "",
    }))
    if (!held) return "hq changed while the screen was read"
    const lacks = digestDifferences(seen.banner, seen.heading, hq)
    return lacks.length === 0
      ? ""
      : `the screen lacks ${lacks.join(", ")}: "${seen.banner}" / "${seen.heading}" for ${JSON.stringify(hq)}`
  })

  // Nothing is invented: what hq has no source for says so, under each label.
  for (const label of ["Errors per hour", "Checkout completion", "People struggling"]) {
    await expect(screen.getByRole("status").filter({ hasText: label })).toContainText(
      "Not connected",
    )
  }
  await expect(screen.getByRole("region", "What changed in production")).toContainText(
    "Not connected",
  )
})
