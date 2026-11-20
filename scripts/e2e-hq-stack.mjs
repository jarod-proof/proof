// The e2e hq app: apps/hq started by the runner on the port it picked, with one founder seeded.
// hq lets in only founders (HQ_FOUNDERS, written to its founders table at boot, for an address that
// is verified), and it has no dev mail sink
// to verify through, so, as scripts/e2e-stack.mjs does for the platform admin: sign the founder up
// through the API (an existing one answers 422 and keeps its password), then mark the address
// verified in the database.
//
// The runner treats the app as ready once the port answers, so the founder must exist before the
// port opens: hq is started first on a throwaway port of its own, seeded, and stopped, and only
// then started on the runner's port. (Seeding on the runner's port let tests start before the
// founder existed, and a failed seed killed hq under them: ECONNREFUSED in every test.)
//
// better-auth's rate limits (sign-up 5 per 5 minutes, sign-in 5 per minute) are counted in the
// database, so they persist between runs on a worktree's database and made the seed answer 429.
// This stack (only against a *_wt_ or *_test database, e2e-hq-guard.mjs) clears that table before seeding and again after, so each run starts from zero. Only
// this e2e stack does: the limits themselves are untouched, in hq and in production. A run needs
// well under the limits (about four sign-ins and one sign-up); a new journey that signs in more
// has to share them.
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { createServer } from "node:net"

import { assertDisposableDatabase } from "./e2e-hq-guard.mjs"

const port = process.argv[2]
if (!port) throw new Error("usage: node scripts/e2e-hq-stack.mjs <port>")
const email = process.env.E2E_HQ_FOUNDER_EMAIL
const password = process.env.E2E_HQ_FOUNDER_PASSWORD
const database = process.env.HQ_DATABASE_URL
// Seeding and clearing write to this database: only a throwaway one (e2e-hq-guard.mjs).
if (database) assertDisposableDatabase(database)

/** hq on `at`, in its own process group so the whole `pnpm` -> `tsx` -> node chain stops together. */
function startHq(at) {
  const child = spawn(
    "pnpm",
    ["--filter", "@proof/hq", "exec", "tsx", "src/server.ts", String(at)],
    {
      env: process.env,
      stdio: "inherit",
      detached: true,
    },
  )
  child.stopped = false
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve()
      child.stopped = true
      child.once("exit", () => resolve())
      try {
        process.kill(-child.pid, "SIGTERM")
      } catch {
        resolve()
      }
    })
  return { child, stop }
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port: free } = server.address()
      server.close(() => resolve(free))
    })
  })

async function waitForHealth(url, hq) {
  const deadline = Date.now() + 120_000
  for (;;) {
    if (hq.child.exitCode !== null) throw new Error(`hq exited with ${hq.child.exitCode}`)
    try {
      if ((await fetch(`${url}/health`)).ok) return
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`hq did not answer on ${url}/health`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

// postgres is packages/db's driver; the root workspace doesn't depend on it.
const require = createRequire(new URL("../packages/db/package.json", import.meta.url))
const sql = database
  ? (await import(require.resolve("postgres"))).default(database, { max: 1 })
  : null
const clearRateLimits = async () => {
  if (sql) await sql`delete from rate_limit`
}

let live = null
const shutdown = async (code) => {
  await live?.stop()
  await sql?.end({ timeout: 2 })
  process.exit(code)
}
process.on("SIGINT", () => void shutdown(130))
process.on("SIGTERM", () => void shutdown(143))

try {
  if (email && password && sql) {
    await clearRateLimits()
    const seedPort = await freePort()
    const seeder = startHq(seedPort)
    live = seeder
    const seedUrl = `http://127.0.0.1:${seedPort}`
    await waitForHealth(seedUrl, seeder)
    const signUp = await fetch(`${seedUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: seedUrl },
      body: JSON.stringify({ name: "E2E HQ Founder", email, password }),
    })
    if (!signUp.ok && signUp.status !== 422) {
      throw new Error(`signing up ${email} failed: ${signUp.status}`)
    }
    await sql`update "user" set email_verified = true where email = ${email}`
    await seeder.stop()
    live = null
    await clearRateLimits()
  }

  const hq = startHq(port)
  live = hq
  hq.child.on("exit", (code) => {
    if (hq.child.stopped) return
    console.error(`[e2e hq stack] hq exited with ${code}`)
    process.exit(code ?? 1)
  })
  await waitForHealth(`http://127.0.0.1:${port}`, hq)
} catch (error) {
  console.error(`[e2e hq stack] ${error.message}`)
  await shutdown(1)
}
