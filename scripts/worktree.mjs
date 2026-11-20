#!/usr/bin/env node
// Git worktrees that each get their own Postgres database: `pnpm wt <command>`.
//
//   new <branch> [--base <ref>]  check out <branch> (created from <ref>, default the default branch,
//                                when it does not exist) in ../<repo>.<name>, then run setup there.
//   setup [path]                 provision an existing worktree (default: the one you are in): link
//                                the main checkout's .env, write .env.worktree, mise, pnpm install,
//                                create the worktree's database and apply the migrations to it
//                                (starter's, then hq's).
//   ls                           list worktrees with their database and pull request state.
//   rm <branch|path> [--force]   remove a worktree and drop its database. The branch is deleted
//                                only when it is merged. --force removes a worktree with changes.
//   prune [--yes]                clean up after merges: worktrees whose pull request was merged or
//                                closed (or whose upstream branch is gone), merged branches with no
//                                worktree, and databases whose worktree is gone. Prints the plan;
//                                --yes applies it. Worktrees with uncommitted changes are skipped.
//   reset-db [path]              drop, recreate and migrate the worktree's database.
//   hook-create, hook-remove     Claude Code's WorktreeCreate and WorktreeRemove hooks
//                                (.claude/settings.json): new and rm for the worktree in the JSON
//                                on stdin. hook-create prints only the path on stdout.
//
// The database is <main database>_wt_<name> on the server in the main checkout's DATABASE_URL (the
// compose Postgres). .env.worktree sets DATABASE_URL to it, and WEB_ORIGINS to the worktree's
// portless URL; mise loads it after .env (.mise.toml), so it wins. Only databases named *_wt_* are
// ever dropped. The .env files are linked, never read.
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { basename, dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"

const ENV_FILE = ".env.worktree"
const MARKER = "_wt_"
// Under a Claude Code hook, stdout carries only the result, so progress goes to stderr.
const hook = process.argv[2]?.startsWith("hook-")
if (hook) console.log = console.error

function git(args, cwd = process.cwd()) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim()
}

function tryGit(args, cwd) {
  try {
    return git(args, cwd)
  } catch {
    return null
  }
}

function run(cmd, args, cwd, env = process.env) {
  console.log(`$ ${cmd} ${args.join(" ")}`)
  const result = spawnSync(cmd, args, { cwd, env, stdio: hook ? ["ignore", 2, 2] : "inherit" })
  if (result.status !== 0) fail(`${cmd} ${args.join(" ")} failed (in ${cwd})`)
}

class WtError extends Error {}

function fail(message) {
  throw new WtError(message)
}

function worktrees() {
  const list = []
  let current
  for (const line of git(["worktree", "list", "--porcelain"]).split("\n")) {
    if (line.startsWith("worktree ")) list.push((current = { path: line.slice(9) }))
    else if (line.startsWith("HEAD ")) current.head = line.slice(5)
    else if (line.startsWith("branch ")) current.branch = line.slice(7).replace("refs/heads/", "")
    else if (line === "prunable" || line.startsWith("prunable ")) current.prunable = true
  }
  return list
}

const all = worktrees()
const main = all[0]
const root = main.path

