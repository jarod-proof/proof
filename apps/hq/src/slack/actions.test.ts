import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"

import {
  createHqHarness,
  slackFormBody,
  TEST_SLACK_SECRET,
  TEST_SLACK_TEAM,
  type TestPerson,
} from "../app.test.helpers"
import { founders, spendGrantRequests, spendGrants } from "../db/schema"
import { createSlackActionHandler, grantActionId, parseActionId, proposalActionId } from "./actions"
import { slackSignature } from "./verify"

// A founder's click on a Slack card, through hq's real app on in-process Postgres. The click is
// signed the way Slack signs it; the agent's job (forwarding the bytes) is tested in the agent.

describe("Slack actions (real hq on PGlite)", () => {
  let hq: Awaited<ReturnType<typeof createHqHarness>>
  let founder: TestPerson
  let founderSlack: string
  let agentKey: { key: string }
  // The harness clock: the grant tests move it (a day of their own each, and past a request's TTL).
  let clock = new Date("2026-11-17T12:00:00Z")

  beforeAll(async () => {
    hq = await createHqHarness({ founderEmails: ["founder@example.com"], now: () => clock })
    founder = await hq.signUp("founder@example.com")
    founderSlack = "UFOUNDER"
    await hq.addFounder(founder, founderSlack)
    // Exactly the agent's scope: it proposes and reads, it never decides.
    agentKey = {
      key: await hq.keyFor(founder, {
        hq_entry: ["read"],
        hq_proposal: ["read", "create"],
        hq_run: ["read", "create", "update"],
        hq_spend: ["read", "record", "request"],
      }),
    }
  })
  afterAll(() => hq.close())

  let n = 0
  /** A pending proposal from the agent: the card's proposal id and the version it names. */
  async function propose(slug = `price-${++n}`, text = "Free, then $20 per seat.") {
    const res = await hq.call(agentKey, "POST", "/v1/proposals", {
      kind: "fact",
      slug,
      title: `Pricing ${slug}`,
      body: { text },
      reason: "heard in Slack",
    })
    expect(res.status).toBe(200)
    return res.body.proposalId
  }
  const proposalOf = async (id: string) =>
    (await hq.call({ cookie: founder.cookie }, "GET", "/v1/proposals")).body.proposals.find(
      (p) => p.id === id,
    )
  const allowance = async () =>
    (await hq.call(agentKey, "GET", "/v1/spend/allowance")).body as unknown as {
      grantedUsd: number
      remainingUsd: number
    }
  const approve = (id: string, version: number | null = null) =>
    proposalActionId("approve", id, version)

  it("a founder's approve click approves the proposal", async () => {
    const id = await propose()
    const click = await hq.slackClick({ slackUserId: founderSlack, actionId: approve(id) })
    expect(click.status).toBe(200)
    expect(click.text).toMatch(/^Approved: /)
    const after = await proposalOf(id)
    expect(after?.status).toBe("approved")
    // Decided as the founder the Slack user maps to, never as the forwarding key.
    expect(after?.decidedBy).toBe(founder.userId)
    expect(after?.entryId).not.toBeNull()
  })

  it("a founder's reject click rejects it and writes no entry", async () => {
    const id = await propose()
    const click = await hq.slackClick({
      slackUserId: founderSlack,
      actionId: proposalActionId("reject", id, null),
    })
    expect(click.status).toBe(200)
    const after = await proposalOf(id)
    expect(after?.status).toBe("rejected")
    expect(after?.entryId).toBeNull()
  })

  it("a non-founder's click returns 403 and leaves it pending", async () => {
    const id = await propose()
    // A real workspace member, valid signature, no founders row.
    const click = await hq.slackClick({ slackUserId: "UNOTFOUNDER", actionId: approve(id) })
    expect(click.status).toBe(403)
    const after = await proposalOf(id)
    expect(after?.status).toBe("pending")
    expect(after?.decidedBy).toBeNull()
    expect(after?.entryId).toBeNull()
  })

  it("a replayed click after decision returns 409", async () => {
    const id = await propose()
    const first = await hq.slackClick({ slackUserId: founderSlack, actionId: approve(id) })
    expect(first.status).toBe(200)
    const decided = await proposalOf(id)

    // The identical request again: the same bytes, the same signature, inside the 5 minutes.
    const timestamp = first.timestamp
    const replay = await hq.app.request("http://localhost:3100/v1/slack/actions", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": slackSignature(TEST_SLACK_SECRET, timestamp, first.rawBody),
      },
      body: first.rawBody,
    })
    expect(replay.status).toBe(409)
    // And a fresh click on the decided card, a reject this time: nothing changes.
    const again = await hq.slackClick({
      slackUserId: founderSlack,
      actionId: proposalActionId("reject", id, null),
    })
    expect(again.status).toBe(409)
    expect(await proposalOf(id)).toEqual(decided)
  })

  it("a bad signature returns 403", async () => {
    const id = await propose()
    const goodTimestamp = String(Math.floor(hq.now().getTime() / 1000))
    const cases = [
      { signature: `v0=${"0".repeat(64)}` },
      { signature: slackSignature("another-secret", goodTimestamp, "x") },
      { signature: null },
      { signature: "" },
      // Stale by a minute past five, and from the future by more than one.
      { signedAt: new Date(hq.now().getTime() - 301_000) },
      { signedAt: new Date(hq.now().getTime() + 61_000) },
    ]
    for (const c of cases) {
      const click = await hq.slackClick({
        slackUserId: founderSlack,
        actionId: approve(id),
        ...c,
      })
      expect(click.status, JSON.stringify(c)).toBe(403)
    }
    expect((await proposalOf(id))?.status).toBe("pending")
  })

  it("is verified over the exact bytes: the same click re-encoded differently is refused", async () => {
    const id = await propose()
    const body = slackFormBody({
      type: "block_actions",
      team: { id: TEST_SLACK_TEAM },
      user: { id: founderSlack },
      actions: [{ action_id: approve(id), action_ts: "1.1" }],
    })
    const timestamp = String(Math.floor(hq.now().getTime() / 1000))
    const signature = slackSignature(TEST_SLACK_SECRET, timestamp, body)
    const send = (rawBody: string) =>
      hq.slackClick({
        slackUserId: founderSlack,
        actionId: approve(id),
        rawBody,
        signature,
      })
    // Signed for `body`; the same data with its percent-escapes spelled in lower case is not it.
    const reencoded = body.replace(/%7B/g, "%7b")
    expect(reencoded).not.toBe(body)
    expect((await send(reencoded)).status).toBe(403)
    expect((await send(`${body}&extra=1`)).status).toBe(403)
    expect((await proposalOf(id))?.status).toBe("pending")
    expect((await send(body)).status).toBe(200)
  })

  it("a click from another workspace is refused, however well signed", async () => {
    const id = await propose()
    const click = await hq.slackClick({
      slackUserId: founderSlack,
      actionId: approve(id),
      teamId: "TOTHERTEAM",
    })
    expect(click.status).toBe(403)
    expect((await proposalOf(id))?.status).toBe("pending")
  })

  it("refuses a signed payload that is not one of hq's button clicks", async () => {
    const id = await propose()
    const bodies = [
      "not a form",
      slackFormBody({ type: "view_submission", user: { id: founderSlack } }),
      slackFormBody({
        type: "block_actions",
        team: { id: TEST_SLACK_TEAM },
        user: { id: founderSlack },
        actions: [],
      }),
      // Two actions at once: which one is meant is not for hq to guess.
      slackFormBody({
        type: "block_actions",
        team: { id: TEST_SLACK_TEAM },
        user: { id: founderSlack },
        actions: [{ action_id: approve(id) }, { action_id: approve(id) }],
      }),
      slackFormBody({
        type: "block_actions",
        team: { id: TEST_SLACK_TEAM },
        user: { id: founderSlack },
        actions: [{ action_id: "eve_input:whatever" }],
      }),
    ]
    for (const rawBody of bodies) {
      const click = await hq.slackClick({ slackUserId: founderSlack, actionId: "x", rawBody })
      expect(click.status, rawBody).toBe(403)
    }
    expect((await proposalOf(id))?.status).toBe("pending")
  })

  it("a founder removed from the table can no longer click", async () => {
    const other = await hq.signUp("leaving@example.com")
    await hq.addFounder(other, "ULEAVING")
    const id = await propose()
    await hq.db.delete(founders).where(eq(founders.userId, other.userId))
    const click = await hq.slackClick({ slackUserId: "ULEAVING", actionId: approve(id) })
    expect(click.status).toBe(403)
    expect((await proposalOf(id))?.status).toBe("pending")
  })

  describe("a stale card", () => {
    async function approvedEntry(slug: string) {
      const id = await propose(slug, "Version one.")
      expect(
        (await hq.slackClick({ slackUserId: founderSlack, actionId: approve(id) })).status,
      ).toBe(200)
      return (await proposalOf(id))?.entryId as string
    }

    it("approving after the entry was edited is the same CONFLICT as decide_proposal, and writes nothing", async () => {
      const entryId = await approvedEntry("stale-entry")
      // A proposal against version 1, then a founder edits the entry to version 2.
      const res = await hq.call(agentKey, "POST", "/v1/proposals", {
        kind: "fact",
        slug: "stale-entry",
        title: "Pricing stale-entry",
        body: { text: "Version one, per the agent." },
        reason: "r",
        baseVersion: 1,
      })
      const proposalId = res.body.proposalId
      const edited = await hq.call(
        { cookie: founder.cookie },
        "POST",
        `/v1/entries/${entryId}/versions`,
        { title: "Edited", body: { text: "Version two, by a founder." }, baseVersion: 1 },
      )
      expect(edited.status).toBe(200)

      const click = await hq.slackClick({
        slackUserId: founderSlack,
        actionId: proposalActionId("approve", proposalId, 1),
      })
      expect(click.status).toBe(409)
      // The same refusal the founder gets deciding it over the API.
      const viaApi = await hq.call(
        { cookie: founder.cookie },
        "POST",
        `/v1/proposals/${proposalId}/decision`,
        { decision: "approve" },
      )
      expect(viaApi.status).toBe(409)
      expect(viaApi.body.error.code).toBe("CONFLICT")
      expect(click.text).toBe(viaApi.body.error.message)

      // Nothing was overwritten: the founder's version 2 is still the latest.
      const entry = await hq.call({ cookie: founder.cookie }, "GET", `/v1/entries/${entryId}`)
      expect(entry.body.latestVersion).toBe(2)
      expect(entry.body.body.text).toBe("Version two, by a founder.")
      expect((await proposalOf(proposalId))?.status).toBe("pending")
    })

    it("a card that names another version than the proposal's is out of date", async () => {
      await approvedEntry("version-mismatch")
      const res = await hq.call(agentKey, "POST", "/v1/proposals", {
        kind: "fact",
        slug: "version-mismatch",
        title: "Pricing version-mismatch",
        body: { text: "An update." },
        reason: "r",
        baseVersion: 1,
      })
      const click = await hq.slackClick({
        slackUserId: founderSlack,
        actionId: proposalActionId("approve", res.body.proposalId, 7),
      })
      expect(click.status).toBe(409)
      expect(click.text).toMatch(/out of date/)
      expect((await proposalOf(res.body.proposalId))?.status).toBe("pending")
    })

    it("an unknown proposal is a 409, not a crash", async () => {
      const click = await hq.slackClick({
        slackUserId: founderSlack,
        actionId: approve("does-not-exist"),
      })
      expect(click.status).toBe(409)
    })
  })

  describe("a spend grant", () => {
    // A day of its own for each test: requests are counted per UTC day.
    let day = 0
    beforeEach(() => {
      clock = new Date(Date.UTC(2031, 0, ++day, 12))
    })

    /** What the agent does: ask hq for a grant, and get the id the card will carry. */
    async function ask(amountUsd = 5, reason = "A hard pricing question") {
      const res = await hq.call(agentKey, "POST", "/v1/spend/grant-requests", { amountUsd, reason })
      expect(res.status).toBe(200)
      return res.body.requestId
    }
    const clickGrant = (requestId: string, over: { cents?: number; slackUserId?: string } = {}) =>
      hq.slackClick({
        slackUserId: over.slackUserId ?? founderSlack,
        actionId: grantActionId(true, requestId, over.cents ?? 500),
      })
    const requestRow = async (id: string) =>
      (await hq.db.select().from(spendGrantRequests).where(eq(spendGrantRequests.id, id)))[0]

    it("a valid click on a request id hq never recorded grants nothing, however it is signed", async () => {
      // The N8 finding: the signing secret alone used to be enough to mint grants. Now the click
      // must name a request hq recorded.
      const before = (await allowance()).grantedUsd
      const rows = (await hq.db.select().from(spendGrants)).length
      const forgeries = ["fresh-request-1", "fresh-request-2", crypto.randomUUID()]
      for (const forged of forgeries) {
        const click = await clickGrant(forged, { cents: 2500 })
        expect(click.status, forged).toBe(409)
        expect(click.text).toMatch(/no such grant request/)
      }
      // An id that exists, but is a proposal's, is no grant request either.
      const proposalId = await propose()
      expect((await clickGrant(proposalId)).status).toBe(409)
      expect((await allowance()).grantedUsd).toBe(before)
      expect(await hq.db.select().from(spendGrants)).toHaveLength(rows)
    })

    it("grants the recorded amount whatever amount the click carries", async () => {
      const before = (await allowance()).grantedUsd
      const small = await ask(5)
      // A click edited to name $25.00 on a $5.00 request.
      const inflated = await clickGrant(small, { cents: 2500 })
      expect(inflated.status).toBe(200)
      expect(inflated.text).toBe("Granted $5.00 for today.")
      expect((await allowance()).grantedUsd).toBe(before + 5)
      // And the other way: a click naming $0.01 on a $7.25 request grants $7.25.
      const odd = await ask(7.25)
      const deflated = await clickGrant(odd, { cents: 1 })
      expect(deflated.text).toBe("Granted $7.25 for today.")
      expect((await allowance()).grantedUsd).toBe(before + 12.25)
      expect((await requestRow(small))?.status).toBe("granted")
      expect((await requestRow(small))?.decidedBy).toBe(founder.userId)
    })

    it("a founder's click grants once; the same request replayed or clicked again grants nothing more", async () => {
      const before = (await allowance()).grantedUsd
      const request = await ask(5)
      const first = await hq.slackClick({
        slackUserId: founderSlack,
        actionId: grantActionId(true, request, 500),
      })
      expect(first.status).toBe(200)
      expect((await allowance()).grantedUsd).toBe(before + 5)

      // The identical bytes again.
      const timestamp = first.timestamp
      const replay = await hq.app.request("http://localhost:3100/v1/slack/actions", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": slackSignature(TEST_SLACK_SECRET, timestamp, first.rawBody),
        },
        body: first.rawBody,
      })
      expect(replay.status).toBe(409)
      // A second click (another action_ts) on the same request, even by another founder.
      const again = await hq.slackClick({
        slackUserId: founderSlack,
        actionId: grantActionId(true, request, 500),
        actionTs: "9999999999.000100",
      })
      expect(again.status).toBe(409)
      expect((await allowance()).grantedUsd).toBe(before + 5)
    })

    it("two clicks at once on one request grant once", async () => {
      const before = (await allowance()).grantedUsd
      const rows = (await hq.db.select().from(spendGrants)).length
      const request = await ask(3)
      const clicks = await Promise.all(
        [1, 2, 3].map(() =>
          hq.slackClick({
            slackUserId: founderSlack,
            actionId: grantActionId(true, request, 300),
          }),
        ),
      )
      expect(clicks.map((c) => c.status).sort((x, y) => x - y)).toEqual([200, 409, 409])
      expect((await allowance()).grantedUsd).toBe(before + 3)
      expect(await hq.db.select().from(spendGrants)).toHaveLength(rows + 1)
    })

    it("an expired request is refused and grants nothing; one just inside the day still works", async () => {
      const stale = await ask(5)
      const fresh = await ask(4)
      // 24 hours and a second later: past the TTL. The day has moved on too, so the grant would
      // have landed in a new day's allowance.
      const asked = clock
      clock = new Date(asked.getTime() + 24 * 60 * 60 * 1000 + 1000)
      const refused = await clickGrant(stale)
      expect(refused.status).toBe(409)
      expect(refused.text).toMatch(/expired/)
      expect((await allowance()).grantedUsd).toBe(0)
      expect((await requestRow(stale))?.status).toBe("expired")
      // Expired stays expired, and a dismiss on it changes nothing either.
      expect((await clickGrant(stale)).status).toBe(409)
      const dismiss = await hq.slackClick({
        slackUserId: founderSlack,
        actionId: grantActionId(false, stale, 500),
      })
      expect(dismiss.status).toBe(409)
      expect((await requestRow(stale))?.status).toBe("expired")

      // Another request, clicked a minute before its day is up.
      clock = new Date(asked.getTime() - 1000)
      const early = await ask(4)
      clock = new Date(asked.getTime() + 24 * 60 * 60 * 1000 - 60_000 - 1000)
      expect((await clickGrant(early)).status).toBe(200)
      expect((await allowance()).grantedUsd).toBe(4)
      expect((await requestRow(fresh))?.status).toBe("pending")
    })

    it("a non-founder's grant click is 403 and grants nothing; a dismissed request cannot be granted later", async () => {
      const before = (await allowance()).grantedUsd
      const stranger = await ask(5)
      const dismissed = await ask(5)
      const refused = await clickGrant(stranger, { slackUserId: "UNOTFOUNDER" })
      expect(refused.status).toBe(403)
      expect((await requestRow(stranger))?.status).toBe("pending")
      const deny = await hq.slackClick({
        slackUserId: founderSlack,
        actionId: grantActionId(false, dismissed, 500),
      })
      expect(deny.status).toBe(200)
      expect((await requestRow(dismissed))?.status).toBe("rejected")
      expect((await clickGrant(dismissed)).status).toBe(409)
      expect((await allowance()).grantedUsd).toBe(before)
      // The stranger's request is still open for a founder.
      expect((await clickGrant(stranger)).status).toBe(200)
    })

    it("the third $25 click in a UTC day is refused at the default $50 total, and grants nothing", async () => {
      const [a, b, c] = [await ask(25), await ask(25), await ask(25)]
      expect((await clickGrant(a, { cents: 2500 })).status).toBe(200)
      // Exactly the cap is allowed.
      expect((await clickGrant(b, { cents: 2500 })).status).toBe(200)
      expect((await allowance()).grantedUsd).toBe(50)

      const refused = await clickGrant(c, { cents: 2500 })
      expect(refused.status).toBe(409)
      expect(refused.text).toMatch(/at most \$50\.00 a day in all.*\$50\.00 is already granted/)
      expect(refused.text).toMatch(/Nothing was granted/)
      expect((await allowance()).grantedUsd).toBe(50)
      // Refused whole: the request is still pending, not spent or expired.
      expect((await requestRow(c))?.status).toBe("pending")
      expect((await requestRow(c))?.decidedBy).toBeNull()
      // A dismiss is not a grant: it still works on the capped request.
      const dismissed = await hq.slackClick({
        slackUserId: founderSlack,
        actionId: grantActionId(false, c, 2500),
      })
      expect(dismissed.status).toBe(200)
      expect((await allowance()).grantedUsd).toBe(50)
    })

    it("the cap counts the day's total, not one click: small grants add up to it", async () => {
      const ids = [await ask(20), await ask(20), await ask(15)]
      for (const id of ids.slice(0, 2)) expect((await clickGrant(id)).status).toBe(200)
      // $40 granted: $15 would make $55.
      expect((await clickGrant(ids[2] ?? "")).status).toBe(409)
      const small = await ask(10)
      expect((await clickGrant(small)).status).toBe(200)
      expect((await allowance()).grantedUsd).toBe(50)
    })

    it("the cap resets with the next UTC day, and a refused request can be redeemed then", async () => {
      const [a, b, c] = [await ask(25), await ask(25), await ask(25)]
      await clickGrant(a)
      await clickGrant(b)
      expect((await clickGrant(c)).status).toBe(409)
      // Half past midnight UTC, twelve and a half hours after the requests: still inside 24 hours.
      day += 1 // the next test starts a day after this one
      clock = new Date(Date.UTC(2031, 0, day, 0, 30))
      expect((await allowance()).grantedUsd).toBe(0)
      expect((await clickGrant(c)).status).toBe(200)
      expect((await allowance()).grantedUsd).toBe(25)
      // And the new day has its own $50: one more $25 fits, a third does not.
      const [d, e] = [await ask(25), await ask(25)]
      expect((await clickGrant(d)).status).toBe(200)
      expect((await clickGrant(e)).status).toBe(409)
    })

    it("a founder's own grant_spend is outside the Slack total: $40 granted by hand leaves both $25 clicks through", async () => {
      const byHand = await hq.call({ cookie: founder.cookie }, "POST", "/v1/spend/grants", {
        amountUsd: 40,
        reason: "by hand",
      })
      expect(byHand.status).toBe(200)
      const [a, b, c] = [await ask(25), await ask(25), await ask(25)]
      expect((await clickGrant(a)).status).toBe(200)
      expect((await clickGrant(b)).status).toBe(200)
      expect((await clickGrant(c)).status).toBe(409)
      // 40 by hand plus the Slack $50: the cap bounds only what clicks add.
      expect((await allowance()).grantedUsd).toBe(90)
    })

    it("clicks at once cannot pass the cap together", async () => {
      const ids = [await ask(25), await ask(25), await ask(25), await ask(25)]
      const clicks = await Promise.all(ids.map((id) => clickGrant(id)))
      expect(clicks.map((c) => c.status).sort((x, y) => x - y)).toEqual([200, 200, 409, 409])
      expect((await allowance()).grantedUsd).toBe(50)
    })

    it("a request is recorded by hq with the amount fixed: at most $25, more than $0", async () => {
      const id = await ask(25, "  Launch day  ")
      expect(await requestRow(id)).toMatchObject({
        amountUsd: "25.0000",
        reason: "Launch day",
        status: "pending",
        decidedAt: null,
        decidedBy: null,
      })
      // Asking grants nothing by itself.
      expect((await allowance()).grantedUsd).toBe(0)
      for (const amountUsd of [25.01, 26, 1000, 0, -1]) {
        const res = await hq.call(agentKey, "POST", "/v1/spend/grant-requests", {
          amountUsd,
          reason: "too much",
        })
        expect(res.status, String(amountUsd)).toBe(400)
      }
      const noReason = await hq.call(agentKey, "POST", "/v1/spend/grant-requests", { amountUsd: 1 })
      expect(noReason.status).toBe(400)
    })

    it("takes at most ten requests a UTC day, however they were decided, and a new day starts again", async () => {
      const ids: string[] = []
      for (let i = 0; i < 10; i++) ids.push(await ask(1, `request ${i}`))
      // Deciding some does not free places: the cap is on cards sent to the founders.
      await clickGrant(ids[0] ?? "")
      const eleventh = await hq.call(agentKey, "POST", "/v1/spend/grant-requests", {
        amountUsd: 1,
        reason: "one too many",
      })
      expect(eleventh.status).toBe(429)
      expect(eleventh.body.error.code).toBe("RATE_LIMITED")
      const today = clock.toISOString().slice(0, 10)
      const made = await hq.db.select().from(spendGrantRequests)
      expect(made.filter((r) => r.createdAt.toISOString().startsWith(today))).toHaveLength(10)

      clock = new Date(clock.getTime() + 24 * 60 * 60 * 1000)
      expect((await ask(1)) !== "").toBe(true)
    })
  })

  describe("the agent's key", () => {
    it("is not a credential for the Slack route: with no Slack signature the key changes nothing", async () => {
      const id = await propose()
      const res = await hq.slackClick({
        slackUserId: founderSlack,
        actionId: approve(id),
        signature: null,
        headers: { "x-api-key": agentKey.key },
      })
      expect(res.status).toBe(403)
      expect((await proposalOf(id))?.status).toBe("pending")
    })

    it("still cannot decide a proposal or grant spend over the API", async () => {
      const id = await propose()
      const decide = await hq.call(agentKey, "POST", `/v1/proposals/${id}/decision`, {
        decision: "approve",
      })
      expect(decide.status).toBe(403)
      const grant = await hq.call(agentKey, "POST", "/v1/spend/grants", {
        amountUsd: 5,
        reason: "the agent grants itself",
      })
      expect(grant.status).toBe(403)
      expect((await proposalOf(id))?.status).toBe("pending")
    })

    it("can call request_spend_grant, but never grant_spend or decide_proposal, even carrying grant", async () => {
      clock = new Date("2032-03-01T12:00:00Z")
      const allowed = await hq.call(agentKey, "POST", "/v1/spend/grant-requests", {
        amountUsd: 5,
        reason: "ask",
      })
      expect(allowed.status).toBe(200)
      // A key without `request` (the older agent scope) is refused.
      const older = {
        key: await hq.keyFor(founder, { hq_spend: ["read", "record"], hq_proposal: ["read"] }),
      }
      const noRequest = await hq.call(older, "POST", "/v1/spend/grant-requests", {
        amountUsd: 5,
        reason: "ask",
      })
      expect(noRequest.status).toBe(403)

      // A key minted server-side with grant and decide on it has them stripped by hq.
      const minted = {
        key: await hq.keyFor(founder, {
          hq_spend: ["grant", "request", "read"],
          hq_proposal: ["decide", "read", "create"],
        }),
      }
      const id = await propose()
      const grant = await hq.call(minted, "POST", "/v1/spend/grants", { amountUsd: 5, reason: "x" })
      expect(grant.status).toBe(403)
      const decide = await hq.call(minted, "POST", `/v1/proposals/${id}/decision`, {
        decision: "approve",
      })
      expect(decide.status).toBe(403)
      // Asking is all the key could do: nothing was granted or decided.
      expect((await allowance()).grantedUsd).toBe(0)
      expect((await proposalOf(id))?.status).toBe("pending")
      // A stranger's session (no founders row) cannot ask either.
      const stranger = await hq.signUp("not-a-founder@example.com")
      const asked = await hq.call({ cookie: stranger.cookie }, "POST", "/v1/spend/grant-requests", {
        amountUsd: 5,
        reason: "ask",
      })
      expect(asked.status).toBe(403)
    })

    it("a valid click is decided as the founder, not the key's owner by default", async () => {
      // The key belongs to the founder's organization, yet a click by a second founder records
      // that second founder.
      const second = await hq.signUp("second@example.com")
      await hq.addFounder(second, "USECOND")
      const id = await propose()
      const click = await hq.slackClick({ slackUserId: "USECOND", actionId: approve(id) })
      expect(click.status).toBe(200)
      expect((await proposalOf(id))?.decidedBy).toBe(second.userId)
    })
  })

  it("refuses everything when hq has no signing secret or no workspace configured", async () => {
    for (const config of [
      { signingSecret: undefined, teamId: TEST_SLACK_TEAM },
      { signingSecret: TEST_SLACK_SECRET, teamId: undefined },
      { signingSecret: "", teamId: TEST_SLACK_TEAM },
    ]) {
      const handle = createSlackActionHandler({ db: hq.db, now: hq.now, ...config })
      const id = await propose()
      const body = slackFormBody({
        type: "block_actions",
        team: { id: TEST_SLACK_TEAM },
        user: { id: founderSlack },
        actions: [{ action_id: approve(id) }],
      })
      const timestamp = String(Math.floor(hq.now().getTime() / 1000))
      const result = await handle({
        rawBody: body,
        timestamp,
        signature: slackSignature(TEST_SLACK_SECRET, timestamp, body),
      })
      expect(result.status).toBe(403)
      expect((await proposalOf(id))?.status).toBe("pending")
    }
  })
})

