import { describe, expect, it } from "vitest"

import { parseFounders } from "./data/founders"
import { assertSignUpClosedWhenDeployed, isProductionLike, predeployProblems } from "./deploy-mode"

describe("what hq:predeploy refuses", () => {
  const ok = { nodeEnv: "production", allowSignUp: false, founders: parseFounders("id:u-1=U01") }

  it("passes a production environment with sign-up off and founders by id", () => {
    expect(predeployProblems(ok)).toEqual([])
  })

  it("refuses NODE_ENV development, test, staging or unset: a mistaken value in production reopens sign-up", () => {
    for (const nodeEnv of ["development", "test", "staging", undefined]) {
      const problems = predeployProblems({ ...ok, nodeEnv })
      expect(problems, String(nodeEnv)).toHaveLength(1)
      expect(problems[0]).toMatch(/NODE_ENV is .*not "production"/)
    }
  })

  it("refuses sign-up on and email= founders, naming each problem", () => {
    const problems = predeployProblems({
      nodeEnv: "production",
      allowSignUp: true,
      founders: parseFounders("ann@example.com=U01,id:u-2=U02,bob@example.com=U03"),
    })
    expect(problems).toHaveLength(2)
    expect(problems.join("\n")).toMatch(/HQ_ALLOW_SIGNUP is on/)
    expect(problems.join("\n")).toMatch(/2 email= entries/)
    // Never an address in what it prints.
    expect(problems.join("\n")).not.toContain("example.com")
  })
})

describe("what counts as a deployed hq", () => {
  it("is anything but an explicit development or test: production, or no NODE_ENV at all", () => {
    expect(isProductionLike("production")).toBe(true)
    expect(isProductionLike(undefined)).toBe(true)
    expect(isProductionLike("staging")).toBe(true)
    expect(isProductionLike("development")).toBe(false)
    expect(isProductionLike("test")).toBe(false)
  })

  it("refuses public sign-up when deployed, and lets local stacks keep it", () => {
    for (const nodeEnv of ["production", undefined, "staging"]) {
      expect(() => assertSignUpClosedWhenDeployed({ nodeEnv, allowSignUp: true })).toThrow(
        /HQ_ALLOW_SIGNUP is on in a deployed hq/,
      )
      expect(() => assertSignUpClosedWhenDeployed({ nodeEnv, allowSignUp: false })).not.toThrow()
    }
    for (const nodeEnv of ["development", "test"]) {
      expect(() => assertSignUpClosedWhenDeployed({ nodeEnv, allowSignUp: true })).not.toThrow()
    }
  })
})