const originHead = tryGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], root)
const defaultBranch = originHead ? originHead.replace(/^origin\//, "") : "main"

// The worktree's name: its directory without the "<repo>." prefix new gives it.
function nameOf(path) {
  const dir = basename(path)
  const prefix = `${basename(root)}.`
  return dir.startsWith(prefix) ? dir.slice(prefix.length) : dir
}

function findWorktree(target) {
  const path = resolve(target)
  return all
    .slice(1)
    .find((w) => w.path === path || w.branch === target || nameOf(w.path) === target)
}

function currentWorktree() {
  const top = tryGit(["rev-parse", "--show-toplevel"])
  return top && all.find((w) => w.path === top)
}

// --- database ---

const templateUrl = () =>
  readFileSync(join(root, ".env.example"), "utf8").match(/^DATABASE_URL=(.+)$/m)?.[1]

// The server and main database: from the environment (mise loads .env), else .env.example. Inside a
// worktree DATABASE_URL is that worktree's database, so the _wt_ suffix is taken off.
function mainDatabase() {
  const raw = process.env.DATABASE_URL || templateUrl()
  if (!raw) fail("no DATABASE_URL in the environment or .env.example")
  const url = new URL(raw)
  const name = decodeURIComponent(url.pathname.slice(1)).split(MARKER)[0]
  return { url, name }
}

function databaseUrl(dbName) {
  const url = new URL(mainDatabase().url)
  url.pathname = `/${dbName}`
  return url.toString()
}

function databaseFor(path) {
  const slug = nameOf(path)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  if (!slug) fail(`cannot name a database for ${path}`)
  return `${mainDatabase().name}${MARKER}${slug}`.slice(0, 63)
}

// The database a worktree's .env.worktree points at, if it has one.
function recordedDatabase(path) {
  const file = join(path, ENV_FILE)
  if (!existsSync(file)) return null
  const url = readFileSync(file, "utf8").match(/^DATABASE_URL=(.+)$/m)?.[1]
  return url ? decodeURIComponent(new URL(url).pathname.slice(1)) : null
}

function assertDisposable(dbName) {
  if (!/^[a-z0-9_]+$/.test(dbName) || !dbName.includes(MARKER)) {
    fail(`refusing to touch database "${dbName}": only *${MARKER}* databases are managed here`)
  }
}

async function withAdmin(fn) {
  const postgres = createRequire(join(root, "packages", "db", "package.json"))("postgres")
  const url = new URL(mainDatabase().url)
  url.pathname = "/postgres"
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {}, connect_timeout: 5 })
  try {
    return await fn(sql)
  } catch (error) {
    if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
      fail(
        `Postgres is not reachable at ${url.host}. Start it from ${root}: docker compose up -d db`,
      )
    }
    throw error
  } finally {
    await sql.end()
  }
}

async function databaseExists(sql, dbName) {
  return (await sql`select 1 from pg_database where datname = ${dbName}`).length > 0
}

async function createDatabase(dbName) {
  assertDisposable(dbName)
  await withAdmin(async (sql) => {
    if (await databaseExists(sql, dbName)) return console.log(`database ${dbName} exists`)
    await sql.unsafe(`create database "${dbName}"`)
    console.log(`created database ${dbName}`)
  })
}

async function dropDatabase(dbName) {
  assertDisposable(dbName)
  await withAdmin(async (sql) => {
    await sql.unsafe(`drop database if exists "${dbName}" with (force)`)
  })
  console.log(`dropped database ${dbName}`)
}

async function managedDatabases() {
  const prefix = `${mainDatabase().name}${MARKER}`
  return withAdmin(async (sql) =>
    (await sql`select datname from pg_database where starts_with(datname, ${prefix})`).map(
      (row) => row.datname,
    ),
  )
}

// The worktree's own migrations, so a branch's new migration applies to its database only.
// hq (apps/hq) keeps its tables in the `hq` schema with migrations of their own, applied to the same
// database here (in production hq has a database of its own; see docs/database.md).
function migrate(path, dbName) {
  const url = databaseUrl(dbName)
  run("node", ["scripts/release.mjs"], path, { ...process.env, DATABASE_URL: url })
  run("pnpm", ["--filter", "@proof/hq", "exec", "drizzle-kit", "migrate"], path, {
    ...process.env,
    HQ_DATABASE_URL: url,
  })
}

// --- commands ---