describe("a configured cap on Slack grants (HQ_SLACK_DAILY_GRANT_CAP_USD)", () => {
  let hq: Awaited<ReturnType<typeof createHqHarness>>
  let agent: { key: string }
  const slackUser = "UCAPFOUNDER"

  beforeAll(async () => {
    hq = await createHqHarness({
      founderEmails: ["cap-founder@example.com"],
      slackDailyGrantCapUsd: 12,
    })
    const founder = await hq.signUp("cap-founder@example.com")
    await hq.addFounder(founder, slackUser)
    agent = { key: await hq.keyFor(founder, { hq_spend: ["read", "request"] }) }
  })
  afterAll(() => hq.close())

  const ask = async (amountUsd: number) =>
    (
      await hq.call(agent, "POST", "/v1/spend/grant-requests", {
        amountUsd,
        reason: "a lower cap",
      })
    ).body.requestId
  const click = (id: string, cents: number) =>
    hq.slackClick({ slackUserId: slackUser, actionId: grantActionId(true, id, cents) })

  it("is honoured: $12 a day in all, whatever the default would allow", async () => {
    const [a, b, c] = [await ask(10), await ask(5), await ask(2)]
    expect((await click(a, 1000)).status).toBe(200)
    // $10 granted: $5 more would make $15 over the $12 cap, and says so in the cap's own terms.
    const refused = await click(b, 500)
    expect(refused.status).toBe(409)
    expect(refused.text).toMatch(/at most \$12\.00 a day in all.*\$10\.00 is already granted/)
    // A smaller one that fits is still redeemable: exactly $12 in all.
    expect((await click(c, 200)).status).toBe(200)
    const allowance = await hq.call(agent, "GET", "/v1/spend/allowance")
    expect((allowance.body as unknown as { grantedUsd: number }).grantedUsd).toBe(12)
  })
})

describe("the card action ids", () => {
  it("round-trip: the id carries the proposal and the version it was proposed against", () => {
    expect(parseActionId(proposalActionId("approve", "p-1", 3))).toEqual({
      kind: "proposal",
      decision: "approve",
      proposalId: "p-1",
      baseVersion: 3,
    })
    expect(parseActionId(proposalActionId("reject", "p-2", null))).toEqual({
      kind: "proposal",
      decision: "reject",
      proposalId: "p-2",
      baseVersion: null,
    })
    expect(parseActionId(grantActionId(true, "req_9", 1250))).toEqual({
      kind: "grant",
      approve: true,
      requestId: "req_9",
      cents: 1250,
    })
  })

  it("refuses anything else", () => {
    for (const id of [
      "",
      "hq_proposal_approve:p:0",
      "hq_proposal_approve:p:01",
      "hq_proposal_approve::1",
      "hq_proposal_approve:p q:1",
      "hq_proposal_delete:p:1",
      "hq_grant_approve:r:0",
      "hq_grant_approve:r:12.5",
      "eve_input:hq_proposal_approve:p:1",
      `hq_proposal_approve:${"a".repeat(65)}:1`,
    ]) {
      expect(parseActionId(id), id).toBeNull()
    }
  })
})
