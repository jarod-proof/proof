import { defineEval } from "eve/evals"
import { satisfies } from "eve/evals/expect"
import { ticketIdFor } from "../../agent/lib/intake/ticket.js"
import { ATTEMPT_LIMIT_MESSAGE } from "../../agent/lib/work/attempts.js"
import { READ_SHA } from "../../agent/lib/offline/responder.js"
import { freshDay, hq, OFFLINE_TAG, probeEvents } from "../offline.js"

/**
 * The three station wrappers on the real runtime: the real eve workflow bundle (the steps compile
 * and run as steps), the real hq app behind its HTTP
 * surface, and scripted models (no model call). Each scenario is its own intake ticket, so its own
 * session; no replay is forced (the real wrappers have no sleep, and a replay is invisible by design);
 * the session finds its work item through the attempt a dispatcher would have claimed
 * (`externalRef` = the ticket id), exactly as a ticket run does in production.
 *
 * - `ok`: analyst, implementer and reviewer in order leave one investigate attempt and one fix
 *   attempt (approved), a contract, in that order; every step ran once per call.
 * - `fail`: a station that fails finishes its attempt `failed` and the orchestrator gets the
 *   station's own error.
 * - `limit`: an item with its fix attempts used up: the limit error reaches the orchestrator as it
 *   is, no station runs and no attempt row is written for it (no failStation step either).
 * - `ask`: `ask_founder` in the session that started the fix ends that fix `needs_answer` and
 *   leaves an open question, and the fix no longer counts as used.
 */

const REPO = "acme/widgets"
const stamp = Date.now()
let counter = 0

interface Setup {
  itemId: string
  /** What the ticket is submitted under, and the id the intake derives from it. */
  externalId: string
  ticketId: string
}

type Client = ReturnType<typeof hq>

/** An item in triage, and the id of a ticket nobody has sent yet. */
async function newItem(client: Client, scenario: string): Promise<Setup> {
  const n = stamp + ++counter
  const { itemId } = await client.recordSignal({
    source: "github_issue",
    externalId: `${REPO}#${n}:opened:eval`,
    dedupeKey: `github-issue:${REPO}#${n}`,
    repo: REPO,
    title: `Totals ignore tax (${scenario})`,
    summary: `GitHub issue #${n} opened by a maintainer`,
    payload: { number: n },
  })
  const externalId = `records-attempts-${scenario}-${n}`
  // The local dev server's caller is `local-dev`; the intake hashes it with the external id.
  return { itemId, externalId, ticketId: ticketIdFor("local-dev", externalId) }
}

/** What a dispatcher's claim leaves: an attempt of the item whose `externalRef` is the ticket id. */
async function claimed(client: Client, setup: Setup, kind: "investigate" | "fix") {
  return client.startAttempt({
    itemId: setup.itemId,
    kind,
    externalRef: setup.ticketId,
    ...(kind === "fix" ? { attemptLimit: 3 } : {}),
  })
}

/** An item in plan with a contract, as an analysis leaves it. */
async function planned(client: Client, setup: Setup): Promise<void> {
  const investigation = await claimed(client, setup, "investigate")
  await client.finishAttempt({ attemptId: investigation.id, result: "investigated" })
  await client.setContract({
    itemId: setup.itemId,
    items: [{ text: "Checkout totals include tax", verifier: { kind: "reviewer" } }],
  })
}

