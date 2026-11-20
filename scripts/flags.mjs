// Feature flag hygiene for agents and people: `pnpm flags <command>` (docs/feature-flags.md).
//
//   refs [key]        every code reference to each declared flag, and declared flags nothing reads
//   stale [--check]   the flags due for removal, each with its references and the next step
//
// `stale` reads the rollouts from the API when PROOF_API_URL and PROOF_API_KEY are set (a key
// of the operator organization with featureFlag:read): all five signals, as list_feature_flags
// reports them. Without them it reports what the code alone shows: flags past reclaimBy, and
// declared flags nothing reads. `--check` exits 1 when anything is stale, for CI or a schedule.
//
// Runs under tsx (apps/api's), so it imports the catalog and the SDK from their TypeScript source.
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { flags } from "../packages/flags/src/index.ts"
import { createClient } from "../packages/sdk/src/index.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const CATALOG = "packages/flags/src/catalog.ts"
const [command, ...args] = process.argv.slice(2)

/** `path:line: text` for each line outside the catalog and tests that names the key as a string. */
function refs(key) {
  try {
    const out = execFileSync(
      "git",
      [
        "grep",
        "-n",
        "-F",
        "-e",
        `"${key}"`,
        "--",
        "apps",
        "packages",
        `:!${CATALOG}`,
        ":!*.gen.ts",
        ":!*.test.ts",
        ":!*.test.tsx",
      ],
      { cwd: root, encoding: "utf8" },
    )
    return out.trim().split("\n").filter(Boolean)
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if (error.status === 1) return []
    throw error
  }
}

const NEXT = {
  orphaned: (f) => `delete the rollout: proof call delete_feature_flag --json '{"key":"${f.key}"}'`,
  "reclaimed-in-code": (f) =>
    `replace each read with ${f.reclaimedValue}, remove it from ${CATALOG}, deploy, then delete_feature_flag`,
  "single-value": (f) =>
    `it serves one value: reclaim it with that value (reclaim_feature_flag), then remove the code`,
  inactive: () =>
    `nothing has read it for 30 days: remove the code, deploy, then delete the rollout`,
  expired: (f) =>
    `past reclaimBy ${f.reclaimBy}: decide (ramp, reclaim) or move reclaimBy with a reason`,
  unused: () => `nothing reads it: remove it from ${CATALOG}, or gate the code it was for`,
}

/** What the code alone shows: past reclaimBy, and declared but never read. */
function staticStale() {
  const today = new Date().toISOString().slice(0, 10)
  return Object.entries(flags).flatMap(([key, def]) => {
    const stale = []
    if (def.reclaimBy && def.reclaimBy < today) stale.push("expired")
    if (refs(key).length === 0) stale.push("unused")
    return stale.length > 0 ? [{ key, reclaimBy: def.reclaimBy ?? null, stale }] : []
  })
}

async function apiStale() {
  const client = createClient({
    baseURL: process.env.PROOF_API_URL,
    apiKey: process.env.PROOF_API_KEY,
  })
  const { flags: stale } = await client.request("GET", "/v1/feature-flags", {
    query: { stale: true },
  })
  // Declared flags nothing reads are a code fact the API can't see.
  const unused = Object.keys(flags)
    .filter((key) => refs(key).length === 0)
    .map((key) => ({ key, reclaimBy: flags[key].reclaimBy ?? null, stale: ["unused"] }))
  const byKey = new Map(stale.map((f) => [f.key, f]))
  for (const f of unused) {
    const known = byKey.get(f.key)
    if (known) known.stale.push("unused")
    else byKey.set(f.key, f)
  }
  return [...byKey.values()]
}

function printRefs(keys) {
  for (const key of keys) {
    const found = refs(key)
    console.log(`${key} (${found.length} reference${found.length === 1 ? "" : "s"})`)
    for (const line of found) console.log(`  ${line}`)
  }
}

switch (command) {
  case "refs": {
    const keys = args[0] ? [args[0]] : Object.keys(flags)
    if (args[0] && !(args[0] in flags)) console.log(`${args[0]} is not declared in ${CATALOG}`)
    printRefs(keys)
    break
  }
  case "stale": {
    const fromApi = Boolean(process.env.PROOF_API_URL && process.env.PROOF_API_KEY)
    const stale = fromApi ? await apiStale() : staticStale()
    if (!fromApi) {
      console.log("PROOF_API_URL and PROOF_API_KEY unset: code signals only (expired, unused).")
    }
    if (stale.length === 0) console.log("No stale flags.")
    for (const f of stale) {
      console.log(`\n${f.key}: ${f.stale.join(", ")}${f.status ? ` (status ${f.status})` : ""}`)
      for (const signal of f.stale) console.log(`  next: ${NEXT[signal]?.(f) ?? signal}`)
      for (const line of refs(f.key)) console.log(`  ${line}`)
    }
    if (args.includes("--check") && stale.length > 0) process.exit(1)
    break
  }
  default:
    console.error("usage: pnpm flags refs [key] | pnpm flags stale [--check]")
    process.exit(2)
}
