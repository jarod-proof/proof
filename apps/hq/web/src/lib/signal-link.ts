export interface SignalLink {
  /** The url this module built, never the string it was given. */
  href: string
  kind: "issue" | "pull request" | "commit"
}

const REPO = /^[\w.-]+\/[\w.-]+$/
const KIND = { issues: "issue", pull: "pull request", commit: "commit" } as const

/**
 * The one check before a signal's url becomes a link: hq must have checked it (`urlChecked`), and
 * it must be exactly `https://github.com/<repo>/issues/<n>`, `.../pull/<n>` or `.../commit/<sha>` of
 * the item's own repo (no query, fragment, credentials or trailing slash). It returns the url it
 * BUILT, so nothing but `https://github.com/` and the repo's own characters can reach an `href`.
 * Anything else is no link: the page shows the text it was given.
 */
export function signalLink(
  url: string | null,
  repo: string,
  urlChecked: boolean,
): SignalLink | null {
  if (!urlChecked || url === null || !REPO.test(repo)) return null
  const prefix = `https://github.com/${repo}/`
  if (asciiLower(url.slice(0, prefix.length)) !== asciiLower(prefix)) return null
  const match = /^(?:(issues|pull)\/([1-9]\d{0,9})|(commit)\/([0-9a-f]{7,40}))$/i.exec(
    url.slice(prefix.length),
  )
  if (!match) return null
  const segment = asciiLower(match[1] ?? match[3] ?? "") as keyof typeof KIND
  const id = asciiLower(match[2] ?? match[4] ?? "")
  return { href: `${prefix}${segment}/${id}`, kind: KIND[segment] }
}

/** Lower-case A-Z only: `toLowerCase()` also folds the Kelvin sign (U+212A) to "k". */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32))
}
