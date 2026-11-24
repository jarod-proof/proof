// Builds hq's Vercel function: bundles vercel-handler.ts (index.ts and everything it imports,
// workspace packages included) into ONE ESM file and writes it, with its config, as a Build Output
// API (v3) tree: .vercel/output/{config.json, functions/index.func/{index.mjs, .vc-config.json}}.
//
// Why a bundle: Vercel runs plain Node ESM on the emitted JavaScript, which does not resolve the
// extensionless relative imports hq's source (and the raw-TypeScript workspace packages) use, so
// the unbundled deployment built and then answered 500 on every request (ERR_MODULE_NOT_FOUND).
// Everything is bundled and nothing is external: the function needs no node_modules at runtime
// (apps/hq/src/vercel-bundle.test.ts builds into an empty directory and runs it there).
//
// The app (web/, Vite) is built into <out>/static/app, which Vercel serves from /app.
//
// Plain JavaScript on purpose: the build command runs it with `node`, no tsx. It reads no
// environment: nothing is inlined, so no secret can end up in the bundle.
//
// Usage: node scripts/build-vercel.mjs [--out <directory>]   (default: .vercel/output)
import { statSync } from "node:fs"
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { build } from "esbuild"
import { build as viteBuild } from "vite"

const hqDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** The Node major of the function; keep it at or above the engines of the repo's package.json. */
export const FUNCTION_RUNTIME = "nodejs24.x"
export const FUNCTION_FILE = "index.mjs"
/** Where the app is served, and the Vite `base` of web/. */
export const APP_BASE = "/app/"

/**
 * config.json. Headers first (`continue`), then the files Vercel serves from static/, then the
 * app shell for any /app path that is not an asset, then everything else to the function. A refused
 * hq (503) still serves the shell: the static files come before the function.
 */
export const OUTPUT_CONFIG = {
  version: 3,
  routes: [
    {
      src: "^/app(?:/.*)?$",
      headers: {
        "content-security-policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
        "x-frame-options": "DENY",
        "x-content-type-options": "nosniff",
        // Not no-referrer: it makes browsers send `Origin: null` on same-origin writes.
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

/** Writes the Build Output API tree to `outputDir`; returns the bundle's path and byte size. */
export async function buildVercelOutput(outputDir = join(hqDir, ".vercel", "output")) {
  const out = resolve(outputDir)
  const functionDir = join(out, "functions", "index.func")
  // A stale tree must not leak into this one (a file an older build wrote and this one does not).
  await rm(out, { recursive: true, force: true })
  await mkdir(functionDir, { recursive: true })

  const result = await build({
    entryPoints: [join(hqDir, "vercel-handler.ts")],
    outfile: join(functionDir, FUNCTION_FILE),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    // Dynamic imports (the lazy `import("./src/boot-hq")`) are inlined, so the bundle is one file
    // that still runs them lazily, on the first request.
    splitting: false,
    tsconfig: join(hqDir, "tsconfig.json"),
    // Some bundled CommonJS code calls require() on Node built-ins; ESM has no require.
    banner: {
      js: 'import { createRequire as __hq_createRequire } from "node:module";\nconst require = __hq_createRequire(import.meta.url);',
    },
    logLevel: "warning",
    metafile: true,
    legalComments: "none",
  })

  await writeFile(
    join(functionDir, ".vc-config.json"),
    `${JSON.stringify(
      {
        runtime: FUNCTION_RUNTIME,
        handler: FUNCTION_FILE,
        launcherType: "Nodejs",
        shouldAddHelpers: false,
        // The (req, res) handler streams, as the bundled Hono app's streaming responses (MCP) need.
        supportsResponseStreaming: true,
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(join(out, "config.json"), `${JSON.stringify(OUTPUT_CONFIG, null, 2)}\n`)

  // The app shell: web/ built by Vite into static/app, beside the function. It reads no
  // environment (envDir is off) and prints nothing unless it fails.
  const staticDir = join(out, "static", "app")
  await viteBuild({
    configFile: join(hqDir, "web", "vite.config.ts"),
    logLevel: "error",
    envDir: false,
    build: { outDir: staticDir, emptyOutDir: true },
  })

  const [file] = Object.entries(result.metafile.outputs)
  return {
    bundle: join(functionDir, FUNCTION_FILE),
    bytes: file?.[1].bytes ?? 0,
    inputs: Object.keys(result.metafile.inputs),
    staticDir,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = process.argv.indexOf("--out")
  const outDir = flag === -1 ? undefined : process.argv[flag + 1]
  const { bundle, bytes, staticDir } = await buildVercelOutput(outDir)
  const staticBytes = (await readdir(staticDir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .reduce((sum, entry) => sum + statSync(join(entry.parentPath, entry.name)).size, 0)
  process.stdout.write(
    `hq function: ${bundle} (${(bytes / 1024 / 1024).toFixed(2)} MiB), app: ${staticDir} (${(staticBytes / 1024).toFixed(0)} KiB)\n`,
  )
}