async function setup(path, { install = true } = {}) {
  if (path === root) fail("setup is for linked worktrees; the main checkout uses .env as it is")

  // A branch from before .mise.toml loaded .env.worktree would run on the linked .env, which is the
  // main database. Leave .env unlinked there, so the app stops at env validation instead.
  const layered = readFileSync(join(path, ".mise.toml"), "utf8").includes(ENV_FILE)
  const env = join(path, ".env")
  if (!layered) {
    console.warn(
      `warning: ${path}/.mise.toml does not load ${ENV_FILE}, so .env is not linked. Merge ` +
        `${defaultBranch} into this branch, then run pnpm wt setup again.`,
    )
  } else if (!existsSync(join(root, ".env"))) {
    console.warn(`warning: ${root}/.env does not exist; create it from .env.example first`)
  } else if (!lstatExists(env)) {
    symlinkSync(join(root, ".env"), env)
    console.log(`linked .env -> ${root}/.env`)
  }

  const dbName = recordedDatabase(path) ?? databaseFor(path)
  assertDisposable(dbName)
  const webOrigin = portlessUrl(path)
  writeFileSync(
    join(path, ENV_FILE),
    [
      "# Written by `pnpm wt setup` (scripts/worktree.mjs). mise loads it after .env, so these win.",
      `DATABASE_URL=${databaseUrl(dbName)}`,
      // The API trusts this origin for auth callbacks and passkeys (see .env.example).
      ...(webOrigin ? [`WEB_ORIGINS=${webOrigin}`] : []),
      // Empty, so the vite proxy follows this worktree's portless URL, not an API_URL from .env.
      "API_URL=",
      "",
    ].join("\n"),
  )
  console.log(`wrote ${ENV_FILE}`)

  if (install) {
    run("mise", ["trust", "--quiet"], path)
    run("mise", ["install"], path)
    run("pnpm", ["install", "--frozen-lockfile"], path)
  }
  await createDatabase(dbName)
  migrate(path, dbName)

  console.log(`\nReady: ${path} (${dbName})`)
  console.log(`  cd ${path} && pnpm dev${webOrigin ? `   # ${webOrigin}` : ""}`)
}

function lstatExists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

// The web app's portless URL in that worktree (portless prefixes it with the branch).
function portlessUrl(path) {
  try {
    const config = JSON.parse(readFileSync(join(root, "portless.json"), "utf8"))
    const name = config.apps?.["apps/app"]?.name
    if (!name) return null
    return execFileSync(join(root, "node_modules", ".bin", "portless"), ["get", name], {
      cwd: path,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return null
  }
}

async function create(branch, base) {
  if (!branch) fail("usage: pnpm wt new <branch> [--base <ref>]")
  const existing = all.find((w) => w.branch === branch)
  if (existing) {
    if (existing.path === root) fail(`${branch} is checked out in the main checkout`)
    console.log(`${branch} is already checked out at ${existing.path}; provisioning it`)
    await provision(existing.path)
    return existing.path
  }

  const dir = branch
    .split("/")
    .pop()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
  const path = join(dirname(root), `${basename(root)}.${dir}`)
  if (existsSync(path)) fail(`${path} already exists`)

  if (tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root)) {
    run("git", ["worktree", "add", path, branch], root)
  } else if (tryGit(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], root)) {
    run("git", ["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`], root)
  } else {
    run("git", ["worktree", "add", "-b", branch, path, base ?? defaultBranch], root)
  }
  await provision(path)
  return path
}

// Under a hook the worktree is usable without its database (tests use PGlite), so a setup failure,
// such as Postgres not running, is a warning there and Claude still gets the worktree.
async function provision(path) {
  try {
    await setup(path)
  } catch (error) {
    if (!hook) throw error
    console.error(`wt: setup did not finish (${error.message}); run pnpm wt setup in ${path}`)
  }
}

function hasGh() {
  return spawnSync("gh", ["auth", "status"], { cwd: root, stdio: "ignore" }).status === 0
}

// The newest pull request from this branch: { number, state, headRefOid }, state OPEN, MERGED or
// CLOSED.
function pullRequest(branch, gh) {
  if (!gh) return null
  try {
    const out = execFileSync(
      "gh",
      [
        "pr",
        "list",
        "--head",
        branch,
        "--state",
        "all",
        "--limit",
        "1",
        "--json",
        "number,state,headRefOid",
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    )
    return JSON.parse(out)[0] ?? null
  } catch {
    return null
  }
}

function contains(ref, branch) {
  return (
    spawnSync("git", ["merge-base", "--is-ancestor", branch, ref], { cwd: root, stdio: "ignore" })
      .status === 0
  )
}

function upstreamGone(branch) {
  const track = tryGit(["for-each-ref", "--format=%(upstream:track)", `refs/heads/${branch}`], root)
  return track === "[gone]"
}

// Done: its pull request was merged or closed, or its remote branch was deleted. Merged, so the
// branch can go: every local commit is in the merged pull request (squash merges included) or, once
// the remote branch is gone, in the default branch. A fresh branch is an ancestor of the default
// branch too, so ancestry alone does not make it done.
function status(branch, gh) {
  // A pull request counts only when it holds this branch's tip: a branch name can be reused, and a
  // fork's pull request can have the same head name.
  const found = pullRequest(branch, gh)
  const pr = found && contains(found.headRefOid, branch) ? found : null
  const gone = upstreamGone(branch)
  // A branch that was never pushed (an agent's worktree) is done once it is merged into the default
  // branch locally, or once it has sat a day without a commit. Both lose nothing.
  const local =
    !found && !tryGit(["for-each-ref", "--format=%(upstream)", `refs/heads/${branch}`], root)
  const reflog = (
    tryGit(["log", "-g", "--date=unix", "--format=%H %gd", `refs/heads/${branch}`], root) ?? ""
  ).split("\n")
  const moved = reflog.length > 1
  const updated = Number(reflog[0].match(/@\{(\d+)\}/)?.[1] ?? 0)
  const stale = Date.now() / 1000 - updated > 24 * 60 * 60
  const localDone = local && contains(defaultBranch, branch) && (moved || stale)
  const merged = pr?.state === "MERGED" || (gone && contains(defaultBranch, branch)) || localDone
  const done = merged || pr?.state === "CLOSED" || gone
  const label = found
    ? `#${found.number} ${found.state.toLowerCase()}${pr ? "" : " (not this tip)"}`
    : gone
      ? "upstream gone"
      : localDone
        ? moved
          ? "merged locally"
          : "unused for a day"
        : "no PR"
  return { merged, done, label }
}

function dirty(path) {
  return (tryGit(["status", "--porcelain"], path) ?? "") !== ""
}

async function remove(target, { force = false } = {}) {
  if (!target) fail("usage: pnpm wt rm <branch|path> [--force]")
  const wt = findWorktree(target)
  if (!wt) fail(`no linked worktree for "${target}" (see pnpm wt ls)`)
  if (dirty(wt.path) && !force) {
    fail(`${wt.path} has uncommitted changes; commit them, or pass --force to discard them`)
  }

  const dbName = recordedDatabase(wt.path)
  run("git", ["worktree", "remove", ...(force ? ["--force"] : []), wt.path], root)
  if (dbName) await dropDatabase(dbName)
  if (wt.branch) deleteBranchIfMerged(wt.branch, hasGh())
}

// Deleting is lossless when the branch is merged or holds nothing beyond the default branch.
function deleteBranchIfMerged(branch, gh) {
  if (contains(defaultBranch, branch) || status(branch, gh).merged) {
    run("git", ["branch", "-D", branch], root)
  } else {
    console.log(`kept branch ${branch} (not merged); delete it with: git branch -D ${branch}`)
  }
}

async function list() {
  const gh = hasGh()
  for (const wt of all) {
    const db = wt.path === root ? mainDatabase().name : (recordedDatabase(wt.path) ?? "(no db)")
    const pr = wt.branch && wt.path !== root ? status(wt.branch, gh).label : ""
    const flags = [dirty(wt.path) && "dirty", wt.prunable && "missing"].filter(Boolean).join(", ")
    console.log([wt.path, wt.branch ?? "(detached)", db, pr, flags].filter(Boolean).join("  "))
  }
}

async function prune({ yes = false } = {}) {
  console.log("fetching to see which remote branches are gone...")
  spawnSync("git", ["fetch", "--prune", "--quiet"], { cwd: root, stdio: "inherit" })
  const gh = hasGh()
  if (!gh) console.log("gh is not signed in: merges are found by deleted remote branches only")

  const plan = []
  const live = new Set()
  for (const wt of all.slice(1)) {
    const dbName = recordedDatabase(wt.path)
    if (wt.prunable) continue // git worktree prune drops it; its database is then an orphan
    if (dbName) live.add(dbName)
    if (!wt.branch) continue
    const s = status(wt.branch, gh)
    if (!s.done) continue
    if (dirty(wt.path)) {
      console.log(`skip ${wt.path}: ${s.label}, but it has uncommitted changes`)
      continue
    }
    plan.push({
      text: `remove ${wt.path} (${wt.branch}, ${s.label})${dbName ? `, drop ${dbName}` : ""}`,
      apply: () => remove(wt.path),
    })
  }

  const checkedOut = new Set(all.map((w) => w.branch))
  const branches = git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], root).split(
    "\n",
  )
  for (const branch of branches.filter((b) => b && !checkedOut.has(b))) {
    if (branch === defaultBranch || !status(branch, gh).merged) continue
    plan.push({
      text: `delete merged branch ${branch}`,
      apply: () => run("git", ["branch", "-D", branch], root),
    })
  }

  for (const dbName of await managedDatabases()) {
    if (live.has(dbName)) continue
    plan.push({ text: `drop ${dbName} (no worktree uses it)`, apply: () => dropDatabase(dbName) })
  }

  if (plan.length === 0) return console.log("nothing to clean up")
  for (const step of plan) console.log(`- ${step.text}`)
  if (!yes) return console.log("\nrun `pnpm wt prune --yes` to apply")
  for (const step of plan) await step.apply()
  run("git", ["worktree", "prune"], root)
}

async function resetDatabase(path) {
  if (path === root) fail("reset-db is for linked worktrees; it never touches the main database")
  const dbName = recordedDatabase(path)
  if (!dbName) fail(`${path} has no ${ENV_FILE}; run pnpm wt setup there first`)
  await dropDatabase(dbName)
  await createDatabase(dbName)
  migrate(path, dbName)
}

// --- cli ---

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    base: { type: "string" },
    force: { type: "boolean" },
    yes: { type: "boolean" },
    "skip-install": { type: "boolean" },
  },
})
const [command, target] = positionals

