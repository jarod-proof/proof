import { Link } from "@tanstack/react-router"

import type { LinkProps } from "@proof/ui/dplus/shell/link"

const EXACT = { exact: true, includeSearch: true } as const

/**
 * The shell's link renderer for TanStack Router: client navigation for app paths. Plain anchors
 * (and anything with a file extension, such as /llms.txt) are served by the API, so they load in
 * full. Shell components pass `href`; the router takes `to`.
 */
export function RouterLink({ href, ...rest }: LinkProps) {
  const { children, ...anchor } = rest
  if (/\.[a-z]+$/i.test(href.split("?")[0] ?? "")) {
    return (
      <a href={href} {...anchor}>
        {children}
      </a>
    )
  }
  // A query string (e.g. `?view=budgets`) goes to the router's `search`, not into `to`.
  const [path = "", query] = href.split("?")
  // The shell components set `aria-current` themselves. The router adds its own when a link is
  // active, and by default `/acme` is active on `/acme/settings` and `/acme?status=failed`, so only
  // an exact match may add it.
  if (query === undefined) return <Link {...rest} to={href as "/"} activeOptions={EXACT} />
  const search = Object.fromEntries(new URLSearchParams(query))
  return <Link {...rest} to={path as "/"} search={search} activeOptions={EXACT} />
}
