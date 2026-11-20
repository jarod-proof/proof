import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"

import type { RenderLink } from "@proof/ui/dplus/shell/link"
import type { SettingsTab } from "@proof/ui/dplus/shell/settings-header"

import type { FeatureFlagsApi } from "../lib/feature-flags-api"
import { messageOf } from "../lib/messages"
import { qk } from "../lib/query-keys"
import type { WebAuth, WebOrganization } from "../lib/web-auth"
import { FeatureFlagsPage } from "../pages/feature-flags-page"
import { memberRoleQuery, orgRoleLabel } from "./shell-data"

export interface FeatureFlagsContainerProps {
  auth: WebAuth
  api: FeatureFlagsApi
  /** The operator organization: the session acts in it (OrgGate) before this mounts. */
  organization: WebOrganization
  /** The admin console's tabs this person may open. */
  tabs: SettingsTab[]
  renderLink?: RenderLink
}

/**
 * Data and actions for the admin console's Feature flags tab, as the operator organization. Every
 * write refreshes the list and the open flag. The server decides who may: the role needs
 * featureFlag:update, and only the operator organization is let in.
 */
export function FeatureFlagsContainer({
  auth,
  api,
  organization,
  tabs,
  renderLink,
}: FeatureFlagsContainerProps) {
  const queryClient = useQueryClient()
  const organizationId = organization.id
  const role = useQuery(memberRoleQuery(auth, organizationId))
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const flags = useQuery({
    queryKey: qk.org(organizationId).featureFlags(),
    queryFn: () => api.list(organizationId),
  })
  const detail = useQuery({
    queryKey: qk.org(organizationId).featureFlag(selectedKey ?? "none"),
    queryFn: () => api.get(organizationId, selectedKey ?? ""),
    enabled: selectedKey !== null,
  })

  /** Runs a write, then refreshes every flag query (the list and the open flag share a prefix). */
  const write = useCallback(
    async (call: () => Promise<unknown>) => {
      try {
        await call()
      } finally {
        await queryClient.invalidateQueries({ queryKey: qk.org(organizationId).featureFlags() })
      }
    },
    [queryClient, organizationId],
  )

  return (
    <FeatureFlagsPage
      organization={organization}
      roleLabel={orgRoleLabel(role.data ?? undefined)}
      tabs={tabs}
      flags={flags.data}
      flagsError={flags.isError ? messageOf(flags.error) : null}
      onRetry={() => void flags.refetch()}
      selectedKey={selectedKey}
      onSelect={setSelectedKey}
      detail={detail.data}
      detailError={detail.isError ? messageOf(detail.error) : null}
      onUpdate={(key, patch) => write(() => api.update(organizationId, key, patch))}
      onTarget={(key, organizations, value) =>
        write(() => api.target(organizationId, key, organizations, value))
      }
      onUntarget={(key, target) => write(() => api.untarget(organizationId, key, target))}
      onReclaim={(key, value) => write(() => api.reclaim(organizationId, key, value))}
      onDelete={async (key) => {
        await write(() => api.remove(organizationId, key))
        setSelectedKey(null)
      }}
      renderLink={renderLink}
    />
  )
}
