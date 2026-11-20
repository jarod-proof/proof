import type { E2EConfig } from "e2e"
import { web } from "@e2e-dev/web"
import { gateway } from "ai"

import {
  DKIM_DIR,
  OPERATOR_ORGANIZATION_ID,
  OPERATOR_SLUG,
  STACKS_DIR,
  SUPPORT_REPLY_DOMAIN,
} from "./e2e/support/support-stack"

// Port 0: the runner picks a free port and passes it to the stack as {port}, so runs never clash. A
// running `pnpm dev` (portless, https) is not reused; portless serves https://app.proof.localhost
// and the runner needs plain http on its own port.
// One app process for every target: targets that declare the same app.command share it.
// The app is the web dev server (apps/app, Vite) and the API (apps/api), started by scripts/e2e-stack.mjs.
// The API needs Postgres with the migrations applied (DATABASE_URL, from the runner's environment or
// .env). The journeys sign up, so they need the dev mail sink (DEV_MAIL_SINK) as well.
// Only what the stack needs is passed on: the child inherits nothing else from the runner.
// The platform admin the admin journey (e2e/admin.e2e.ts) signs in as. The stack signs it up and
// promotes it at startup, so the defaults work against a fresh database; set both to use another account.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || "admin@example.test"
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || "e2e admin on the local stack only"

const stackEnv: Record<string, string> = {
  // Unset: each stack picks a free API port (desktop and phone run side by side).
  E2E_API_PORT: process.env.E2E_API_PORT ?? "",
  // The mail sink runs only under NODE_ENV development or test (packages/env refuses it otherwise).
  NODE_ENV: "development",
  DEV_MAIL_SINK: "true",
  EMAIL_FROM: process.env.EMAIL_FROM ?? "noreply@example.com",
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "",
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  E2E_ADMIN_EMAIL: ADMIN_EMAIL,
  E2E_ADMIN_PASSWORD: ADMIN_PASSWORD,
  // Support (docs/support.md, e2e/support-*.e2e.ts): the stack seeds the operator organization with
  // the admin as owner. Thread mail goes out at once (a sweep a second) into the mail sink, and
  // inbound mail comes in through a raw relay whose secret the stack makes; DKIM keys come from
  // DKIM_DIR (scripts/e2e-dkim-dns.mjs).
  OPERATOR_ORGANIZATION_ID,
  E2E_OPERATOR_SLUG: OPERATOR_SLUG,
  SUPPORT_REPLY_DOMAIN,
  SUPPORT_REPLY_DELAY_MS: "0",
  SUPPORT_SWEEP_INTERVAL_MS: "1000",
  E2E_DKIM_DIR: DKIM_DIR,
  // Each stack makes its own inbound relay secret and writes it here with its URLs (support-stack.ts).
  E2E_STACKS_DIR: STACKS_DIR,
}
for (const [key, value] of Object.entries(stackEnv)) if (value === "") delete stackEnv[key]

const app = {
  url: "http://127.0.0.1:0",
  command: {
    executable: "node",
    args: ["scripts/e2e-stack.mjs", "{port}"],
    env: stackEnv,
    log: ".e2e/logs/app.log",
    startupTimeout: 120_000,
  },
}

// The password is a function so it is never a plain string in the config the model sees. Override per
// run with E2E_USER_ADMIN_* (the stack still seeds E2E_ADMIN_EMAIL, so set both pairs together).
const credentials = {
  admin: {
    username: ADMIN_EMAIL,
    password: () => ADMIN_PASSWORD,
  },
}

export default {
  credentials,
  tests: "e2e/**/*.e2e.ts",
  targets: [
    { name: "desktop", engine: web(), app },
    { name: "phone", engine: web({ viewport: { width: 390, height: 844 } }), app },
  ],
  // The model behind agent.* steps. The smoke and app-shell tests use none, so they run without a key.
  // gateway() reads AI_GATEWAY_API_KEY from the runner's own environment (not packages/env).
  agents: {
    default: {
      model: gateway("openai/gpt-6-luna-fast"),
      system: "You are a thorough QA agent. Verify every outcome on screen.",
    },
  },
} satisfies E2EConfig
