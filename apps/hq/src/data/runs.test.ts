import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createHqTestDb } from "../testing"
import { toUnits } from "./money"
import { finishRun, getRun, listRuns, recordRun } from "./runs"
import { recordSpend } from "./spend"

const NOW = new Date("2026-11-17T12:00:00Z")

describe("runs", () => {
  let test: Awaited<ReturnType<typeof createHqTestDb>>
  beforeAll(async () => {
    test = await createHqTestDb()
  })
  afterAll(async () => {
    await test.close()
  })

  it("finish_run stores worked/failed/stop and the run's total cost is the sum of its spend", async () => {
    const { id } = await recordRun(test.db, {
      task: "nightly digest",
      trigger: "schedule",
      runner: "eve",
      now: NOW,
    })
    await recordSpend(test.db, {
      runId: id,
      source: "eve",
      amount: toUnits(0.1234),
      model: "a",
      now: NOW,
    })
    await recordSpend(test.db, {
      runId: id,
      source: "eve",
      amount: toUnits(0.2),
      model: "b",
      now: NOW,
    })
    const other = await recordRun(test.db, { task: "other", trigger: "x", runner: "box", now: NOW })
    await recordSpend(test.db, {
      runId: other.id,
      source: "box",
      amount: toUnits(5),
      model: "c",
      now: NOW,
    })

    const summary = { worked: ["posted the digest"], failed: ["one card"], stop: ["cap reached"] }
    const finished = await finishRun(test.db, {
      id,
      outcome: "stopped",
      summary,
      now: new Date(NOW.getTime() + 1000),
    })
    expect(finished).toMatchObject({
      outcome: "stopped",
      summary,
      cost: toUnits(0.3234),
      costEstimated: false,
    })
    expect(finished.endedAt).toEqual(new Date(NOW.getTime() + 1000))
    expect(finished.cost).toBe(3234)
  })

  it("a run's cost says when part of it is an estimate; a run with no spend costs 0", async () => {
    const { id } = await recordRun(test.db, { task: "t", trigger: "x", runner: "eve", now: NOW })
    expect((await getRun(test.db, id)).cost).toBe(0)
    await recordSpend(test.db, {
      runId: id,
      source: "eve",
      estimate: toUnits(0.05),
      model: "m",
      now: NOW,
    })
    expect(await getRun(test.db, id)).toMatchObject({ cost: 500, costEstimated: true })
  })

  it("finishing twice is a CONFLICT and keeps the first outcome; an unknown run is NOT_FOUND", async () => {
    const { id } = await recordRun(test.db, {
      task: "t",
      trigger: "x",
      runner: "sandbox",
      now: NOW,
    })
    const summary = { worked: [], failed: [], stop: [] }
    await finishRun(test.db, { id, outcome: "succeeded", summary, now: NOW })
    await expect(
      finishRun(test.db, { id, outcome: "failed", summary, now: NOW }),
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect((await getRun(test.db, id)).outcome).toBe("succeeded")
    await expect(
      finishRun(test.db, { id: "nope", outcome: "failed", summary, now: NOW }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("lists runs newest first, a page at a time", async () => {
    const t = (m: number) => new Date(Date.UTC(2150, 0, 1, 0, m))
    const ids: string[] = []
    for (let m = 0; m < 3; m++) {
      ids.push(
        (await recordRun(test.db, { task: `p${m}`, trigger: "x", runner: "eve", now: t(m) })).id,
      )
    }
    const first = await listRuns(test.db, { limit: 2 })
    expect(first.map((r) => r.id)).toEqual([ids[2], ids[1]])
    const second = await listRuns(test.db, { after: { at: t(1), id: ids[1] as string }, limit: 2 })
    expect(second[0]?.id).toBe(ids[0])
  })
})
