import { anchorLink, type RenderLink } from "@proof/ui/dplus/shell/link"

/** The URL names an organization the caller is not in (or that doesn't exist). Shown inside the shell. */
export function OrgNotFoundPage({
  slug,
  renderLink = anchorLink,
}: {
  slug: string
  renderLink?: RenderLink
}) {
  const Link = renderLink
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold">No organization at this address</h1>
      <p className="text-muted-foreground">
        There is no organization at <span className="font-mono">/{slug}</span> that you belong to.
        Choose one from the organization menu, or create a new one.
      </p>
      <p>
        <Link href="/new">Create an organization</Link>
      </p>
    </div>
  )
}
