import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { assertDisposableDatabase, databaseName } from "../../../scripts/e2e-hq-guard.mjs"

const SCRIPT = fileURLToPath(new URL("../../../scripts/e2e-hq-stack.mjs", import.meta.url))
const url = (name: string) => `postgres://u:p@localhost:5432/${name}`

// The e2e hq stack clears rate_limit and verifies an address in the database it is given, so it
// refuses any but a throwaway one (a worktree's `*_wt_*` or a `*_test`).
describe("the e2e hq stack's database guard", () => {
  it("accepts a worktree's and a test database", () => {
    for (const name of ["proof_wt_n6_runs_spend", "lab_test", "x_wt_y"]) {
      expect(() => assertDisposableDatabase(url(name)), name).not.toThrow()
    }
    expect(databaseName(`${url("proof_wt_x")}?sslmode=disable`)).toBe("proof_wt_x")
  })

  it("refuses a shared, production or look-alike database, and a bad URL", () => {
    for (const bad of [
      url("lab"),
      url("lab_hq"),
      url("lab_wt"),
      url("lab_test_old"),
      url("labwt_x"),
      `${url("lab")}?options=_wt_`,
      `${url("lab")}#proof_wt_x`,
      "not a url",
      "",
    ]) {
      expect(() => assertDisposableDatabase(bad), bad).toThrow(/refusing to seed or reset/)
    }
  })

  it("the stack script applies it before it starts or connects to anything", () => {
    const res = spawnSync(process.execPath, [SCRIPT, "1"], {
      env: { PATH: process.env.PATH ?? "", HQ_DATABASE_URL: url("lab") },
      encoding: "utf8",
      timeout: 15_000,
    })
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('refusing to seed or reset "lab"')
  })
})
