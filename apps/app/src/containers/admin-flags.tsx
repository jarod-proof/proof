import { Button } from "@proof/ui/components/ui/button"
import type { RenderLink } from "@proof/ui/dplus/shell/link"

import { adminTabs } from "../lib/admin-nav"
import { getFeatureFlagsApi } from "../lib/feature-flags-api"
import type { WebAuth } from "../lib/web-auth"
import { AdminNotAvailable } from "../pages/admin-page"
import { type AdminAccessApis, useAdminAccess } from "./admin-access"
import { FeatureFlagsContainer } from "./feature-flags"
import { OrgGate } from "./org-gate"
import { useOrganizationsQuery } from "./shell-data"

export interface AdminFlagsContainerProps {
  auth: WebAuth
  /** Defaults to the browser's APIs; the flags calls go through `apis.flags`. */
  apis?: AdminAccessApis
  renderLink?: RenderLink
}

/**
 * The admin console's Feature flags tab. The rollouts are the operator organization's, so the
 * session moves to it (OrgGate) whatever organization it was on; anyone outside it is told the tab
 * isn't theirs.
 */
export function AdminFlagsContainer({ auth, apis, renderLink }: AdminFlagsContainerProps) {
  const { access, pending } = useAdminAccess(apis)
  const organizations = useOrganizationsQuery(auth)

  if (pending || organizations.isPending) {
    return <output className="block p-6 text-muted-foreground">Loading…</output>
  }
  if (organizations.isError) {
    return (
      <div role="alert" className="flex flex-col items-start gap-3 p-6">
        <p>Could not load your organizations.</p>
        <Button type="button" variant="outline" onClick={() => void organizations.refetch()}>
          Try again
        </Button>
      </div>
    )
  }
  const operator = organizations.data.find((org) => org.id === access.operatorOrganizationId)
  if (!operator) {
    return (
      <AdminNotAvailable forWhom="members of the operator organization" renderLink={renderLink} />
    )
  }
  return (
    <OrgGate auth={auth} organization={operator} signInHref="/sign-in?next=%2Fadmin%2Fflags">
      <FeatureFlagsContainer
        auth={auth}
        api={apis?.flags ?? getFeatureFlagsApi()}
        organization={operator}
        tabs={adminTabs(access)}
        renderLink={renderLink}
      />
    </OrgGate>
  )
}
