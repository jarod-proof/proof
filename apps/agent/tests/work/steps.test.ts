import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { NOTE_MAX_CHARS } from "@proof/hq/src/work/constants"
import { FatalError } from "eve/workflow"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest"
import { log } from "#lib/log.js"
import {
  ATTEMPT_CAPS,
  beginStation,
  endStation,
  failStation,
  stationKey,
  subjectOf,
  summarizeStation,
} from "#lib/work/attempts.js"
import { recorderStats, resetRecorderStats } from "#lib/work/recorder.js"
import { createHqFixture, type HqFixture } from "../hq/hq-fixture.js"
import {
  callOf,
  detailOf,
  eventsOf,
  newItem,
  SHA,
  setupFix,
  toPlan,
  useRealHq,
} from "./attempts-support.js"

/**
 * Replay and retry, pinned without a runtime. eve reuses a step's recorded result when a workflow
 * body replays after `sleep()`, and retries a step that throws; so each step is called here twice
 * with the same arguments, which is exactly what a replay (it would not even call the step) or a
 * retry or a second eve run of one call does, and the item must hold what one call would leave.
 */
let hq: HqFixture

beforeAll(async () => {
  hq = await createHqFixture()
}, 60_000)

afterAll(async () => {
  await hq.close()
})

beforeEach(() => {
  resetRecorderStats()
  vi.spyOn(log, "warn").mockImplementation(() => undefined)
  useRealHq(hq)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const issue = (n: number) => ({ kind: "issue", issueNumber: n }) as const
const droppedLogs = () =>
  vi.mocked(log.warn).mock.calls.filter(([m]) => m === "work_record_dropped")

describe("idempotent steps", () => {
  test("beginStation called twice with one call (a replay or a retry) returns the same attemptId and the item holds exactly one attempt", async () => {
    const { itemId, n } = await newItem(hq)
    const call = callOf("analyst", issue(n))
    const first = await beginStation(call)
    const second = await beginStation(call)
    expect(first).not.toBeNull()
    expect(second).toEqual(first)
    expect((await detailOf(hq, itemId)).attemptList).toHaveLength(1)

    const fixItem = await newItem(hq)
    await toPlan(hq, fixItem.itemId)
    const fixCall = callOf("implementer", issue(fixItem.n), { attemptLimit: 3 })
    const a = await beginStation(fixCall)
    const b = await beginStation(fixCall)
    expect(b).toEqual(a)
    expect(
      (await detailOf(hq, fixItem.itemId)).attemptList.filter((x) => x.kind === "fix"),
    ).toHaveLength(1)
  })

  test("a replay after the attempt finished returns the stored attempt and moves nothing", async () => {
    const { itemId, n } = await newItem(hq)
    const call = callOf("analyst", issue(n))
    const first = await beginStation(call)
    await endStation(first, summarizeStation("analyst", { acceptance_criteria: ["a"] }))
    const before = (await eventsOf(hq, itemId)).length
    expect(await beginStation(call)).toEqual(first)
    expect((await eventsOf(hq, itemId)).length).toBe(before)
    expect((await detailOf(hq, itemId)).attemptList).toHaveLength(1)
  })

  test("endStation called twice with the same summary is a no-op the second time", async () => {
    // analyst: the contract is written once.
    const a = await newItem(hq)
    const ar = await beginStation(callOf("analyst", issue(a.n)))
    const analysis = summarizeStation("analyst", { acceptance_criteria: ["Works", "Is tested"] })
    await endStation(ar, analysis)
    const afterOne = (await eventsOf(hq, a.itemId)).length
    await endStation(ar, analysis)
    expect((await eventsOf(hq, a.itemId)).length).toBe(afterOne)
    expect((await detailOf(hq, a.itemId)).contract).toHaveLength(3)

    // implementer, then reviewer: a second run changes nothing.
    const b = await newItem(hq)
    await toPlan(hq, b.itemId)
    const ir = await beginStation(callOf("implementer", issue(b.n), { attemptLimit: 3 }))
    const built = summarizeStation("implementer", {
      pushed: true,
      branch: "agent/x",
      change_summary: [{ path: "a.ts", change: "c" }],
      known_limitations: [],
    })
    await endStation(ir, built)
    await endStation(ir, built)
    const rr = await beginStation(callOf("reviewer", issue(b.n), { callId: "call-2" }))
    const verdict = summarizeStation(
      "reviewer",
      { verdict: "approve", summary: "ok", blocking_findings: [] },
      { headSha: SHA },
    )
    await endStation(rr, verdict)
    const settled = (await eventsOf(hq, b.itemId)).length
    const attempt = (await detailOf(hq, b.itemId)).attemptList.at(-1)
    await endStation(rr, verdict)
    expect((await eventsOf(hq, b.itemId)).length).toBe(settled)
    expect((await detailOf(hq, b.itemId)).attemptList.at(-1)).toEqual(attempt)
    // The heartbeat of the implementer after the reviewer finished is an echo too: no log.
    await endStation(ir, built)
    expect(droppedLogs()).toHaveLength(0)
    expect(recorderStats().dropped).toBe(0)
  })

  test("a conflict that is not an echo of the same result is logged work_record_dropped and counted, not swallowed", async () => {
    const { itemId, n } = await newItem(hq)
    await toPlan(hq, itemId)
    const record = await beginStation(callOf("implementer", issue(n), { attemptLimit: 3 }))
    await failStation(record, "the sandbox died")
    resetRecorderStats()
    vi.mocked(log.warn).mockClear()
    // The attempt already finished failed; a reviewer approve now is a different result.
    await endStation(
      record,
      summarizeStation("reviewer", { verdict: "approve", summary: "ok", blocking_findings: [] }),
    )
    expect(recorderStats()).toMatchObject({ dropped: 1, conflicts: 1 })
    expect(droppedLogs()).toHaveLength(1)
    expect(droppedLogs()[0]?.[1]).toMatchObject({ kind: "conflict" })
    expect((await detailOf(hq, itemId)).attemptList.at(-1)).toMatchObject({ result: "failed" })

    // And a heartbeat for an attempt that finished with other files is not an echo either.
    resetRecorderStats()
    await endStation(
      record,
      summarizeStation("implementer", {
        pushed: true,
        branch: "agent/other",
        change_summary: [{ path: "z.ts", change: "c" }],
        known_limitations: [],
      }),
    )
    expect(recorderStats().conflicts).toBe(1)
  })
})

describe("hq down", () => {
  test("every step returns null and nothing throws; with a successful read at the limit beginStation throws FatalError outside recordSafely, and with the read failed it does not throw", async () => {
    const { itemId, n } = await newItem(hq)
    await toPlan(hq, itemId)
    await setupFix(hq, itemId, { limit: 3 })
    await setupFix(hq, itemId)
    await setupFix(hq, itemId)
    const call = callOf("implementer", issue(n), { attemptLimit: 3 })

    // The read succeeds and the budget is spent: the one deliberate throw.
    const atLimit = await beginStation(call).catch((e: unknown) => e)
    expect(atLimit).toBeInstanceOf(FatalError)

    // The item read fails (every GET of an item by id): nothing is known, the build proceeds.
    const bridge = useRealHq(hq, (method, path) =>
      method === "GET" && /^\/v1\/work-items\/[0-9a-f-]{36}$/.test(path)
        ? "unavailable"
        : undefined,
    )
    resetRecorderStats()
    await expect(beginStation(call)).resolves.toBeNull()
    expect(bridge.requests.some((r) => r.startsWith("GET /v1/work-items/"))).toBe(true)
    expect(recorderStats().dropped).toBeGreaterThan(0)

    // hq entirely unreachable: every step returns and nothing throws.
    useRealHq(hq, () => "unreachable")
    await expect(beginStation(call)).resolves.toBeNull()
    const record = { itemId, attemptId: "a", kind: "fix" as const, key: `s:c:reviewer` }
    await expect(
      endStation(
        record,
        summarizeStation("reviewer", { verdict: "reject", blocking_findings: ["x"] }),
      ),
    ).resolves.toBeUndefined()
    await expect(failStation(record, "x")).resolves.toBeUndefined()
  })
})

describe("a lost response", () => {
  test("a start whose first response is lost (committed in hq, timed out in the client) returns the same attempt on the same-key inline retry, and a second timeout gives up with one attempt in hq", async () => {
    const lostOnce = await newItem(hq)
    await toPlan(hq, lostOnce.itemId)
    let losses = 0
    useRealHq(hq, (method, path) =>
      method === "POST" && path.endsWith("/attempts") && losses++ < 1 ? "lose-response" : undefined,
    )
    const record = await beginStation(callOf("implementer", issue(lostOnce.n), { attemptLimit: 3 }))
    expect(record).not.toBeNull()
    const attempts = (await detailOf(hq, lostOnce.itemId)).attemptList.filter(
      (a) => a.kind === "fix",
    )
    expect(attempts).toHaveLength(1)
    expect(record?.attemptId).toBe(attempts[0]?.id)

    const lostTwice = await newItem(hq)
    await toPlan(hq, lostTwice.itemId)
    const bridge = useRealHq(hq, (method, path) =>
      method === "POST" && path.endsWith("/attempts") ? "lose-response" : undefined,
    )
    resetRecorderStats()
    expect(
      await beginStation(callOf("implementer", issue(lostTwice.n), { attemptLimit: 3 })),
    ).toBeNull()
    // Exactly two starts were sent (the first and the one inline retry), and hq holds one attempt.
    expect(
      bridge.requests.filter((r) => r.endsWith("/attempts") && r.startsWith("POST")),
    ).toHaveLength(2)
    expect(
      (await detailOf(hq, lostTwice.itemId)).attemptList.filter((a) => a.kind === "fix"),
    ).toHaveLength(1)
    expect(recorderStats().unavailable).toBe(1)
  })
})

describe("what is sent to hq is bounded and storable", () => {
  test("the caps are the ones hq enforces", async () => {
    const hqConstants = await import("@proof/hq/src/work/constants")
    const contract = await import("@proof/hq/src/data/contract")
    expect(ATTEMPT_CAPS).toEqual({
      note: hqConstants.NOTE_MAX_CHARS,
      files: hqConstants.FILES_MAX,
      file: hqConstants.FILE_MAX_CHARS,
      branch: hqConstants.BRANCH_MAX_CHARS,
      contractItems: contract.CONTRACT_ITEMS_MAX,
      contractText: contract.CONTRACT_TEXT_MAX_CHARS,
      failure: 500,
    })
  })

  test("an oversized or unstorable station output is cut and scrubbed so hq takes it (a NUL byte, a lone surrogate, 500 files)", async () => {
    const { itemId, n } = await newItem(hq)
    await toPlan(hq, itemId)
    const record = await beginStation(callOf("implementer", issue(n), { attemptLimit: 3 }))
    const summary = summarizeStation("implementer", {
      pushed: true,
      branch: `agent/${"b".repeat(400)}`,
      change_summary: Array.from({ length: 500 }, (_, i) => ({
        path: `src/${i}\u0000${"p".repeat(600)}`,
        change: "c",
      })),
      known_limitations: [],
    })
    expect(summary.station === "implementer" && summary.files.length).toBe(ATTEMPT_CAPS.files)
    await endStation(record, summary)
    expect(recorderStats().dropped).toBe(0)
    const fix = (await detailOf(hq, itemId)).attemptList.at(-1)
    expect(fix?.files).toHaveLength(ATTEMPT_CAPS.files)
    expect(fix?.branch?.length).toBeLessThanOrEqual(ATTEMPT_CAPS.branch)

    await endStation(
      record,
      summarizeStation(
        "reviewer",
        {
          verdict: "request_changes",
          summary: `bad \ud800 ${"s".repeat(5000)}`,
          blocking_findings: [`nul \u0000 ${"f".repeat(5000)}`],
        },
        { headSha: "not a sha" },
      ),
    )
    expect(recorderStats().dropped).toBe(0)
    const done = (await detailOf(hq, itemId)).attemptList.at(-1)
    expect(done).toMatchObject({ result: "rejected" })
    expect(done?.note?.length).toBeLessThanOrEqual(NOTE_MAX_CHARS)
    // A head sha that is not a commit id is left out, never allowed to lose the verdict.
    expect(done?.reviewer?.headSha).toBeUndefined()
  })
})

describe("no hq call in a workflow body", () => {
  const root = join(import.meta.dirname, "../..")
  const read = (file: string) => readFileSync(join(root, "agent/lib/work", file), "utf8")
  const attemptsSource = read("attempts.ts")
  const sharedSource = read("attempts-shared.ts")
  const recordSource = read("attempts-record.ts")

  test("the three steps open with the use step directive, and adoptOrStartAttempt is no step of its own", () => {
    for (const name of ["beginStation", "endStation", "failStation"]) {
      const body = attemptsSource.split(new RegExp(`export async function ${name}\\(`))[1] ?? ""
      expect(body.split("{")[1]?.trimStart().startsWith('"use step"'), name).toBe(true)
    }
    const adopt = sharedSource.split(/export async function adoptOrStartAttempt\(/)[1] ?? ""
    expect(adopt.split("{")[1]).not.toContain('"use step"')
  })

  test("the pure functions a workflow body calls reach no hq client, no environment and no logger", () => {
    for (const fn of [subjectOf, summarizeStation, stationKey]) {
      const text = fn.toString()
      expect(text).not.toMatch(
        /hookHq|createHqClient|hqFromEnv|process\.env|agentEnv|recordSafely|log\./,
      )
    }
  })

  test("no tool body calls hq: the tools import no hq client and no recorder", () => {
    const tools = join(root, "agent/tools")
    for (const file of readdirSync(tools).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(join(tools, file), "utf8")
      expect(text, file).not.toMatch(/lib\/hq\/|lib\/work\/recorder|HqClient|hqFromEnv|hookHq/)
    }
  })

  test("the files a workflow body may import reach no Node built-in, no recorder, no logger and no environment, transitively", () => {
    // `attempts.ts` imports these (the pure half, re-exported); every import that survives the step
    // transform is bundled into the workflow, which refuses Node built-ins (pino reaches node:os).
    // Walk the relative imports from the pure half and check every specifier on the way.
    const allowedPackages = new Set(["zod", "eve/context", "eve/workflow"])
    const forbidden = /recorder|\/log\.js|@lab\/|constants\.js|^node:|^fs$|^path$|^os$/
    const seen = new Set<string>()
    const walk = (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      const source = readFileSync(file, "utf8")
      expect(source, file).not.toMatch(/process\.env/)
      if (!file.endsWith("hq/client.ts")) {
        expect(source, file).not.toMatch(/createHqClient/)
      }
      for (const match of source.matchAll(/(?:^|\n)(?:import|export)[^;]*?from\s+"([^"]+)"/g)) {
        const specifier = match[1] ?? ""
        expect(specifier, `${file} imports ${specifier}`).not.toMatch(forbidden)
        if (specifier.startsWith(".")) {
          walk(join(dirname(file), specifier.replace(/\.js$/, ".ts")))
        } else {
          expect(allowedPackages.has(specifier), `${file} imports ${specifier}`).toBe(true)
        }
      }
    }
    walk(join(root, "agent/lib/work/attempts-shared.ts"))
    walk(join(root, "agent/lib/work/storable.ts"))
    // The walk reaches the hq client and the trust helpers, and nothing else.
    expect([...seen].map((file) => file.slice(root.length + 1)).sort()).toEqual([
      "agent/lib/hq/client.ts",
      "agent/lib/trust.ts",
      "agent/lib/work/attempts-shared.ts",
      "agent/lib/work/storable.ts",
    ])
    // And what `attempts.ts` itself keeps after its three steps are stripped.
    const surviving = attemptsSource.replace(/"use step"[\s\S]*?\n}\n/g, "")
    expect(surviving).not.toMatch(
      /recordSafely\(|recordDropped\(|stepHq\(|findItem\(|recordEnd\(|recordFail\(/,
    )
  })

  test("only a step reaches hq: the client is built in one place and only the four steps call it", () => {
    expect(recordSource.match(/createHqClient\(/g) ?? []).toHaveLength(1)
    expect(attemptsSource).not.toMatch(/createHqClient/)
    expect(sharedSource).not.toMatch(/createHqClient/)
    expect([...attemptsSource.matchAll(/: stepHq\(\)/g)]).toHaveLength(4)
  })
})
