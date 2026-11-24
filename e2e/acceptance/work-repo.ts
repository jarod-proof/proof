// The synthetic repository a work journey's pull request lives on. No imports, so the factory's own
// tests can load it (support.ts needs the e2e runner and starter's support/unique, which only an org
// checkout has); support.ts exposes it as `workRepo()` for the run's tag.

/**
 * `acceptance/<tag>`, lower-cased, with every character of the tag outside `[\w.-]` replaced by a dash.
 * hq lower-cases and validates a repo as `owner/name` (`/^[\w.-]+\/[\w.-]+$/`), so this is one hq
 * accepts for any tag and that names no real repository.
 */
export function workRepoOf(tag: string): string {
  const name = tag.toLowerCase().replace(/[^\w.-]/g, "-")
  return `acceptance/${name === "" ? "-" : name}`
}