try {
  await dispatch()
} catch (error) {
  if (!(error instanceof WtError)) throw error
  console.error(`wt: ${error.message}`)
  process.exit(1)
}

function here(arg) {
  if (arg) return findWorktree(arg)?.path ?? fail(`no linked worktree for "${arg}"`)
  return currentWorktree()?.path ?? fail("not inside a worktree of this repository")
}

async function dispatch() {
  switch (command) {
    case "new":
      await create(target, values.base)
      break
    case "setup":
      await setup(here(target), { install: !values["skip-install"] })
      break
    case "ls":
      await list()
      break
    case "rm":
      await remove(target, { force: values.force })
      break
    case "prune":
      await prune({ yes: values.yes })
      break
    case "reset-db":
      await resetDatabase(here(target))
      break
    // Claude Code names the worktree (`claude --worktree <name>`, EnterWorktree, a subagent's
    // isolation); the name is the branch. Claude asks before removing one with changes, so remove
    // forces.
    case "hook-create": {
      const { name } = JSON.parse(readFileSync(0, "utf8"))
      process.stdout.write(`${await create(name)}\n`)
      break
    }
    case "hook-remove": {
      const { worktree_path: path } = JSON.parse(readFileSync(0, "utf8"))
      if (findWorktree(path)) await remove(path, { force: true })
      break
    }
    default: {
      // The usage is the header comment above.
      const source = readFileSync(new URL(import.meta.url), "utf8")
      console.log(source.slice(source.indexOf("\n") + 1, source.indexOf("//\n// The database")))
      process.exit(command ? 1 : 0)
    }
  }
}
