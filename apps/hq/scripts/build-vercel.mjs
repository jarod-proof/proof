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
// Plain JavaScript on purpose: the build command runs it with `node`, no tsx. It reads no
// environment: nothing is inlined, so no secret can end up in the bundle.
//
// Usage: node scripts/build-vercel.mjs [--out <directory>]   (default: .vercel/output)
import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { build } from "esbuild"

const hqDir = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/** The Node major of the function; keep it at or above the engines of the repo's package.json. */
export const FUNCTION_RUNTIME = "nodejs24.x"
export const FUNCTION_FILE = "index.mjs"

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
      js: 'import { createRequire as __lab_createRequire } from "node:module";\nconst require = __lab_createRequire(import.meta.url);',
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
  await writeFile(
    join(out, "config.json"),
    `${JSON.stringify({ version: 3, routes: [{ src: "/(.*)", dest: "/index" }] }, null, 2)}\n`,
  )

  const [file] = Object.entries(result.metafile.outputs)
  return { bundle: join(functionDir, FUNCTION_FILE), bytes: file?.[1].bytes ?? 0 }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flag = process.argv.indexOf("--out")
  const outDir = flag === -1 ? undefined : process.argv[flag + 1]
  const { bundle, bytes } = await buildVercelOutput(outDir)
  process.stdout.write(`hq function: ${bundle} (${(bytes / 1024 / 1024).toFixed(2)} MiB)\n`)
}
