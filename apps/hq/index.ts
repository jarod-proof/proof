// The readable source of the Vercel app. It is not what Vercel runs: Vercel runs plain Node ESM,
// which cannot resolve the extensionless relative imports in this file, src/ and the workspace
// packages (they are raw TypeScript). `scripts/build-vercel.mjs` (the vercel.json buildCommand)
// bundles `vercel-handler.ts`, which wraps this app's `fetch` in a Node (req, res) handler, with
// esbuild into one file, .vercel/output/functions/index.func/index.mjs (Build Output API v3).
// vercel.json sets `framework: null`, so Vercel does not treat the project as zero-config Hono
// and does not run this file as it stands. `export default` is the app that handler serves;
// `serve()` is not used here.
//
// Importing this file boots nothing. The first request runs `bootVercel` (src/boot-hq.ts: the same
// `bootHq` server.ts runs, always as a deployed hq) once per instance, and a boot that refuses
// answers every request 503. The boot is a dynamic import so that a bad environment is that 503 and not a crash at load.
import type { Hono } from "hono"

import { createLazyHq } from "./src/lazy-hq"

const app: Hono = createLazyHq(async () =>
  (await import("./src/boot-hq")).bootVercel().then((b) => b.app),
)

export default app
