import { existsSync, readFileSync, statSync } from "node:fs"
import { extname, join, resolve, sep } from "node:path"

import { Hono } from "hono"

// The built app (web/dist) served by the Node listener, the local twin of what Vercel does from
// the Build Output config (scripts/build-vercel.mjs, OUTPUT_CONFIG): the same security headers on
// everything under /app, immutable caching on hashed assets, and the shell with no-store for every
// other /app path. web-static.test.ts compares these constants to OUTPUT_CONFIG, so they cannot
// drift. They are copied, not imported: the build script pulls in esbuild and vite.
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
}
const IMMUTABLE = "public, max-age=31536000, immutable"
// A hashed asset that does not exist must never be cached (Vercel's config would label even a
// missing one immutable; here it is a 404 with no-store).
const NO_STORE = "no-store"
const ASSET_PREFIX = "/app/assets/"
// The same pattern as the config's shell route.
export const SHELL_PATTERN = /^\/app(?:\/(?!assets\/).*)?$/
const ASSET_NAME = /^[\w.-]+$/

const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
}

/** The file for `/app/assets/<name>` inside `dir/assets`, or null: flat, plain names only. */
function assetFile(root: string, path: string): string | null {
  let rest: string
  try {
    rest = decodeURIComponent(path.slice(ASSET_PREFIX.length))
  } catch {
    return null
  }
  const segments = rest.split("/")
  if (segments.some((s) => s === "." || s === ".." || !ASSET_NAME.test(s))) return null
  const file = resolve(root, "assets", ...segments)
  if (!file.startsWith(join(root, "assets") + sep)) return null
  try {
    return statSync(file).isFile() ? file : null
  } catch {
    return null
  }
}

/** The web app for the built files in `dir`, or null when there is no `index.html` there. */
export function createWebApp(options: { dir: string }): Hono | null {
  const root = resolve(options.dir)
  const indexPath = join(root, "index.html")
  if (!existsSync(indexPath)) return null
  const index = readFileSync(indexPath)

  const app = new Hono()
  app.use("*", async (c, next) => {
    await next()
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(name, value)
  })
  app.get("*", (c) => {
    const path = c.req.path
    if (path.startsWith(ASSET_PREFIX) && path.length > ASSET_PREFIX.length) {
      const file = assetFile(root, path)
      if (!file) return c.body("Not found", 404, { "cache-control": NO_STORE })
      return c.body(readFileSync(file), 200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "cache-control": IMMUTABLE,
      })
    }
    if (SHELL_PATTERN.test(path)) {
      return c.body(index, 200, {
        "content-type": TYPES[".html"] as string,
        "cache-control": NO_STORE,
      })
    }
    return c.body("Not found", 404, { "cache-control": NO_STORE })
  })
  app.all("*", (c) => c.body("Not found", 404, { "cache-control": NO_STORE }))
  return app
}

type Fetch = (request: Request, env?: object) => Response | Promise<Response>

/**
 * The listener's one fetch: `/app` and `/app/*` go to the web app, everything else to hq. The
 * second argument is the Node adapter's bindings (`{ incoming, outgoing }`). Nothing in hq reads
 * them today (auth takes the caller's address from a trusted header); both sides get them so a
 * later `getConnInfo` sees the caller, as apps/api's does. Without a web app it is hq's own fetch.
 */
export function routeToWeb(web: { fetch: Fetch } | null, app: { fetch: Fetch }): Fetch {
  if (!web) return (request, env) => app.fetch(request, env)
  return (request, env) => {
    const { pathname } = new URL(request.url)
    return pathname === "/app" || pathname.startsWith("/app/")
      ? web.fetch(request, env)
      : app.fetch(request, env)
  }
}
