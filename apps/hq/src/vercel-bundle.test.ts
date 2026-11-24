// Proves hq runs on Vercel's runtime: plain Node ESM, no tsx, no vitest, no node_modules. tsx and
// vitest both resolve the extensionless relative imports hq's source uses, so a test that imports
// hq cannot see the bug that made the first Vercel deployment answer 500 on every request
// (ERR_MODULE_NOT_FOUND). Here the build script runs as `node`, into an empty directory, and the
// built function runs as a separate `node` process with an empty environment.
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { builtinModules } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

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
  // The one name Vite would expose to client code, were `import.meta.env.VITE_*` read anywhere.
  VITE_CANARY: "canary-vite-31337",
}

/** The Build Output config the build writes, and what Vercel serves: headers, files, shell, function. */
const OUTPUT_CONFIG = {
  version: 3,
  routes: [
    {
      src: "^/app(?:/.*)?$",
      headers: {
        "content-security-policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
        "referrer-policy": "same-origin",
      },
      continue: true,
    },
    {
      src: "^/app/assets/.+$",
      headers: { "cache-control": "public, max-age=31536000, immutable" },
      continue: true,
    },
    {
      src: "^/app(?:/(?!assets/).*)?$",
      headers: { "cache-control": "no-store" },
      continue: true,
    },
    { handle: "filesystem" },
    { src: "^/app(?:/(?!assets/).*)?$", dest: "/app/index.html" },
    { src: "/(.*)", dest: "/index" },
  ],
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  )
}

describe("the Vercel function bundle", () => {
  let out = ""
  let functionDir = ""
  let bundlePath = ""
  let bundle = ""
  let inputs: string[] = []

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
    // The same build, called as a function by a second plain node, for what it returns.
    const second = mkdtempSync(join(tmpdir(), "hq-vercel-inputs-"))
    try {
      const called = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const { buildVercelOutput } = await import(process.argv[1])
           const { inputs } = await buildVercelOutput(process.argv[2])
           console.log(JSON.stringify(inputs))`,
          pathToFileURL(script).href,
          second,
        ],
        { env: { ...CANARIES }, cwd: hqDir, encoding: "utf8" },
      )
      expect(called.status, called.stderr).toBe(0)
      inputs = JSON.parse(called.stdout.trim().split("\n").at(-1) ?? "[]") as string[]
    } finally {
      rmSync(second, { recursive: true, force: true })
    }
  }, 240_000)

  afterAll(() => {
    if (out.startsWith(tmpdir())) rmSync(out, { recursive: true, force: true })
  })

  it("writes the Build Output config: app headers, the filesystem, the app shell, then the function", () => {
    expect(readJson(join(out, "config.json"))).toEqual(OUTPUT_CONFIG)
    expect(readJson(join(functionDir, ".vc-config.json"))).toEqual({
      runtime: expect.stringMatching(/^nodejs\d+\.x$/),
      handler: "index.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
    })
    expect(existsSync(bundlePath)).toBe(true)
  })

  it("serves the app shell and hashed assets from static/app", () => {
    const html = readFileSync(join(out, "static", "app", "index.html"), "utf8")
    expect(html).toContain('<div id="root">')
    expect(html).toContain('src="/app/assets/')
    const assets = readdirSync(join(out, "static", "app", "assets"))
    expect(assets.some((f) => f.endsWith(".js"))).toBe(true)
    expect(assets.some((f) => f.endsWith(".css"))).toBe(true)
  })

  it("the built index.html has no inline script and no style attribute", () => {
    const html = readFileSync(join(out, "static", "app", "index.html"), "utf8")
    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0])
    expect(scripts.length).toBeGreaterThan(0)
    for (const tag of scripts) expect(tag).toMatch(/\bsrc=/)
    expect(html).not.toMatch(/<script\b(?![^>]*\bsrc=)/i)
    expect(html).not.toMatch(/\sstyle\s*=/i)
    expect(html).not.toMatch(/<style\b/i)
  })

  it("the shell fallback matches deep links and leaves assets, /admin and /v1 to the function", () => {
    const route = OUTPUT_CONFIG.routes.find((r) => "dest" in r && r.dest === "/app/index.html")
    const shell = new RegExp((route as { src: string }).src)
    for (const path of ["/app", "/app/", "/app/digest", "/app/approvals/"]) {
      expect(shell.test(path), path).toBe(true)
    }
    for (const path of ["/app/assets/x.js", "/application", "/admin/proposals", "/v1/status"]) {
      expect(shell.test(path), path).toBe(false)
    }
  })

  it("no environment value reaches any file under static/", () => {
    const files = filesUnder(join(out, "static"))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(file, "utf8")
      for (const secret of Object.values(CANARIES)) expect(text, file).not.toContain(secret)
    }
  })

  it("the function bundle takes no web input", () => {
    expect(inputs.length).toBeGreaterThan(0)
    // (Paths are relative to the build's working directory, hq's; dependencies may have a web/.)
    const webDir = join(hqDir, "web") + sep
    expect(inputs.filter((path) => resolve(hqDir, path).startsWith(webDir))).toEqual([])
  })

  it("the bundle carries no lab-named identifier", () => {
    expect(bundle).not.toMatch(/__lab_/)
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
