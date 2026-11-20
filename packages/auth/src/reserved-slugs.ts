// Organization slugs are public URL segments (`/:org`), so they can't shadow the app's own routes or
// the API's paths. Creating or renaming an organization to one of these is refused. Plain data with
// no imports: the web app reuses it from `@proof/auth/client`.
export const RESERVED_ORG_SLUGS = [
  "new",
  "account",
  "admin",
  "api",
  "v1",
  "mcp",
  "settings",
  "invite",
  "two-factor",
  "consent",
  "device",
  "claim",
  "sign-in",
  "sign-up",
  "reset-password",
  "select-organization",
  "accept-invitation",
  "well-known",
  "health",
  "status",
  "openapi",
  "llms",
  "auth",
  "static",
  "assets",
  "files",
] as const

const reserved: ReadonlySet<string> = new Set(RESERVED_ORG_SLUGS)

/** Whether a slug is one of RESERVED_ORG_SLUGS (case-insensitive). */
export const isReservedOrgSlug = (slug: string): boolean => reserved.has(slug.trim().toLowerCase())

/** Lower-case, hyphenated form of a name, as better-auth derives a slug when none is given. */
export const slugOf = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
