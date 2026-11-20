// The built web app (apps/app/dist), served from the API origin so the auth cookies apply to its pages.
// Only the app's page paths get index.html (the client router takes over); unknown paths stay 404.
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { extname, join, resolve, sep } from "node:path"

import { isReservedOrgSlug } from "@proof/auth/client"
import type { Env, Hono } from "hono"

/**
 * The pages the single-page app serves. Keep in step with apps/app's routes (static.test.ts derives
 * every path from apps/app's route tree and fails when one is missing here).
 */
export const PAGE_PATHS = [
  "/sign-in",
  "/sign-up",
  "/sign-up/passkey",
  "/consent",
  "/select-organization",
  "/accept-invitation/:id",
  "/invite/:id",
  "/device",
  "/reset-password",
  "/claim",
  "/new",
  "/two-factor",
  "/account",
  "/account/*",
  "/admin",
  "/admin/*",
  "/settings/*",
] as const

/**
 * An organization's page: `/:org` is its slug. The slug shape (lowercase letters, digits, hyphens; no
 * dots) keeps `/llms.txt`, `/openapi.json` and friends out of it, and reserved slugs (`api`, `v1`,
 * `mcp`, the app's own paths...) are passed on to the API, so their 404s stay JSON.
 */
export const ORG_PAGE_PATHS = ["/:org{[a-z0-9][a-z0-9-]*}", "/:org{[a-z0-9][a-z0-9-]*}/*"] as const

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
}

/** `'sha256-…'` for each inline script in the page: the app's bootstrap code is inline. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = []
  for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (/\ssrc\s*=/i.test(m[1] ?? "")) continue
    const digest = createHash("sha256")
      .update(m[2] ?? "")
      .digest("base64")
    hashes.push(`'sha256-${digest}'`)
  }
  return hashes
}

/**
 * Same-origin resources only, inline scripts by hash, and no framing (clickjacking). Images may also
 * come from `imageOrigins`: the file store's, and social sign-in avatars.
 */
export function contentSecurityPolicy(html: string, imageOrigins: readonly string[] = []): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${inlineScriptHashes(html).join(" ")}`.trim(),
    // React sets style attributes at runtime, which a strict style-src would block.
    "style-src 'self' 'unsafe-inline'",
    ["img-src 'self' data:", ...new Set(imageOrigins)].join(" "),
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ")
}

/**
 * Serve the built web app from `distDir`. Reads index.html now, so a missing build fails at startup
 * rather than on the first page view.
 */
export function mountWeb<E extends Env>(
  app: Hono<E>,
  distDir: string,
  { imageOrigins = [] }: { imageOrigins?: readonly string[] } = {},
): void {
  const root = resolve(distDir)
  const html = readFileSync(join(root, "index.html"), "utf8")
  const pageHeaders = {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": contentSecurityPolicy(html, imageOrigins),
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "cache-control": "no-cache",
  }
  for (const path of PAGE_PATHS) {
    app.get(path, () => new Response(html, { headers: pageHeaders }))
  }
  // Registered last: a reserved slug falls through to the API's routes and its JSON 404.
  for (const path of ORG_PAGE_PATHS) {
    app.get(path, (c, next) => {
      if (isReservedOrgSlug(c.req.param("org") ?? "")) return next()
      return new Response(html, { headers: pageHeaders })
    })
  }

  // Build output is content-hashed, so it can be cached forever.
  const assetsDir = join(root, "assets")
  app.get("/assets/*", async (c) => {
    let relative: string
    try {
      relative = decodeURIComponent(c.req.path.slice("/assets/".length))
    } catch {
      return c.notFound()
    }
    const file = resolve(assetsDir, relative)
    if (!file.startsWith(`${assetsDir}${sep}`)) return c.notFound()
    try {
      if (!(await stat(file)).isFile()) return c.notFound()
    } catch {
      return c.notFound()
    }
    return new Response(await readFile(file), {
      headers: {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "cache-control": "public, max-age=31536000, immutable",
      },
    })
  })
}
