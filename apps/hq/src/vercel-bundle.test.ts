// Proves hq runs on Vercel's runtime: plain Node ESM, no tsx, no vitest, no node_modules. tsx and
// vitest both resolve the extensionless relative imports hq's source uses, so a test that imports
// hq cannot see the bug that made the first Vercel deployment answer 500 on every request
// (ERR_MODULE_NOT_FOUND). Here the build script runs as `node`, into an empty directory, and the
// built function runs as a separate `node` process with an empty environment.
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { builtinModules } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { transform } from "esbuild"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const hqDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const script = join(hqDir, "scripts", "build-vercel.mjs")

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
}

// Values a build environment might hold; none of them may reach the bundle.
const CANARIES = {
  DATABASE_URL: "postgres://canary-user:canary-db-password-31337@canary.invalid/canary",
  BETTER_AUTH_SECRET: "canary-auth-secret-31337",
}

describe("the Vercel function bundle", () => {
  let out = ""
  let functionDir = ""
  let bundlePath = ""
  let bundle = ""

  beforeAll(() => {
    // Outside the repository: nothing the bundle needs may come from a node_modules above it.
    out = mkdtempSync(join(tmpdir(), "hq-vercel-"))
    const built = spawnSync(process.execPath, [script, "--out", out], {
      env: { ...CANARIES },
      encoding: "utf8",
    })
    expect(built.stderr).toBe("")
    expect(built.status).toBe(0)
    functionDir = join(out, "functions", "index.func")
    bundlePath = join(functionDir, "index.mjs")
    bundle = readFileSync(bundlePath, "utf8")
  }, 120_000)

  afterAll(() => {
    if (out.startsWith(tmpdir())) rmSync(out, { recursive: true, force: true })
  })

  it("writes a Build Output API (v3) tree with a catch-all route to the function", () => {
    expect(readJson(join(out, "config.json"))).toEqual({
      version: 3,
      routes: [{ src: "/(.*)", dest: "/index" }],
    })
    expect(readJson(join(functionDir, ".vc-config.json"))).toEqual({
      runtime: expect.stringMatching(/^nodejs\d+\.x$/),
      handler: "index.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
    })
    expect(existsSync(bundlePath)).toBe(true)
  })

  it("declares a Node runtime at least the root engines", () => {
    const engines = readJson(join(hqDir, "..", "..", "package.json")).engines as { node: string }
    const wanted = Number(/\d+/.exec(engines.node)?.[0])
    const runtime = readJson(join(functionDir, ".vc-config.json")).runtime as string
    expect(Number(/^nodejs(\d+)\.x$/.exec(runtime)?.[1])).toBeGreaterThanOrEqual(wanted)
  })

  it("is one self-contained file: no relative specifier, no import of a package", async () => {
    // Comments dropped: dependencies' JSDoc is full of `import('./x.js')` type references.
    const { code } = await transform(bundle, { minifyWhitespace: true, format: "esm" })
    // Static imports, dynamic imports and CommonJS loads of a relative path: all bundled away.
    const relative = [
      ...code.matchAll(
        /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](\.{1,2}\/[^"']*)["']/g,
      ),
    ].map((m) => m[1] as string)
    const missing = relative.filter((spec) => !existsSync(resolve(functionDir, spec)))
    expect(missing).toEqual([])
    expect(relative).toEqual([])
    // Nothing is external: the only module specifiers left are Node built-ins (the output dir
    // has no node_modules, so a bare package specifier would fail at run time).
    const bare = [...bundle.matchAll(/^import[^"'\n]*?from\s*["']([^"'.][^"']*)["']/gm)].map(
      (m) => m[1] as string,
    )
    const isBuiltin = (spec: string) => spec.startsWith("node:") || builtinModules.includes(spec)
    expect(bare.filter((spec) => !isBuiltin(spec))).toEqual([])
    // The same for run-time loads (the banner makes `require` real): a package left unresolved
    // would be loaded from a directory with no node_modules. Only built-ins may be loaded by
    // name, apart from the optional ones below, each of which its caller tries inside a
    // try/catch (or names in a message or in generated code) and which hq's deployment does not
    // use. A new entry here is a decision: add the package to hq's dependencies instead, so
    // that it is bundled, unless it is optional in the same way.
    const optionalAtRunTime = [
      "@opentelemetry/api", // better-auth telemetry: try/catch, a no-op without it
      "@aws-sdk/signature-v4-crt", // named in an error message
      "@aws-sdk/signature-v4a", // named in an error message
      "@react-email/components", // @wraps.dev/email: only when a React element is sent
      "@vercel/oidc-aws-credentials-provider", // @wraps.dev/email: only with AWS_ROLE_ARN on Vercel
    ]
    const loaded = [
      ...code.matchAll(/(?:\brequire|\bimport)\s*\(\s*["']([^"'.][^"']*)["']\s*\)/g),
    ].map((m) => m[1] as string)
    expect(
      loaded.filter(
        (spec) =>
          !(
            isBuiltin(spec) ||
            optionalAtRunTime.includes(spec) ||
            // ajv's standalone code generator writes these into the source it generates.
            spec.startsWith("ajv/") ||
            spec.startsWith("ajv-formats/")
          ),
      ),
    ).toEqual([])
  })

  it("embeds no environment value", () => {
    for (const secret of Object.values(CANARIES)) expect(bundle).not.toContain(secret)
  })

  /** Runs the built function as its own `node` process, serving two requests from `env`. */
  function runFunction(env: Record<string, string>) {
    const driver = `
      import { createServer } from "node:http"
      const handler = (await import(process.argv[1])).default
      const server = createServer(handler)
      await new Promise((ready) => server.listen(0, "127.0.0.1", ready))
      const { port } = server.address()
      const replies = []
      // Two requests: the second meets the kept (memoized) refusal, not a fresh boot.
      for (const path of ["/health", "/mcp"]) {
        const res = await fetch("http://127.0.0.1:" + port + path, { method: "POST", body: "{}" })
        replies.push({
          status: res.status,
          body: await res.text(),
          cacheControl: res.headers.get("cache-control"),
          contentType: res.headers.get("content-type"),
        })
      }
      server.close()
      console.log(JSON.stringify(replies))
    `
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", driver, bundlePath], {
      env,
      cwd: out,
      encoding: "utf8",
      timeout: 60_000,
    })
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0)
    const replies = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "[]") as unknown[]
    // (The logger writes to stdout, the env validation to stderr.)
    return { replies, logged: `${run.stdout}\n${run.stderr}` }
  }

  const refused = ["/health", "/mcp"].map(() => ({
    status: 503,
    body: JSON.stringify({ error: "service unavailable" }),
    cacheControl: "no-store",
    contentType: "application/json",
  }))

  it("loads under plain node and answers 503 {error} with no-store from an empty environment", () => {
    const { replies, logged } = runFunction({})
    expect(replies).toEqual(refused)
    // The 503 is the refusal of hq's own boot (src/env.ts rejects the empty environment, once),
    // not a module that failed to load: every module of the app was found and evaluated.
    expect(logged).toContain("hq refused to boot")
    expect(logged).toContain("Invalid environment variables")
    expect(logged).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/)
    expect(logged.match(/hq refused to boot/g)).toHaveLength(1)
  }, 90_000)

  it("runs the boot itself, database driver included, from a fabricated environment", () => {
    // A complete environment whose database is a closed local port: the boot reads and validates
    // it, builds the database client and reaches the founders check, and is refused only because
    // nothing listens there. Whatever the bundle failed to carry (a driver, a file next to it)
    // would show as another error.
    const dead = "postgres://user:password@127.0.0.1:1/hq"
    const { replies, logged } = runFunction({
      HQ_DATABASE_URL: dead,
      DATABASE_URL: dead,
      BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef0123456789", // gitleaks:allow
      BETTER_AUTH_URL: "https://hq.invalid",
      EMAIL_FROM: "hq@example.invalid",
    })
    expect(replies).toEqual(refused)
    expect(logged).toContain("ECONNREFUSED")
    expect(logged).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find (module|package)|ReferenceError/)
  }, 90_000)
})

describe("vercel.json", () => {
  const config = readJson(join(hqDir, "vercel.json"))

  it("is not zero-config Hono: Vercel must not run the raw TypeScript", () => {
    expect(config.framework).toBeNull()
  })

  it("builds with the bundle script under plain node", () => {
    expect(config.buildCommand).toBe("node scripts/build-vercel.mjs")
    expect(existsSync(script)).toBe(true)
  })

  it("installs hq's dependencies with devDependencies, whatever NODE_ENV says, without scripts", () => {
    // The build needs esbuild and @proof/config (the tsconfig it extends), both devDependencies, and
    // the production environment sets NODE_ENV=production, which some pnpm versions read as --prod.
    expect(config.installCommand).toBe(
      "cd ../.. && pnpm install --frozen-lockfile --ignore-scripts --prod=false --filter @proof/hq...",
    )
  })

  it("pins esbuild to an exact version", () => {
    const devDependencies = readJson(join(hqDir, "package.json")).devDependencies as Record<
      string,
      string
    >
    expect(devDependencies.esbuild).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
