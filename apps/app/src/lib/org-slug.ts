import { isReservedOrgSlug } from "@proof/auth/client"

/**
 * An organization's URL slug is the first path segment (`/:org`). Lowercase letters, digits and
 * hyphens only, so it never contains a dot (API paths like `/llms.txt` can't be a slug).
 * apps/api's static.ts uses the same shape for its page routes.
 */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/
export const SLUG_MAX_LENGTH = 48

export type SlugProblem = "empty" | "shape" | "reserved" | null

/** Why a slug can't be used, or null when its shape and reservation are fine. Availability is separate. */
export function slugProblem(slug: string): SlugProblem {
  if (slug.length === 0) return "empty"
  if (slug.length > SLUG_MAX_LENGTH || !SLUG_PATTERN.test(slug)) return "shape"
  if (isReservedOrgSlug(slug)) return "reserved"
  return null
}

/** The name turned into a slug: lowercase, runs of other characters become one hyphen. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/, "")
}
