import { createHmac } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { test } from "@e2e-dev/web"
import { expect } from "e2e"

import {
  E2E_SLACK_SIGNING_SECRET,
  E2E_SLACK_TEAM,
  HQ_FOUNDER_EMAIL,
  HQ_FOUNDER_PASSWORD,
  HQ_FOUNDER_SLACK_USER,
  SLACK_STACKS_DIR,
} from "./support/hq-stack"
import { uniqueId } from "./support/unique"

// An API test of founder-only Slack approvals (the `slack` target in e2e.config.ts): a Slack-signed
// click is POSTed to the lab agent's own route, which verifies it and forwards the same bytes to
// hq, and hq approves the proposal as the founder the Slack user maps to. Real hq on Postgres, the
// real agent on eve's dev server; only Slack is absent (the clicks are signed here, with the
// stack's secret). No model, no page. The other targets serve the product, so the test does
// nothing there.

interface Proposal {
  id: string
  status: string
  decidedBy: string | null
}

test("a founder's Slack click approves a proposal through the agent; a stranger's, a replay and a forgery change nothing", async ({
  app,
}) => {
  if (!app.baseUrl) throw new Error("the app has no base URL")
  const stackFile = join(SLACK_STACKS_DIR, `${new URL(app.baseUrl).port}.json`)
  if (!existsSync(stackFile)) return
  const stack = JSON.parse(readFileSync(stackFile, "utf8")) as { hqUrl: string; agentUrl: string }

  // The founder, signed in to hq.
  const signIn = await fetch(new URL("/api/auth/sign-in/email", stack.hqUrl), {
    method: "POST",
    headers: { "content-type": "application/json", origin: stack.hqUrl },
    body: JSON.stringify({ email: HQ_FOUNDER_EMAIL, password: HQ_FOUNDER_PASSWORD }),
  })
  expect(signIn.status).toBe(200)
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ")
  const hq = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const res = await fetch(new URL(path, stack.hqUrl), {
      method,
      headers: {
        cookie,
        origin: stack.hqUrl,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, json: (await res.json()) as Record<string, unknown> }
  }
  const proposal = async (id: string) =>
    ((await hq("GET", "/v1/proposals")).json.proposals as Proposal[]).find((p) => p.id === id)

  // A pending proposal to decide.
  const word = uniqueId()
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
  const proposed = await hq("POST", "/v1/proposals", {
    kind: "fact",
    slug: `slack-click-${word}`,
    title: "Slack click",
    body: { text: `Approved from Slack. ${word}` },
    reason: "e2e",
  })
  expect(proposed.status).toBe(200)
  const id = proposed.json.proposalId as string
  const approve = `hq_proposal_approve:${id}:new`

  // Where the agent answers a click (Slack's `response_url`). The agent runs offline here, so it
  // posts to loopback: this sink records what it says, and the test waits on those replies rather
  // than on the clock. Every click the agent forwards ends in exactly one reply.
  const replies: string[] = []
  const sink = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text?: string }
        replies.push(body.text ?? "")
      } catch {
        replies.push("")
      }
      response.end("ok")
    })
  })
  await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve))
  const responseUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/response`
  /** Waits until the agent has answered one more click than it had, and says what it answered. */
  const nextReply = async (answered: number) => {
    for (let i = 0; i < 100 && replies.length <= answered; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(replies.length, "the agent answered the click").toBeGreaterThan(answered)
    return replies[answered] ?? ""
  }

  /** Slack's signed POST for a click, to the agent's own route. */
  const click = (
    user: string,
    options: { badSignature?: boolean; staleBySeconds?: number } = {},
  ) => {
    const rawBody = `payload=${encodeURIComponent(
      JSON.stringify({
        type: "block_actions",
        team: { id: E2E_SLACK_TEAM },
        user: { id: user, team_id: E2E_SLACK_TEAM, name: "someone" },
        channel: { id: "C0E2E" },
        message: { ts: "1700000000.000100", thread_ts: "1700000000.000100" },
        trigger_id: `trigger-${crypto.randomUUID()}`,
        response_url: responseUrl,
        actions: [
          { action_id: approve, block_id: "b", value: approve, action_ts: `${Date.now() / 1000}` },
        ],
      }),
    )}`
    const timestamp = String(Math.floor(Date.now() / 1000) - (options.staleBySeconds ?? 0))
    const signature = options.badSignature
      ? `v0=${"0".repeat(64)}`
      : `v0=${createHmac("sha256", E2E_SLACK_SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`
    return fetch(new URL("/eve/v1/slack", stack.agentUrl), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": signature,
      },
      body: rawBody,
    })
  }
  try {
    // A forgery and a stale request are refused at the agent's door and reach nothing: no reply.
    expect((await click(HQ_FOUNDER_SLACK_USER, { badSignature: true })).status).toBe(401)
    expect((await click(HQ_FOUNDER_SLACK_USER, { staleBySeconds: 400 })).status).toBe(401)
    expect(replies).toEqual([])

    // A workspace member who is no founder: Slack signed it, so the agent takes it and forwards
    // it, and hq refuses. The agent's reply says so, and only after hq answered.
    expect((await click("UNOTAFOUNDER")).status).toBe(200)
    expect(await nextReply(0)).toMatch(/founder/i)
    expect((await proposal(id))?.status).toBe("pending")

    // The founder's click: the agent forwards the verified bytes and hq approves as that founder.
    expect((await click(HQ_FOUNDER_SLACK_USER)).status).toBe(200)
    expect(await nextReply(1)).toMatch(/approved/i)
    const decided = await proposal(id)
    expect(decided?.status).toBe("approved")
    expect(decided?.decidedBy).toEqual(expect.any(String))

    // And once only: the same click again is answered as already decided, and changes nothing.
    expect((await click(HQ_FOUNDER_SLACK_USER)).status).toBe(200)
    expect(await nextReply(2)).toMatch(/already/i)
    expect(await proposal(id)).toEqual(decided)

    // The brain now holds what the click approved.
    const search = await hq("POST", "/v1/search/entries", { query: word })
    expect((search.json.hits as unknown[]).length).toBeGreaterThan(0)
  } finally {
    sink.close()
  }
})
