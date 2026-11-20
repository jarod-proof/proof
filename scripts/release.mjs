#!/usr/bin/env node
// Release phase: apply the committed Drizzle migrations to DATABASE_URL, then exit.
//
// Run it once per deploy, before the new version takes traffic: a platform's release step (Fly
// release_command, Render preDeploy) or the compose `migrate` one-shot. It is the migration path
// the image ships with. Do not run it against a database from an agent session, except a worktree's
// own *_wt_* database through `pnpm wt` (scripts/worktree.mjs).
//
// It delegates to drizzle-kit's `migrate` in packages/db, which applies the same migrations folder
// with the same bookkeeping table as the app's drizzle migrator. The only env it reads is
// DATABASE_URL; the full @proof/env validation would demand the auth secrets a migration never uses.
import { spawn } from "node:child_process"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const dbDir = join(root, "packages", "db")

if (!process.env.DATABASE_URL) {
  console.error("release: DATABASE_URL is not set; no migrations applied")
  process.exit(1)
}

const child = spawn(join(dbDir, "node_modules", ".bin", "drizzle-kit"), ["migrate"], {
  cwd: dbDir,
  env: process.env,
  stdio: "inherit",
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal))
}

child.on("error", (error) => {
  console.error(`release: could not start drizzle-kit: ${error.message}`)
  process.exit(1)
})

child.on("exit", (code, signal) => {
  if (signal) process.exit(1)
  process.exit(code ?? 1)
})
