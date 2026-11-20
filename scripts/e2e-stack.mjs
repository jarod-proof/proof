// The e2e app: apps/api and the web dev server, started together by the runner (one `app.command`,
// one URL). The API runs on E2E_API_PORT, or a free port; vite proxies /api, /v1, /mcp and /.well-known to it
// (API_URL), so the browser sees one origin and the session cookies apply. Both children stop when
// this process gets a signal or either one exits.
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const webPort = process.argv[2]
if (!webPort) throw new Error("usage: node scripts/e2e-stack.mjs <web port>")
// Each target (desktop, phone) starts its own stack, so the API takes a free port unless one is pinned.
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(String(port)))
    })
  })
const apiPort = process.env.E2E_API_PORT ?? (await freePort())
const apiUrl = `http://127.0.0.1:${apiPort}`

// Uploads are on for the stack: files go to a fresh directory that is removed when this process exits
// (every exit path, the signal handlers and the children's exits, goes through process.exit).
const storageDir = mkdtempSync(join(tmpdir(), "proof-e2e-storage-"))
process.on("exit", () => rmSync(storageDir, { recursive: true, force: true }))

const children = []
const stop = () => {
  for (const child of children) child.kill("SIGTERM")
}
process.on("SIGINT", () => {
  stop()
  process.exit(130)
})
process.on("SIGTERM", () => {
  stop()
  process.exit(143)
})

function start(name, args, env) {
  const child = spawn("pnpm", args, { env, stdio: "inherit" })
  child.on("exit", (code) => {
    console.error(`[e2e stack] ${name} exited with ${code}`)
    stop()
    process.exit(code ?? 1)
  })
  children.push(child)
  return child
}

const env = {
  ...process.env,
  PORT: apiPort,
  BETTER_AUTH_URL: apiUrl,
  API_URL: apiUrl,
  // The web app is on its own origin here, so auth callbacks from it (magic link, reset) must be trusted.
  WEB_ORIGINS: `http://127.0.0.1:${webPort}`,
  // A suite signs in far more often than the per-IP limit allows (the limiter is for production). Refused
  // unless NODE_ENV is development or test, which e2e.config.ts sets.
  AUTH_RATE_LIMIT: "off",
  // Uploads (avatar, org logo) go to the local driver, which the API serves at /files.
  STORAGE_DRIVER: "local",
  STORAGE_LOCAL_DIR: storageDir,
}

// Support's inbound mail comes through a raw relay (SUPPORT_INBOUND_SECRET) with a secret made here.
// The targets' stacks share the database, so either one's support sweep may send a thread mail into
// its own mail sink. Each stack writes its URLs and its secret where the support journeys read them
// (e2e/support/support-stack.ts).
const stacksDir = process.env.E2E_STACKS_DIR
if (stacksDir && process.env.SUPPORT_REPLY_DOMAIN) {
  const inboundSecret = randomBytes(24).toString("base64url")
  env.SUPPORT_INBOUND_SECRET = inboundSecret
  mkdirSync(stacksDir, { recursive: true })
  const entry = join(stacksDir, `${webPort}.json`)
  writeFileSync(
    entry,
    JSON.stringify({ web: `http://127.0.0.1:${webPort}`, api: apiUrl, inboundSecret }),
  )
  process.on("exit", () => rmSync(entry, { force: true }))
}

// Inbound support mail is checked for a DKIM signature against DNS; the journeys sign with keys they
// publish in E2E_DKIM_DIR, which this preload answers lookups from (scripts/e2e-dkim-dns.mjs). Only
// the API gets it.
const dkimDns = fileURLToPath(new URL("./e2e-dkim-dns.mjs", import.meta.url))
const apiEnv = process.env.E2E_DKIM_DIR
  ? { ...env, NODE_OPTIONS: [env.NODE_OPTIONS, `--import=${dkimDns}`].filter(Boolean).join(" ") }
  : env
start("api", ["--filter", "@proof/api-app", "exec", "tsx", "src/server.ts"], apiEnv)

// The web app proxies to the API, and the first sign-up needs it: wait for its liveness check.
const deadline = Date.now() + 120_000
for (;;) {
  try {
    if ((await fetch(`${apiUrl}/health`)).ok) break
  } catch {
    // not listening yet
  }
  if (Date.now() > deadline) {
    console.error(`[e2e stack] the API did not answer on ${apiUrl}/health`)
    stop()
    process.exit(1)
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
}

// The platform admin for e2e/admin.e2e.ts (credentials from e2e.config.ts). Admin is a database role,
// so: sign the account up through the API (an existing one answers 422 and keeps its password), then
// promote it. Two-factor stays off on it, or sign-in would stop at /two-factor.
const adminEmail = process.env.E2E_ADMIN_EMAIL
const adminPassword = process.env.E2E_ADMIN_PASSWORD
if (adminEmail && adminPassword && process.env.DATABASE_URL) {
  const signUp = await fetch(`${apiUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: apiUrl },
    body: JSON.stringify({ name: "E2E Admin", email: adminEmail, password: adminPassword }),
  })
  if (!signUp.ok && signUp.status !== 422) {
    console.error(`[e2e stack] signing up ${adminEmail} failed: ${signUp.status}`)
    stop()
    process.exit(1)
  }
  // postgres is packages/db's driver; the root workspace doesn't depend on it.
  const require = createRequire(new URL("../packages/db/package.json", import.meta.url))
  const { default: postgres } = await import(require.resolve("postgres"))
  const sql = postgres(process.env.DATABASE_URL, { max: 1 })
  await sql`update "user" set role = 'admin' where email = ${adminEmail}`
  // The operator organization (OPERATOR_ORGANIZATION_ID): its members are the support staff, and the
  // admin owns it, so the support journeys (e2e/support-*.e2e.ts) work the queue as the admin. Both
  // targets' stacks run this against one database, so it is written to be idempotent.
  const operatorId = process.env.OPERATOR_ORGANIZATION_ID
  const operatorSlug = process.env.E2E_OPERATOR_SLUG
  if (operatorId && operatorSlug) {
    await sql`
      insert into organization (id, name, slug, created_at)
      values (${operatorId}, 'Support team', ${operatorSlug}, now())
      on conflict (id) do nothing`
    await sql`
      insert into member (id, organization_id, user_id, role, created_at)
      select ${`${operatorId}_owner`}, ${operatorId}, id, 'owner', now()
      from "user" where email = ${adminEmail}
      on conflict (id) do nothing`
  }
  await sql.end()
}

start(
  "app",
  [
    "--filter",
    "@proof/app",
    "exec",
    "vite",
    "dev",
    "--host",
    "127.0.0.1",
    "--port",
    webPort,
    "--strictPort",
  ],
  env,
)
