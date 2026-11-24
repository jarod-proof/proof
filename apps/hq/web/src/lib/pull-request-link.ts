/**
 * The one check before a pull request url becomes a link: the url must be exactly
 * `https://github.com/<repo>/pull/<number>` for one of the item's repos (case aside, ASCII
 * letters only). hq already rebuilds the url from the item's repo and number, so this is the
 * second lock. It returns the url it BUILT from the matching repo, never the string it was given,
 * so nothing but `https://github.com/` and the repo's own characters can ever reach an `href`.
 * Anything else (another host, userinfo, a query or fragment, a trailing slash, an encoded path,
 * another number or repo, http, a script url) is no link: null.
 */
export function pullRequestLink(
  url: string,
  number: number,
  repos: readonly string[],
): string | null {
  if (!Number.isInteger(number) || number < 1) return null
  for (const repo of repos) {
    const built = `https://github.com/${repo}/pull/${number}`
    if (asciiLower(url) === asciiLower(built)) return built
  }
  return null
}

/** Lower-case A-Z only: `toLowerCase()` also folds the Kelvin sign (U+212A) to "k". */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32))
}
