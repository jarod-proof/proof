import {
  Outlet,
  createFileRoute,
  notFound,
  useRouter,
  useRouterState,
} from "@tanstack/react-router"
import { isReservedOrgSlug } from "@proof/auth/client"
import { Button } from "@proof/ui/components/ui/button"

import { AppShellContainer } from "../containers/app-shell"
import { OrgFeatures } from "../containers/org-features"
import { OrgGate } from "../containers/org-gate"
import { RouterLink } from "../containers/router-link"
import { useOrganizationsQuery } from "../containers/shell-data"
import { requireSession } from "../lib/guards"
import { activeNavFor, settingsCrumbs } from "../lib/org-nav"
import { getWorkspaceAgentsApi } from "../lib/workspace-agents-api"
import { getWebAuth } from "../lib/web-auth"
import { OrgNotFoundPage } from "../pages/org-not-found-page"

// The organization's pages: /:org (the slug). Signed-out visitors go to sign-in and come back here.
export const Route = createFileRoute("/$org")({
  beforeLoad: async ({ context, location, params }) => {
    // Reserved slugs are the app's own paths (/two-factor, /admin...) that have no client route yet.
    // They are not organizations, so they must not reach the session check and bounce through sign-in.
    if (isReservedOrgSlug(params.org)) throw notFound()
    if (typeof window === "undefined") return
    await requireSession(context.queryClient, getWebAuth(), location.href)
  },
  component: OrgLayout,
})

function OrgLayout() {
  const { org: slug } = Route.useParams()
  const auth = getWebAuth()
  const router = useRouter()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const organizations = useOrganizationsQuery(auth)
  const organization = organizations.data?.find((org) => org.slug === slug)

  return (
    <AppShellContainer
      auth={auth}
      slug={slug}
      activeNav={activeNavFor(pathname, slug)}
      agents={getWorkspaceAgentsApi()}
      crumbs={[{ label: organization?.name ?? slug }, ...settingsCrumbs(pathname, slug)]}
      onNavigate={(href) => void router.navigate({ href })}
      onSignedOut={() => void router.navigate({ href: "/sign-in", replace: true })}
    >
      {organizations.isPending ? (
        <output className="block p-6 text-muted-foreground">Loading…</output>
      ) : organization ? (
        <OrgGate
          auth={auth}
          organization={organization}
          signInHref={`/sign-in?next=${encodeURIComponent(pathname)}`}
        >
          <OrgFeatures organizationId={organization.id}>
            <Outlet />
          </OrgFeatures>
        </OrgGate>
      ) : organizations.isError ? (
        // A failed list is not an answer: say so, rather than that the organization is missing.
        <div role="alert" className="flex flex-col items-start gap-3 p-6">
          <p>Could not load your organizations.</p>
          <Button type="button" variant="outline" onClick={() => void organizations.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <OrgNotFoundPage slug={slug} renderLink={RouterLink} />
      )}
    </AppShellContainer>
  )
}