export default defineEval({
  description:
    "The station wrappers record on the real runtime and the real hq: one investigate and one fix attempt and a contract in order with each step run once per call, a failing station finishes its attempt failed and rethrows its own error, the attempt limit error reaches the orchestrator with no attempt row, and ask_founder ends the asking fix needs_answer.",
  tags: [OFFLINE_TAG],
  async test(t) {
    await freshDay()
    const client = hq()

    /** Sends one ticket and reads the session's turn. */
    async function run(setup: Setup, scenario: string) {
      const reply = await t.target.fetch("/intake/v1/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: `records-attempts ${scenario}`,
          body: `[records-attempts:${scenario}] Fix the totals.`,
          externalId: setup.externalId,
        }),
      })
      const { sessionId } = (await reply.json()) as { sessionId: string }
      return { sessionId, turn: await t.target.attach(sessionId).nextTurn() }
    }

    const settled = (sent: Awaited<ReturnType<typeof run>>, tool: string) =>
      sent.turn.events.find(
        (e) =>
          e.type === "call.settled" &&
          // the call that named this tool
          sent.turn.events.some(
            (r) =>
              r.type === "call.requested" &&
              (r.data as { callId: string; capability: { name: string } }).callId ===
                (e.data as { callId: string }).callId &&
              (r.data as { capability: { name: string } }).capability.name === tool,
          ),
      )?.data as { outcome: string; output?: unknown; error?: { message: string } } | undefined

    const steps = async () =>
      (await probeEvents())
        .filter((e) => e.event === "attempt-step")
        .map((e) => e.detail as { step: string; station?: string; callId?: string })

    // ---- ok: the whole line, in order -----------------------------------------------------------
    const ok = await newItem(client, "ok")
    await claimed(client, ok, "investigate")
    const okRun = await run(ok, "ok")
    t.check(
      okRun.turn.status,
      satisfies((s: string) => s === "completed", "the pipeline turn completed"),
    )
    const okItem = await client.getWorkItem({ itemId: ok.itemId })
    t.check(
      okItem.attemptList.map((a) => [a.number, a.kind, a.status, a.result]),
      satisfies(
        (rows: unknown[]) =>
          JSON.stringify(rows) ===
          JSON.stringify([
            [1, "investigate", "finished", "investigated"],
            [2, "fix", "finished", "approved"],
          ]),
        "exactly one investigate attempt then one fix attempt, approved, in order",
      ),
    )
    t.check(
      okItem.contract.map((c) => c.text),
      satisfies(
        (rows: string[]) =>
          rows.length === 3 &&
          rows[0] === "Checkout totals include tax" &&
          rows[2] === "No new signal like this in the verification window",
        "the contract is the analyst's criteria plus the recurrence item",
      ),
    )
    t.check(
      okItem.attempts,
      satisfies(
        (a: { limit: number | null }) => a.limit === 3,
        "the fix was started with MAX_ATTEMPTS_PER_ITEM as its limit",
      ),
    )
    const fix = okItem.attemptList.find((a) => a.kind === "fix")
    t.check(
      fix,
      satisfies(
        (a: (typeof okItem.attemptList)[number] | undefined) =>
          a?.branch === "agent/fix-tax" &&
          a.files.includes("src/totals.ts") &&
          a.externalRef?.startsWith(`${okRun.sessionId}:`) === true &&
          a.externalRef.endsWith(":implementer") &&
          a.reviewer?.verdict === "approve",
        "the fix carries the branch, the files, the session's key and the reviewer's verdict",
      ),
    )
    t.check(
      fix?.reviewer?.headSha,
      satisfies(
        (sha: string | undefined) => sha === READ_SHA,
        "the commit the reviewer read is stored with its verdict (reviewed_head_sha)",
      ),
    )
    // A pull request that shows up at another head than the one the reviewer read is not what it
    // approved: hq asks nobody to merge it.
    await client.recordPullRequest({
      branch: fix?.branch ?? "",
      number: stamp % 1_000_000,
      url: `https://github.com/${REPO}/pull/${stamp % 1_000_000}`,
      base: "main",
      headSha: "c".repeat(40),
      isDraft: false,
      state: "open",
    })
    t.check(
      (await client.getWorkItem({ itemId: ok.itemId })).mergeApproval,
      satisfies(
        (approval: unknown) => approval === null,
        "a pull request at a different head than the reviewed one gets no merge approval",
      ),
    )
    const okSteps = await steps()
    t.check(
      okSteps,
      satisfies(
        (rows: { step: string; station?: string }[]) =>
          JSON.stringify(rows.map((r) => `${r.step}:${r.station ?? ""}`)) ===
          JSON.stringify([
            "beginStation:analyst",
            "endStation:analyst",
            "beginStation:implementer",
            "endStation:implementer",
            "beginStation:reviewer",
            "endStation:reviewer",
          ]),
        "each step ran exactly once per call (replay reuses a recorded step result: the SDK's contract, not observed here)",
      ),
    )

    // ---- fail: the station's own error, recorded and rethrown --------------------------------------
    await freshDay()
    const bad = await newItem(client, "fail")
    await claimed(client, bad, "investigate")
    const failRun = await run(bad, "fail")
    const failed = settled(failRun, "run_analyst")
    const failedItem = await client.getWorkItem({ itemId: bad.itemId })
    t.check(
      failed,
      satisfies(
        (c: typeof failed) =>
          c?.outcome === "failed" &&
          (c.error?.message ?? "").startsWith("The analyst station failed: "),
        "the orchestrator got the station's own tool error",
      ),
    )
    t.check(
      failedItem.attemptList.map((a) => [a.kind, a.status, a.result, a.note]),
      satisfies(
        (rows: unknown[][]) =>
          rows.length === 1 &&
          rows[0]?.[0] === "investigate" &&
          rows[0]?.[1] === "finished" &&
          rows[0]?.[2] === "failed" &&
          rows[0]?.[3] === failed?.error?.message,
        "the one attempt finished failed with that same error text",
      ),
    )
    t.check(
      (await steps()).map((r) => r.step),
      satisfies(
        (rows: string[]) => rows.join(",") === "beginStation,failStation",
        "failStation ran once and endStation did not",
      ),
    )

    // ---- limit: the FatalError reaches the orchestrator, no failStation, no row ------------------------
    await freshDay()
    const spent = await newItem(client, "limit")
    await planned(client, spent)
    for (let i = 0; i < 3; i++) {
      const attempt = await client.startAttempt({
        itemId: spent.itemId,
        kind: "fix",
        externalRef: `setup:${spent.itemId}:fix:${i}`,
        ...(i === 0 ? { attemptLimit: 3 } : {}),
      })
      await client.finishAttempt({ attemptId: attempt.id, result: "failed", note: "setup" })
    }
    const before = await client.getWorkItem({ itemId: spent.itemId })
    const limitRun = await run(spent, "limit")
    const limited = settled(limitRun, "run_implementer")
    const after = await client.getWorkItem({ itemId: spent.itemId })
    t.check(
      limited,
      satisfies(
        (c: typeof limited) =>
          c?.outcome === "failed" &&
          (c.error?.message === ATTEMPT_LIMIT_MESSAGE || c.output === ATTEMPT_LIMIT_MESSAGE),
        "the orchestrator got the limit error as it is",
      ),
    )
    t.check(
      after.attemptList.map((a) => [a.number, a.status, a.result, a.note]),
      satisfies(
        (rows: unknown[]) =>
          JSON.stringify(rows) ===
            JSON.stringify(before.attemptList.map((a) => [a.number, a.status, a.result, a.note])) &&
          rows.length === 4,
        "no attempt row was written for the refused call, and none was marked failed",
      ),
    )
    t.check(
      (await steps()).map((r) => r.step),
      satisfies(
        (rows: string[]) => rows.join(",") === "beginStation",
        "the limit FatalError was never given to failStation",
      ),
    )

    // ---- ask: ask_founder ends the fix the session started -------------------------------------------
    await freshDay()
    const asker = await newItem(client, "ask")
    await planned(client, asker)
    const askRun = await run(asker, "ask")
    const asked = await client.getWorkItem({ itemId: asker.itemId })
    const askFix = asked.attemptList.find((a) => a.kind === "fix")
    t.check(
      askFix,
      satisfies(
        (a: (typeof asked.attemptList)[number] | undefined) =>
          a?.status === "finished" &&
          a.result === "needs_answer" &&
          a.externalRef?.startsWith(`${askRun.sessionId}:`) === true,
        "the fix the session started was ended needs_answer by ask_founder",
      ),
    )
    t.check(
      asked.questions.map((q) => [q.status, q.attemptId === askFix?.id, q.defaultOptionId]),
      satisfies(
        (rows: unknown[][]) =>
          rows.length === 1 &&
          rows[0]?.[0] === "open" &&
          rows[0][1] === true &&
          rows[0][2] === "patch",
        "one open question, tied to that fix, with its recommended option",
      ),
    )
    t.check(
      asked.attempts,
      satisfies(
        (a: { used: number; running: boolean }) => a.used === 0 && !a.running,
        "a fix that asked does not count as used",
      ),
    )
  },
  timeoutMs: 300_000,
})
