import { test } from "@e2e-dev/web"
import { expect } from "e2e"

import { acceptanceSkip, agentClient, claimRun, errorCode, founderClient, runTag } from "./support"

// Phase 1 acceptance on a deployed org: the daily Eve cap. The day's Eve spend is brought up to the
// cap ($10.00 plus any grants already made today) by reserving what is left and settling that hold
// (reserve_spend, settle_spend: atomic, so a second copy is refused, never an overshoot); the allowance is then 0
// and a new turn is refused; a founder's grant of $2 raises it to $2 (an API key's grant is
// FORBIDDEN). Deterministic, no model. Nothing in the ledger is ever deleted, so this leaves the
// day's Eve spend at the cap and the allowance at $2: a second run on the same UTC day starts from
// that $2, spends it, and ends at $2 again (spent 12.00 and granted 2.00 more, and so on).

/** What the allowance reply holds, in whole units of $0.0001 so the arithmetic is exact. */
interface Allowance {
  day: string
  spent: number
  reserved: number
  cap: number
  granted: number
  /** cap + granted - spent - reserved: unlike remainingUsd it is not clamped at 0. */
  raw: number
  remaining: number
}

const units = (usd: unknown) => Math.round((usd as number) * 10_000)

test("with today's eve spend at 10.00 the allowance is 0; a founder grant of 2 raises it to 2", {
  timeout: 120_000,
  skip: acceptanceSkip,
}, async () => {
  claimRun("spend")
  const agent = agentClient()
  const founder = await founderClient()
  const read = async (): Promise<Allowance> => {
    const reply = await agent.get("/v1/spend/allowance")
    expect(reply.status).toBe(200)
    const a = reply.json
    const parts = {
      day: a.day as string,
      spent: units(a.spentUsd),
      reserved: units(a.reservedUsd),
      cap: units(a.capUsd),
      granted: units(a.grantedUsd),
      remaining: units(a.remainingUsd),
    }
    return { ...parts, raw: parts.cap + parts.granted - parts.spent - parts.reserved }
  }

  const start = await read()
  expect(start.cap, "the daily Eve cap is $10.00").toBe(100_000)
  // Someone spent past the cap today: the allowance cannot be brought to exactly 0 by adding.
  expect(start.raw, "today's Eve spend is already past the cap").toBeGreaterThanOrEqual(0)

  // Bring the day's Eve spend up to the cap the way a real Eve turn does: reserve what is left (hq
  // takes it in one transaction under the day's lock), then settle the hold at that amount. If
  // something else reserved first, hq refuses ours and we read again, so a race is a refusal and
  // never an overshoot.
  const model = `acceptance-${runTag()}`
  for (let attempt = 0; attempt < 5; attempt++) {
    const now = await read()
    expect(now.day, "the UTC day did not change mid-run").toBe(start.day)
    if (now.raw <= 0) break
    const hold = await agent.post("/v1/spend/reservations", {
      source: "eve",
      estimateUsd: now.raw / 10_000,
    })
    expect(hold.status).toBe(200)
    if (hold.json.refused === true) continue
    const settled = await agent.post(`/v1/spend/holds/${hold.json.holdId as string}/settlement`, {
      amountUsd: now.raw / 10_000,
      model,
    })
    expect(settled.status).toBe(200)
    expect(settled.json).toMatchObject({ amountUsd: now.raw / 10_000, estimated: false })
  }
  const full = await read()
  expect(full.day).toBe(start.day)
  expect(full.raw).toBe(0)
  expect(full.remaining).toBe(0)
  // On a day nobody granted anything yet, that is exactly $10.00 of Eve spend.
  if (full.granted === 0) expect(full.spent + full.reserved).toBe(100_000)

  // A turn that asks for the least is refused: hq, not the caller, holds the cap.
  const refused = await agent.post("/v1/spend/reservations", { source: "eve", estimateUsd: 0.01 })
  expect(refused.status).toBe(200)
  expect(refused.json).toMatchObject({ refused: true, remainingUsd: 0 })

  // The agent cannot grant itself more: only a signed-in founder can.
  const forged = await agent.post("/v1/spend/grants", { amountUsd: 2, reason: "acceptance run" })
  expect(forged.status).toBe(403)
  expect(errorCode(forged)).toBe("FORBIDDEN")
  expect((await read()).remaining).toBe(0)

  // The founder's grant of $2 raises the allowance to $2.
  const grant = await founder.post("/v1/spend/grants", {
    amountUsd: 2,
    reason: `acceptance run ${runTag()}`,
  })
  expect(grant.status).toBe(200)
  expect(grant.json).toMatchObject({ day: start.day, grantedUsd: 2 })
  const after = await read()
  expect(after.day).toBe(start.day)
  expect(after.granted).toBe(full.granted + 20_000)
  expect(after.remaining).toBe(20_000)
})
