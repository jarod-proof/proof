#!/usr/bin/env node
// Fails unless hq's real-Postgres tests ran and passed: usage `node scripts/assert-hq-real-postgres.mjs
// <vitest json report>`. Those blocks (apps/hq/src/data/spend.test.ts, grant-requests.test.ts,
// founders-concurrency.test.ts, signals-race.test.ts and attempts-race.test.ts) skip themselves
// when no `*_test` or `*_wt_*` database is configured, and vitest reports a skip as success. In CI a skip means the service database or
// HQ_TEST_DATABASE_URL is wrong.
import { readFileSync } from "node:fs"

const FILES = [
  /src[\\/]data[\\/]spend\.test\.ts$/,
  /src[\\/]data[\\/]grant-requests\.test\.ts$/,
  /src[\\/]data[\\/]founders-concurrency\.test\.ts$/,
  /src[\\/]data[\\/]signals-race\.test\.ts$/,
  /src[\\/]data[\\/]attempts-race\.test\.ts$/,
]
const BLOCK = /real Postgres/

const path = process.argv[2]
if (!path) {
  console.error("usage: node scripts/assert-hq-real-postgres.mjs <vitest json report>")
  process.exit(2)
}

let report
try {
  report = JSON.parse(readFileSync(path, "utf8"))
} catch (error) {
  console.error(`cannot read the vitest report ${path}: ${error.message}`)
  process.exit(2)
}

const problems = []
for (const file of FILES) {
  const found = (report.testResults ?? []).find((f) => file.test(f.name))
  if (!found) {
    problems.push(`${file}: not in the report (did the run include it?)`)
    continue
  }
  const real = (found.assertionResults ?? []).filter((t) =>
    (t.ancestorTitles ?? []).some((title) => BLOCK.test(title)),
  )
  if (real.length === 0) {
    problems.push(`${found.name}: no real-Postgres tests in the report`)
    continue
  }
  const notPassed = real.filter((t) => t.status !== "passed")
  if (notPassed.length > 0) {
    problems.push(
      `${found.name}: ${notPassed.length} of ${real.length} real-Postgres tests did not pass ` +
        `(${[...new Set(notPassed.map((t) => t.status))].join(", ")})`,
    )
  }
}

if (problems.length > 0) {
  console.error(`The real-Postgres tests did not all run and pass:\n- ${problems.join("\n- ")}`)
  process.exit(1)
}
console.log(
  "The real-Postgres tests ran and passed in spend.test.ts, grant-requests.test.ts, " +
    "founders-concurrency.test.ts, signals-race.test.ts and attempts-race.test.ts.",
)
