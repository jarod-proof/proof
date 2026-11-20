import { createHqHarness } from "@proof/hq/src/app.test.helpers"
import { createHqClient, type HqClient } from "#lib/hq/client.js"

/**
 * The real hq (its registry, its auth, its spend ledger) on in-process Postgres (PGlite), and the
 * agent's client talking to it over the same HTTP surface a deployed agent uses.
 *
 * @remarks
 * Nothing about hq is faked: a path the client gets wrong is a 404 here, a scope the key lacks is a
 * 403, and the cap is hq's own arithmetic. The agent's key has exactly the scope the plan gives it.
 */

/** What the agent's hq key may do: read all, propose, runs and spend only. */
export const AGENT_KEY_SCOPE = {
  hq_entry: ["read"],
  hq_proposal: ["read", "create"],
  hq_run: ["read", "create", "update"],
  hq_spend: ["read", "record", "request"],
}

export const HQ_BASE_URL = "http://localhost:3100"

/** The founder's Slack user in hq's founders table, and the signing secret and workspace hq accepts. */
export const FOUNDER_SLACK_USER = "UFOUNDER"
export { TEST_SLACK_SECRET, TEST_SLACK_TEAM } from "@proof/hq/src/app.test.helpers"

/** The parts of an hq reply these tests read. */
export interface HqJson {
  error?: { code: string; message: string }
  proposals?: { id: string; status: string }[]
  runs?: { id: string; costUsd: number; costEstimated: boolean; outcome: string | null }[]
  id?: string
}

export interface HqReply {
  status: number
  body: HqJson
}

type Call = (method: "GET" | "POST", path: string, body?: unknown) => Promise<HqReply>

export interface HqFixture {
  /** The agent's client, on the agent's key. */
  client: HqClient
  /** The fetch behind the client: an in-process hq. */
  fetch: typeof fetch
  /** Calls hq as the agent's key (for what the client has no method for, and for refusals). */
  asAgent: Call
  /** Calls hq as the signed-in founder. */
  asFounder: Call
  /** The founder's Slack user id, as hq's founders table holds it. */
  founderSlack: string
  /** hq's clock: what a Slack request must be signed near. */
  now: () => Date
  /** Moves hq's clock to the start of a fresh UTC day, so a test starts with an empty ledger. */
  newDay: () => void
  close: () => Promise<void>
}

export async function createHqFixture(): Promise<HqFixture> {
  let day = 0
  let now = new Date(Date.UTC(2031, 0, 1, 12))
  const hq = await createHqHarness({ now: () => now })
  const person = await hq.signUp("founder@example.com")
  const founderSlack = await hq.addFounder(person, FOUNDER_SLACK_USER)
  const key = await hq.keyFor(person, AGENT_KEY_SCOPE)

  const inProcess: typeof fetch = (input, init) =>
    Promise.resolve(hq.app.request(String(input), init))
  const client = createHqClient({ baseUrl: HQ_BASE_URL, apiKey: key, fetch: inProcess })
  const as =
    (credential: { key: string } | { cookie: string }): Call =>
    async (method, path, body) => {
      const reply = await hq.call(credential, method, path, body)
      return { status: reply.status, body: reply.body as HqJson }
    }
  return {
    client,
    fetch: inProcess,
    asAgent: as({ key }),
    asFounder: as({ cookie: person.cookie }),
    founderSlack,
    now: () => now,
    newDay: () => {
      now = new Date(Date.UTC(2031, 0, ++day + 1, 12))
    },
    close: () => hq.close(),
  }
}
