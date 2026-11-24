// Seeds a pipeline into a running hq so every screenshot of the Work screens starts from the same
// board: ten items across the five columns, a pending merge approval, an open question, an
// exhausted item, a verifying item with 134 minutes left and a reopened one.
//
// It writes only through hq's public `/v1` operations, as a signed-in founder: it takes a cookie
// file (the `Cookie` header value of a founder's session, or a curl/Netscape cookie jar), signs
// nothing in, and touches no database. The agent-side operations it calls (record_signal,
// start_attempt, record_pull_request, ...) act as `agent` whoever calls them, so a founder
// session may use them; every write sends the trusted Origin of the base url, as the app does.
//
// The clock is hq's own: `now` is read from GET /v1/work/board, never from this machine, and the
// merges that need the clock are backdated with `record_pull_request`'s `mergedAt` (hq clamps it
// to <= its now). Run it on a database nobody else writes to.
//
// Work history can never be deleted, so a wrong base url would leave about 40 rows in a real
// organization: the script refuses a base url that is not this machine (localhost, a *.localhost
// name, 127.0.0.0/8 or ::1) unless `--allow-remote` is passed.
//
// Idempotent: each item is found again by its dedupe key (`github-issue:<repo>#<n>`); with all ten
// present nothing is written and no sweep runs. The unit is the item, not the run: a first run that
// died half-way leaves a partly built item that a second run counts as found and does not repair
// (seed a fresh database instead), and one that died between the sweep and the recurrence leaves
// no reopened item. A second run after a clean first one writes nothing.
//
// Usage: node scripts/seed-work.mjs <baseUrl> <cookieFile> [owner/name] [--allow-remote]
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

/** The lengths of hq's constants (apps/hq/src/work/constants.ts), as the plan pins them. */
const DEPLOY_GRACE_MINUTES = 15
const VERIFY_WINDOW_HOURS = 6
/** The merges: minutes before hq's now. The 241 leaves a 134 minute window (15 + 360 - 241). */
export const MERGE_MINUTES_AGO = {
  deploying: 5,
  verifyingLate: DEPLOY_GRACE_MINUTES + VERIFY_WINDOW_HOURS * 60 - 134,
  verifyingReopened: 200,
  done: 7 * 60,
}
/** The issue numbers of the seeded items, in the order they are built. */
export const SEED_ISSUES = {
  triage: 101,
  asking: 102,
  planned: 103,
  building: 104,
  exhausted: 105,
  pendingMerge: 106,
  deploying: 107,
  verifyingLate: 108,
  reopened: 109,
  done: 110,
}
const SHA = (seed) => seed.toString(16).padStart(40, "a")

/** Whether a url names this machine: localhost, `*.localhost` (worktree stacks), 127/8, ::1. */
export function isLoopback(url) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase()
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  )
}

/** A cookie file as a Cookie header value: the header itself, or a Netscape jar's rows. */
export function cookieHeaderFrom(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^#HttpOnly_/, "").trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
  const jar = lines.filter((line) => line.split("\t").length >= 7)
  if (jar.length > 0) {
    return jar
      .map((line) => line.split("\t"))
      .map((cols) => `${cols[5]}=${cols[6]}`)
      .join("; ")
  }
  const header = lines[0]?.replace(/^cookie:\s*/i, "") ?? ""
  if (!header.includes("=")) throw new Error("the cookie file holds no cookie")
  return header
}

/**
 * Seed the pipeline. `fetch` defaults to the global one; a test passes one that calls the app.
 * Returns what it built and what it found, by role, and any warnings.
 */
