// The e2e Slack stack: hq and the agent side by side, for e2e/slack-actions.e2e.ts.
//
//  1. hq on a free port, through scripts/e2e-hq-stack.mjs (it seeds the founder, whose Slack user
//     is in HQ_FOUNDERS, before hq answers).
//  2. An hq API key with exactly the agent's scope, minted as that founder.
//  3. The agent: `eve dev` on the port the runner picked, on scripted models (AGENT_OFFLINE=1),
//     pointed at hq with that key and the Slack signing secret. Nothing real is reached: no Slack,
//     no model provider, no GitHub.
//
// It writes `.e2e/slack-stacks/<agent port>.json` with hq's URL so the journey can find it, and
// stops both processes (each in its own process group) on SIGINT or SIGTERM.
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"

const agentPort = process.argv[2]
if (!agentPort) throw new Error("usage: node scripts/e2e-slack-stack.mjs <port>")
const email = process.env.E2E_HQ_FOUNDER_EMAIL
const password = process.env.E2E_HQ_FOUNDER_PASSWORD
const secret = process.env.SLACK_SIGNING_SECRET
const team = process.env.HQ_SLACK_TEAM_ID
if (!email || !password || !secret || !team) {
  throw new Error(
    "the Slack stack needs the hq target's founder, signing secret and team (e2e.config.ts)",
  )
}
const stacksDir = join(process.cwd(), ".e2e", "slack-stacks")
const stackFile = join(stacksDir, `${agentPort}.json`)

const children = []
/** A process in its own group, so the whole `pnpm` -> `tsx`/`eve` -> node chain stops together. */
function start(command, args, env) {
  const child = spawn(command, args, { env, stdio: "inherit", detached: true })
  child.stopped = false
  children.push(child)
  return child
}
const stopAll = () =>
  Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve()
          child.stopped = true
          child.once("exit", () => resolve())
          try {
            process.kill(-child.pid, "SIGTERM")
          } catch {
            resolve()
          }
        }),
    ),
  )

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })

async function waitFor(url, child, what) {
  const deadline = Date.now() + 200_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`${what} exited with ${child.exitCode}`)
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`${what} did not answer on ${url}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

const shutdown = async (code) => {
  rmSync(stackFile, { force: true })
  await stopAll()
  process.exit(code)
}
process.on("SIGINT", () => void shutdown(130))
process.on("SIGTERM", () => void shutdown(143))

try {
  const hqPort = await freePort()
  const hqUrl = `http://127.0.0.1:${hqPort}`
  const hq = start("node", ["scripts/e2e-hq-stack.mjs", String(hqPort)], { ...process.env })
  hq.on("exit", (code) => {
    if (!hq.stopped) {
      console.error(`[e2e slack stack] the hq stack exited with ${code}`)
      process.exit(code ?? 1)
    }
  })
  await waitFor(`${hqUrl}/health`, hq, "hq")

  // The agent's key, made on the server for the founder with the agent's scope and nothing more
  // (`pnpm --filter @proof/hq mint-agent-key`): a key's permissions cannot be set over HTTP.
  const minted = spawnSync(
    "pnpm",
    ["--filter", "@proof/hq", "--silent", "mint-agent-key", "--email", email],
    { env: process.env, encoding: "utf8" },
  )
  const agentKey = minted.stdout.trim().split("\n").at(-1) ?? ""
  if (minted.status !== 0 || !agentKey.startsWith("sk_")) {
    throw new Error(
      `minting the agent's key failed (${minted.status}): ${minted.stderr.slice(0, 300)}`,
    )
  }

  // Written before the agent starts: the runner takes the agent's port answering as "ready".
  mkdirSync(stacksDir, { recursive: true })
  writeFileSync(stackFile, JSON.stringify({ hqUrl, agentUrl: `http://127.0.0.1:${agentPort}` }))

  const agent = start(
    "pnpm",
    ["--filter", "@proof/agent", "exec", "eve", "dev", "--no-ui", "--port", agentPort],
    {
      ...process.env,
      AGENT_OFFLINE: "1",
      EVE_TELEMETRY_DISABLED: "1",
      FACTORY_REPO: "acme/widgets",
      HQ_BASE_URL: hqUrl,
      HQ_AGENT_API_KEY: agentKey,
      SLACK_SIGNING_SECRET: secret,
      SLACK_ALLOWED_TEAM_IDS: team,
    },
  )
  agent.on("exit", (code) => {
    if (!agent.stopped) {
      console.error(`[e2e slack stack] the agent exited with ${code}`)
      process.exit(code ?? 1)
    }
  })
  await waitFor(`http://127.0.0.1:${agentPort}/eve/v1/health`, agent, "the agent")
} catch (error) {
  console.error(`[e2e slack stack] ${error.message}`)
  await shutdown(1)
}
