import { spawn } from "node:child_process"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { DISCOVERY_ENVIRONMENT, PROJECT_ROOT } from "./discovery.ts"

/**
 * `pnpm build` and `pnpm eval`: eve with the environment this agent needs and nothing real.
 *
 * - `build`: `eve build --skip-sandbox-prewarm` with the inert placeholders discovery uses (turbo
 *   strips the environment, and the agent's modules read FACTORY_REPO when they load). The deploy
 *   build is `pnpm build:deploy` (plain `eve build`), which prepares the Vercel Sandbox template.
 * - `eval`: the offline evals (`--tag offline`), run one at a time. It stands up the REAL hq app on
 *   in-process Postgres (PGlite) behind a local port, an agent key with exactly the agent's scope,
 *   and a probe that records what the agent did and moves hq's clock, then runs `eve eval` with the
 *   agent on scripted models (AGENT_OFFLINE=1). Nothing leaves the machine: no Slack, no GitHub, no
 *   model provider, no AI Gateway call (eve's one read of the public model catalog aside).
 */

const eveBin = join(PROJECT_ROOT, "node_modules/eve/bin/eve.js")

const runEve = (args: string[], env: Record<string, string>): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [eveBin, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...DISCOVERY_ENVIRONMENT, ...env },
      stdio: "inherit",
    })
    child.on("exit", (code) => resolve(code ?? 1))
  })

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
  })

async function evalOffline(extraArgs: string[]): Promise<number> {
  const { serve } = await import("@hono/node-server")
  const { createHqHarness, TEST_SLACK_SECRET } = await import("@proof/hq/src/app.test.helpers")

  let day = 0
  let now = new Date(Date.UTC(2032, 0, 1, 12))
  // A Slack click is signed once and checked by the agent (real time) and by hq (this clock), so
  // the Slack evals switch hq to the real clock; every other eval starts from `/day/next`.
  let realClock = false
  const hq = await createHqHarness({ now: () => (realClock ? new Date() : now) })
  const founder = await hq.signUp("founder@example.com")
  await hq.addFounder(founder, "UFOUNDER")
  // Exactly the agent's scope: read all, propose, runs and spend only.
  const key = await hq.keyFor(founder, {
    hq_entry: ["read"],
    hq_proposal: ["read", "create"],
    hq_run: ["read", "create", "update"],
    hq_spend: ["read", "record", "request"],
  })
  const hqServer = serve({ fetch: hq.app.fetch, hostname: "127.0.0.1", port: 0 })
  await new Promise<void>((resolve) => hqServer.once("listening", resolve))
  const hqPort = (hqServer.address() as AddressInfo).port

  // The probe: what the offline agent did (model calls, a bigger model run), and hq's clock.
  const events: { event: string; detail: unknown }[] = []
  const probe = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const path = request.url ?? "/"
      const reply = (body: unknown) => {
        response.setHeader("content-type", "application/json")
        response.end(JSON.stringify(body))
      }
      if (request.method === "POST" && path === "/event") {
        events.push(JSON.parse(await readBody(request)) as { event: string; detail: unknown })
        return reply({ ok: true })
      }
      if (request.method === "GET" && path === "/events") {
        return reply({ events })
      }
      if (request.method === "POST" && path === "/reset") {
        events.length = 0
        return reply({ ok: true })
      }
      if (request.method === "POST" && path === "/day/next") {
        realClock = false
        now = new Date(Date.UTC(2032, 0, ++day + 1, 12))
        events.length = 0
        return reply({ day: now.toISOString() })
      }
      if (request.method === "POST" && path === "/clock/real") {
        realClock = true
        events.length = 0
        return reply({ now: new Date().toISOString() })
      }
      // Where a card click's `response_url` points: what the founder would be shown in Slack.
      if (request.method === "POST" && path === "/response") {
        events.push({ event: "slack-response", detail: JSON.parse(await readBody(request)) })
        return reply({ ok: true })
      }
      response.statusCode = 404
      reply({ error: "not found" })
    })()
  })
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const probePort = (probe.address() as AddressInfo).port

  let code = 1
  try {
    code = await runEve(["eval", "--tag", "offline", "--max-concurrency", "1", ...extraArgs], {
      AGENT_OFFLINE: "1",
      AGENT_FOUNDER_PRINCIPALS: "local-dev",
      AGENT_PROBE_URL: `http://127.0.0.1:${probePort}`,
      HQ_AGENT_API_KEY: key,
      HQ_BASE_URL: `http://127.0.0.1:${hqPort}`,
      SLACK_ALLOWED_TEAM_IDS: "T0",
      // The nightly digest posts here; offline, the post goes to the probe and nowhere else.
      SLACK_DIGEST_CHANNEL_ID: "C0OFFLINE",
      // The agent verifies Slack clicks with the secret hq holds (the harness's), then forwards.
      SLACK_SIGNING_SECRET: TEST_SLACK_SECRET,
    })
  } finally {
    probe.close()
    hqServer.close()
    await hq.close()
  }
  return code
}

const [mode, ...rest] = process.argv.slice(2)
if (mode === "build") {
  // Without the flag `eve build` prepares a Vercel Sandbox template, which calls the Vercel API
  // with the project's credentials. The lab build stays offline; a deploy uses `build:deploy`.
  process.exitCode = await runEve(["build", "--skip-sandbox-prewarm", ...rest], {})
} else if (mode === "eval") {
  process.exitCode = await evalOffline(rest)
} else {
  process.stderr.write("usage: tsx scripts/run.ts build|eval [eve args]\n")
  process.exitCode = 2
}
