import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, test } from "vitest"

/**
 * eve's `decide()` emits a `usage.recorded` of kind "decision" inside a session, and every call the
 * agent makes runs in one: pretriage's `decide()` too (it runs in a dynamic instruction, inside a
 * model step), so it emits a record like any other. The wrapper announces each call and counts it,
 * and the usage hook skips the record that call emits, so a call the wrapper never saw would be
 * counted only as that record: every decision call the agent makes must go through `meteredDecide` (`agent/lib/spend/ledger.ts`), which adds the
 * cost to the turn or records it as build spend. This holds that line: nothing but the ledger may
 * import the real `decide`, and the three call sites (triage, CI diagnosis, pretriage) use the
 * metered one.
 */
const AGENT = join(import.meta.dirname, "../../agent")

const sources = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) {
      return sources(path)
    }
    return path.endsWith(".ts") ? [path] : []
  })

/**
 * Any way to reach eve's real `decide` (it lives in "eve/ai") other than a type-only import: a named
 * or default import, a namespace import (`import * as ai from "eve/ai"`), a re-export, a dynamic
 * `import("eve/ai")` or a `require`. `[^"']*` keeps a match inside one statement.
 */
const importsEveAiAsValue = (text: string) =>
  /^(?:import|export)\s+(?!type\b)[^"']*\bfrom\s*["']eve\/ai["']/m.test(text) ||
  /\b(?:import|require)\s*\(\s*["'`]eve\/ai["'`]\s*\)/.test(text)

describe("decision-model spend is metered", () => {
  test("only the ledger imports eve/ai as a value", () => {
    const importers = sources(AGENT)
      .filter((path) => importsEveAiAsValue(readFileSync(path, "utf8")))
      .map((path) => relative(AGENT, path))
    expect(importers).toEqual(["lib/spend/ledger.ts"])
  })

  test.each([
    ['import { decide } from "eve/ai"'],
    ['import { decide as d } from "eve/ai"'],
    ['import {\n  type DecisionModel,\n  decide,\n} from "eve/ai"'],
    ['import * as ai from "eve/ai"\nawait ai.decide(args)'],
    ['import ai from "eve/ai"'],
    ['export { decide } from "eve/ai"'],
    ['export * from "eve/ai"'],
    ['const { decide } = await import("eve/ai")'],
    ["const ai = await import('eve/ai')"],
    ['const ai = require("eve/ai")'],
  ])("the importer check catches %s", (source) => {
    expect(importsEveAiAsValue(source)).toBe(true)
  })

  test.each([
    ['import type { DecisionModel, decide } from "eve/ai"'],
    ['import type * as ai from "eve/ai"'],
    ['import { generateText } from "ai"\nimport { x } from "./eve/ai-notes.js"'],
    ['import { decide } from "./decide.js"'],
    ['import type { decide } from "eve/ai"\nimport { log } from "../log.js"'],
    ["// uses eve/ai through meteredDecide"],
  ])("the importer check passes %s", (source) => {
    expect(importsEveAiAsValue(source)).toBe(false)
  })

  test.each([
    ["tools/triage_work_item.ts", "meteredDecide()"],
    ["tools/diagnose_ci_failure.ts", "meteredDecide()"],
    ["instructions/pretriage.ts", "meteredDecide({ build: true })"],
  ])("%s calls decide through %s", (file, call) => {
    expect(readFileSync(join(AGENT, file), "utf8")).toContain(call)
  })
})
