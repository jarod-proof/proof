import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useState } from "react"

import type { RenderLink } from "@proof/ui/dplus/shell/link"

import { useReauthGuard } from "../components/reauth-dialog"
import { permissionOptions } from "../lib/api-keys"
import type { ApiKeysApi, CreateApiKeyInput } from "../lib/api-keys-api"
import type { OrgSettingsApi } from "../lib/org-settings-api"
import { messageOf } from "../lib/messages"
import { qk } from "../lib/query-keys"
import type { WebAuth, WebOrganization } from "../lib/web-auth"
import { ApiKeysPage } from "../pages/api-keys-page"
import { memberRoleQuery, orgRoleLabel } from "./shell-data"

// The permissions the server checks: apiKey:read lists keys (list_api_keys), apiKey:delete revokes
// one (revoke_agent_access), apiKey:create makes a new key. The page derives its controls from the
// same catalog, so they agree with the server.
const LIST = { apiKey: ["read"] }
const REVOKE = { apiKey: ["delete"] }
const CREATE = { apiKey: ["create"] }

export interface ApiKeysContainerProps {
  auth: WebAuth
  api: ApiKeysApi
  settings: Pick<OrgSettingsApi, "roleAllows">
  organization: WebOrganization
  renderLink?: RenderLink
}

/**
 * Data and mutations for the organization's API keys page. The list is only requested for a role
 * that may read keys, so a viewer gets the view-only state and no error. Members see the list
 * read-only; revoking needs apiKey:delete.
 */
export function ApiKeysContainer({
  auth,
  api,
  settings,
  organization,
  renderLink,
}: ApiKeysContainerProps) {
  const queryClient = useQueryClient()
  const organizationId = organization.id
  // Creating and revoking keys need a recent sign-in (SESSION_NOT_FRESH otherwise).
  const guard = useReauthGuard()
  const role = useQuery(memberRoleQuery(auth, organizationId))
  const roleText = role.data ?? ""
  const canList = role.isSuccess && settings.roleAllows(roleText, LIST)
  const canCreate = role.isSuccess && settings.roleAllows(roleText, CREATE)
  const canRevoke = role.isSuccess && settings.roleAllows(roleText, REVOKE)

  const keys = useQuery({
    queryKey: qk.org(organizationId).apiKeys(),
    queryFn: () => api.listKeys(organizationId),
    enabled: canList,
  })

  // The secret lives only in this component's state: not in a query or mutation cache, and gone
  // when the page unmounts.
  const [secret, setSecret] = useState<{ name: string; key: string } | null>(null)

  const refreshKeys = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: qk.org(organizationId).apiKeys() })
    void queryClient.invalidateQueries({ queryKey: qk.org(organizationId).agents() })
    void queryClient.invalidateQueries({ queryKey: qk.org(organizationId).counts() })
  }, [organizationId, queryClient])

  const onCreate = useCallback(
    async (input: CreateApiKeyInput) => {
      const created = await guard(() => api.createKey(organizationId, input))
      setSecret({ name: input.name, key: created.key })
      refreshKeys()
    },
    [api, guard, organizationId, refreshKeys],
  )

  const onRevoke = useCallback(
    async (key: { id: string }) => {
      await guard(() => api.revokeKey(organizationId, key.id))
      refreshKeys()
    },
    [api, guard, organizationId, refreshKeys],
  )

  if (role.isError) {
    return (
      <p role="alert" className="p-6 text-destructive">
        Could not load your role in this organization.
      </p>
    )
  }
  if (!role.isSuccess) {
    return <output className="block p-6 text-muted-foreground">Loading…</output>
  }

  return (
    <ApiKeysPage
      organization={organization}
      roleLabel={orgRoleLabel(roleText)}
      canList={canList}
      canCreate={canCreate}
      canRevoke={canRevoke}
      keys={canList ? keys.data : undefined}
      keysPending={canList && keys.isPending}
      keysError={canList && keys.isError ? messageOf(keys.error) : null}
      onRetry={() => void keys.refetch()}
      permissionOptions={permissionOptions((permission) =>
        settings.roleAllows(roleText, permission),
      )}
      secret={secret}
      onDismissSecret={() => setSecret(null)}
      onCreate={onCreate}
      onRevoke={onRevoke}
      renderLink={renderLink}
    />
  )
}
