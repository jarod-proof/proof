import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest"
import { createHqHarness } from "@proof/hq/src/app.test.helpers"
import { founderPrincipalsFromDb, checkFounderPrincipals } from "@proof/hq/src/slack/principals"
import {
  MAX_FUTURE_SECONDS,
  MAX_PAST_SECONDS,
  isSlackRequestAuthentic,
  slackSignature,
} from "#lib/slack/verify.js"
import {
  MAX_FUTURE_SECONDS as HQ_FUTURE,
  MAX_PAST_SECONDS as HQ_PAST,
  slackSignature as hqSlackSignature,
  verifySlackSignature as hqVerify,
} from "@proof/hq/src/slack/verify"
import { founderAnswerAuth, isFounderPrincipal } from "#lib/slack/policy.js"
import { CALLERS } from "../helpers.js"

// One source of truth for who the founders are: hq's founders table. The agent's list is derived
// from it, and these tests fail when the two disagree.

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("the agent's founder list follows hq's founders table", () => {
  let hq: Awaited<ReturnType<typeof createHqHarness>>
  const TEAM = "T0TEAM"

  beforeAll(async () => {
    hq = await createHqHarness()
    const ann = await hq.signUp("ann@example.com")
    const bob = await hq.signUp("bob@example.com")
    await hq.addFounder(ann, "UANN")
    await hq.addFounder(bob, "UBOB")
    // A workspace member who is no founder.
    await hq.signUp("carol@example.com")
  })
  afterAll(() => hq.close())

  const personAs = (principalId: string) => ({ ...CALLERS.untrusted, principalId })

  test("AGENT_FOUNDER_PRINCIPALS derived from hq admits exactly hq's founders, and no one else", async () => {
    const derived = await founderPrincipalsFromDb(hq.db, TEAM)
    expect(derived).toEqual([`slack:${TEAM}:UANN`, `slack:${TEAM}:UBOB`])
    vi.stubEnv("SLACK_ALLOWED_TEAM_IDS", TEAM)
    vi.stubEnv("AGENT_FOUNDER_PRINCIPALS", derived.join(","))
    expect(checkFounderPrincipals(derived, process.env.AGENT_FOUNDER_PRINCIPALS).ok).toBe(true)

    // The agent answers an approval from each of hq's founders...
    for (const slackUser of ["UANN", "UBOB"]) {
      expect(isFounderPrincipal(`slack:${TEAM}:${slackUser}`)).toBe(true)
      expect(founderAnswerAuth(personAs(`slack:${TEAM}:${slackUser}`))).not.toBeNull()
      // ...and hq takes their click as a founder's (a proposal it has never heard of is a 409,
      // where a non-founder gets the 403 below).
      const click = await hq.slackClick({
        slackUserId: slackUser,
        actionId: "hq_proposal_approve:no-such-proposal:new",
      })
      expect(click.status).toBe(409)
    }
    // A member hq does not know is refused by both.
    expect(isFounderPrincipal(`slack:${TEAM}:UCAROL`)).toBe(false)
    expect(founderAnswerAuth(personAs(`slack:${TEAM}:UCAROL`))).toBeNull()
    expect(
      (await hq.slackClick({ slackUserId: "UCAROL", actionId: "hq_proposal_approve:p:new" }))
        .status,
    ).toBe(403)
  })

  test("a list that has drifted from the table fails the check", async () => {
    const derived = await founderPrincipalsFromDb(hq.db, TEAM)
    // The agent lists someone hq does not: they could approve in eve what hq would refuse.
    vi.stubEnv("AGENT_FOUNDER_PRINCIPALS", [...derived, `slack:${TEAM}:UCAROL`].join(","))
    const drift = checkFounderPrincipals(derived, process.env.AGENT_FOUNDER_PRINCIPALS)
    expect(drift).toEqual({ ok: false, missing: [], extra: [`slack:${TEAM}:UCAROL`] })
    // The agent lacks a founder.
    expect(checkFounderPrincipals(derived, `slack:${TEAM}:UANN`).missing).toEqual([
      `slack:${TEAM}:UBOB`,
    ])
  })
})

describe("the agent's signature check and hq's are the same rule", () => {
  const SECRET = "slack-signing-secret-for-parity" // gitleaks:allow
  const NOW = new Date("2026-11-17T12:00:00Z")
  const base = Math.floor(NOW.getTime() / 1000)
  const body = "payload=%7B%22a%22%3A1%7D"

  test("same windows and same signatures", () => {
    expect([MAX_PAST_SECONDS, MAX_FUTURE_SECONDS]).toEqual([HQ_PAST, HQ_FUTURE])
    const cases: { timestamp: string; signature: (t: string) => string }[] = []
    for (const offset of [0, -299, -300, -301, 59, 60, 61, 100000]) {
      const timestamp = String(base + offset)
      cases.push({ timestamp, signature: (t) => slackSignature(SECRET, t, body) })
      cases.push({ timestamp, signature: () => `v0=${"0".repeat(64)}` })
      cases.push({
        timestamp,
        signature: (t) => slackSignature(SECRET, t, body).replace("v0=", "v1="),
      })
      cases.push({ timestamp, signature: (t) => slackSignature(SECRET, t, body).toUpperCase() })
    }
    for (const bad of ["", "abc", " 1", "1.5", "-1"]) {
      cases.push({ timestamp: bad, signature: () => slackSignature(SECRET, bad, body) })
    }
    for (const c of cases) {
      const signature = c.signature(c.timestamp)
      const agent = isSlackRequestAuthentic({
        rawBody: body,
        signature,
        timestamp: c.timestamp,
        secret: SECRET,
        now: NOW,
      })
      const hq = hqVerify({
        rawBody: body,
        signature,
        timestamp: c.timestamp,
        secret: SECRET,
        now: NOW,
      }).ok
      expect(agent, `${c.timestamp} ${signature}`).toBe(hq)
    }
    expect(slackSignature(SECRET, "1", body)).toBe(hqSlackSignature(SECRET, "1", body))
  })
})
