// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import type { HtmlEscapedString } from "hono/utils/html"
import { describe, it } from "vitest"

import { DAILY_CAP } from "../data/money"
import { EntryPage, LoginPage, ProposalsPage, SpendPage } from "./pages"

/** The page as markup. */
const html = async (page: HtmlEscapedString | Promise<HtmlEscapedString>) => (await page).toString()

const NOW = new Date("2026-11-17T12:00:00Z")
const proposal = (id: string, status: "pending" | "approved") => ({
  id,
  entryId: status === "approved" ? "e1" : null,
  kind: "fact" as const,
  slug: "pricing",
  baseVersion: null,
  title: "Pricing",
  body: { text: "Free, then $20 per seat." },
  reason: "Founders call",
  status,
  proposedBy: { type: "agent" as const, id: "k1" },
  runId: null,
  decidedBy: status === "approved" ? "u1" : null,
  decidedAt: status === "approved" ? NOW : null,
  decisionNote: null,
  createdAt: NOW,
})

describe("admin pages have no accessibility violations", () => {
  it("sign in", async () => {
    await expectNoA11yViolations(await html(<LoginPage next="/admin/spend" />))
  })

  it("proposals, with pending and decided", async () => {
    await expectNoA11yViolations(
      await html(
        <ProposalsPage
          pending={[proposal("p1", "pending")]}
          decided={[proposal("p2", "approved")]}
          error="The proposal was already approved"
        />,
      ),
    )
  })

  it("an entry's history", async () => {
    await expectNoA11yViolations(
      await html(
        <EntryPage
          versions={[
            {
              id: "v1",
              kind: "fact",
              slug: "pricing",
              version: 1,
              latestVersion: 1,
              title: "Pricing",
              body: { text: "Free." },
              source: "proposal:p1",
              author: { type: "agent", id: "k1" },
              runId: null,
              createdAt: NOW,
            },
          ]}
        />,
      ),
    )
  })

  it("spend, with rows and without", async () => {
    const allowance = { day: "2026-11-17", spent: 12500, reserved: 0, granted: 0, remaining: 87500 }
    await expectNoA11yViolations(
      await html(
        <SpendPage
          allowance={allowance}
          capUsd={DAILY_CAP}
          rows={[{ day: "2026-11-17", source: "eve", task: "chat", amount: 12500, estimated: 0 }]}
        />,
      ),
    )
    await expectNoA11yViolations(
      await html(<SpendPage allowance={allowance} capUsd={DAILY_CAP} rows={[]} />),
    )
  })
})