export async function seedWork({
  baseUrl,
  cookie,
  fetch = globalThis.fetch,
  repo = "acme/web",
  allowRemote = false,
}) {
  const base = new URL(baseUrl)
  if (!allowRemote && !isLoopback(baseUrl)) {
    throw new Error(
      `${base.origin} is not this machine. Work history can never be deleted, so seeding a real ` +
        "organization would leave about 40 rows in it for good. Pass --allow-remote if you mean it.",
    )
  }
  const origin = base.origin
  const prefix = base.pathname.replace(/\/$/, "")
  const touched = []

  async function api(method, path, body) {
    touched.push(`${method} ${path}`)
    const headers = { cookie, origin }
    if (method !== "GET") headers["content-type"] = "application/json"
    const init = { method, headers }
    if (method !== "GET") init.body = JSON.stringify(body ?? {})
    const res = await fetch(`${origin}${prefix}${path}`, init)
    const text = await res.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    if (!res.ok) {
      const message = json?.error?.message ?? text.slice(0, 200)
      throw new Error(`${method} ${path} answered ${res.status}: ${message}`)
    }
    return json
  }
  const post = (path, body) => api("POST", path, body)

  const minutesBefore = (now, minutes) => new Date(now.getTime() - minutes * 60_000).toISOString()
  const key = (n) => `github-issue:${repo}#${n}`

  const board = await api("GET", "/v1/work/board")
  const now = new Date(board.now)
  const warnings = []
  const minutesLeftInDay = (24 * 60 * 60_000 - (now.getTime() % (24 * 60 * 60_000))) / 60_000
  if (minutesLeftInDay <= 10) {
    warnings.push(
      "It is the last 10 minutes of the UTC day: a Done today card leaves its column at midnight.",
    )
  }

  async function find(n) {
    const found = await api("GET", `/v1/work-items?dedupeKey=${encodeURIComponent(key(n))}`)
    return found.items[0] ?? null
  }

  /** A github_issue signal: a new item in triage (or an attachment to the item of that key). */
  async function signal(n, title, extra = {}) {
    return post("/v1/signals", {
      source: "github_issue",
      externalId: extra.externalId ?? `${key(n)}:opened`,
      dedupeKey: key(n),
      repo,
      title,
      summary: extra.summary ?? `${title}.`,
      url: `https://github.com/${repo}/issues/${n}`,
      ...(extra.occurredAt ? { occurredAt: extra.occurredAt } : {}),
      payload: { body: extra.body ?? `${title}. Reported by a customer.` },
    })
  }
  const investigate = async (itemId, n, files) => {
    const attempt = await post(`/v1/work-items/${itemId}/attempts`, {
      kind: "investigate",
      externalRef: `seed-${n}-investigate`,
    })
    await post(`/v1/attempts/${attempt.id}/finish`, {
      result: "investigated",
      note: "Reproduced it and found the cause.",
      files,
    })
  }
  const contract = (itemId) =>
    post(`/v1/work-items/${itemId}/contract`, {
      items: [
        { text: "The reported flow works again", verifier: { kind: "reviewer" } },
        { text: "The checks of the pull request pass", verifier: { kind: "ci" } },
      ],
    })
  const startFix = (itemId, n, k) =>
    post(`/v1/work-items/${itemId}/attempts`, {
      kind: "fix",
      attemptLimit: 3,
      externalRef: `seed-${n}-fix-${k}`,
    })
  const pullRequest = (itemId, n, extra) =>
    post("/v1/pull-requests", {
      itemId,
      branch: `factory/fix-${n}`,
      number: n,
      url: `https://github.com/${repo}/pull/${n}`,
      base: "main",
      headSha: SHA(n),
      isDraft: false,
      state: "open",
      additions: 24,
      deletions: 6,
      files: 2,
      checks: [
        { name: "build", state: "passed" },
        { name: "test", state: "passed" },
      ],
      ...extra,
    })
  /** The fix that reaches review: contract, an attempt, its branch and pull request, approved.
   *  `file` is the file it changed (and its test); `merged` backdates a merge, in minutes. */
  async function fixToReview(itemId, n, file, merged) {
    await contract(itemId)
    const fix = await startFix(itemId, n, 1)
    await post(`/v1/attempts/${fix.id}/heartbeat`, {
      branch: `factory/fix-${n}`,
      files: [file, file.replace(/\.ts$/, ".test.ts")],
      note: "The change and a test for it are on the branch.",
    })
    await pullRequest(itemId, n, {})
    await post(`/v1/attempts/${fix.id}/finish`, {
      result: "approved",
      note: "The fix is in the pull request.",
      reviewer: { verdict: "approve", summary: "The guard is right and tested.", headSha: SHA(n) },
    })
    if (merged !== undefined) {
      await pullRequest(itemId, n, {
        state: "merged",
        mergedBy: "founder-login",
        mergedAt: minutesBefore(now, merged),
      })
    }
  }

  const built = []
  const found = []
  const ids = {}
  async function build(role, fn) {
    const n = SEED_ISSUES[role]
    const existing = await find(n)
    if (existing) {
      found.push(role)
      ids[role] = existing.displayId
      return
    }
    ids[role] = await fn(n)
    built.push(role)
  }

  await build("triage", async (n) => (await signal(n, "Checkout shows a blank page")).displayId)

  await build("asking", async (n) => {
    const made = await signal(n, "Invoices are rounded the wrong way")
    await post(`/v1/work-items/${made.itemId}/questions`, {
      prompt: "Round half up, or half to even as the ledger does?",
      options: [
        { id: "up", label: "Half up", detail: "What customers expect on a receipt." },
        { id: "even", label: "Half to even", detail: "What the ledger already does." },
      ],
      defaultOptionId: "up",
    })
    return made.displayId
  })

  await build("planned", async (n) => {
    const made = await signal(n, "Password reset mail arrives twice")
    await investigate(made.itemId, n, ["src/auth/reset.ts"])
    await contract(made.itemId)
    return made.displayId
  })

  await build("building", async (n) => {
    const made = await signal(n, "Search ignores accents")
    await investigate(made.itemId, n, ["src/search/index.ts"])
    await contract(made.itemId)
    const fix = await startFix(made.itemId, n, 1)
    await post(`/v1/attempts/${fix.id}/heartbeat`, {
      branch: `factory/fix-${n}`,
      files: ["src/search/index.ts"],
      note: "Folding accents before the index is built.",
    })
    return made.displayId
  })

  await build("exhausted", async (n) => {
    const made = await signal(n, "Export times out on large workspaces")
    await investigate(made.itemId, n, ["src/export/run.ts"])
    await contract(made.itemId)
    for (const k of [1, 2, 3]) {
      const fix = await startFix(made.itemId, n, k)
      await post(`/v1/attempts/${fix.id}/finish`, {
        result: "failed",
        note: `Attempt ${k}: the export still timed out after the change.`,
      })
    }
    return made.displayId
  })

  await build("pendingMerge", async (n) => {
    const made = await signal(n, "Empty cart crashes the checkout")
    await investigate(made.itemId, n, ["src/checkout/cart.ts"])
    await fixToReview(made.itemId, n, "src/checkout/cart.ts")
    return made.displayId
  })

  const clockRoles = ["deploying", "verifyingLate", "reopened", "done"]
  await build("deploying", async (n) => {
    const made = await signal(n, "Sign-in link opens the wrong page")
    await investigate(made.itemId, n, ["src/auth/link.ts"])
    await fixToReview(made.itemId, n, "src/auth/link.ts", MERGE_MINUTES_AGO.deploying)
    return made.displayId
  })

  /** The recurrences that make the verification chart: before the merge, while it is in triage. */
  const bars = async (n, title, minutesAgo) => {
    for (const [i, at] of minutesAgo.entries()) {
      await signal(n, title, {
        externalId: `${key(n)}:bar-${i}`,
        occurredAt: minutesBefore(now, at),
      })
    }
  }

  await build("verifyingLate", async (n) => {
    const title = "Webhook retries flood the queue"
    const made = await signal(n, title)
    await bars(n, title, [330, 300, 290, 270])
    await investigate(made.itemId, n, ["src/webhooks/queue.ts"])
    await fixToReview(made.itemId, n, "src/webhooks/queue.ts", MERGE_MINUTES_AGO.verifyingLate)
    return made.displayId
  })

  /** The second verify item, which the recurrence below reopens (never the 134-minute one). */
  let reopenedItem = null
  await build("reopened", async (n) => {
    const made = await signal(n, "Dashboard totals drift after a refund")
    await investigate(made.itemId, n, ["src/dashboard/totals.ts"])
    await fixToReview(
      made.itemId,
      n,
      "src/dashboard/totals.ts",
      MERGE_MINUTES_AGO.verifyingReopened,
    )
    reopenedItem = made
    return made.displayId
  })

  await build("done", async (n) => {
    const made = await signal(n, "Avatar upload rejects large PNGs")
    await investigate(made.itemId, n, ["src/profile/avatar.ts"])
    await fixToReview(made.itemId, n, "src/profile/avatar.ts", MERGE_MINUTES_AGO.done)
    return made.displayId
  })

  // One sweep, after every clock item exists and before the reopened item is made: the sweep
  // retriages each reopened item, so it must not see this one.
  const needsSweep = clockRoles.some((role) => built.includes(role))
  const sweep = needsSweep ? await post("/v1/work/verification-sweep", {}) : null

  // The reopened item: a signal with the dedupe key of the 200-minute verify item recurs.
  if (reopenedItem) {
    await signal(SEED_ISSUES.reopened, "Dashboard totals drift after a refund", {
      externalId: `${key(SEED_ISSUES.reopened)}:recurred`,
      summary: "The totals drifted again after a refund.",
    })
  }

  return { built, found, ids, sweep, warnings, touched, now: now.toISOString() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const allowRemote = args.includes("--allow-remote")
  const [baseUrl, cookieFile, repo] = args.filter((arg) => arg !== "--allow-remote")
  if (!baseUrl || !cookieFile) {
    process.stderr.write(
      "usage: node scripts/seed-work.mjs <baseUrl> <cookieFile> [owner/name] [--allow-remote]\n",
    )
    process.exit(2)
  }
  const cookie = cookieHeaderFrom(readFileSync(cookieFile, "utf8"))
  const result = await seedWork({ baseUrl, cookie, repo, allowRemote })
  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`)
  const { touched: _touched, ...summary } = result
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}
