import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import type { RenderLink } from "@proof/ui/dplus/shell/link"

import { useReauthGuard } from "../components/reauth-dialog"
import { orgSecurityKeys } from "../lib/org-security-keys"
import { type SsoFormValues, domainVerificationRecord, newProviderId } from "../lib/org-security"
import type { OrgSecurityApi, ScimToken } from "../lib/org-security-api"
import type { OrgSettingsApi } from "../lib/org-settings-api"
import type { WebAuth, WebOrganization } from "../lib/web-auth"
import { OrgSecurityPage } from "../pages/org-security-page"
import { memberRoleQuery, orgRoleLabel } from "./shell-data"

/** Reading providers is the owner's (the catalog's sso:read). */
const READ = { sso: ["read"] }
/** Changing providers and minting a SCIM token are the owner's (sso:update, scim:create). */
const CHANGE = { sso: ["update"], scim: ["create"] }

export interface OrgSecurityContainerProps {
  auth: WebAuth
  /** The organization settings calls, for the role check (the plugin's own permission check). */
  api: OrgSettingsApi
  securityApi: OrgSecurityApi
  organization: WebOrganization
  /** The app's origin, for the SCIM base URL. */
  origin: string
  renderLink?: RenderLink
}

/**
 * Data and actions for the Security page. Every call names the organization. The SCIM token is kept in
 * this component's state only: it is shown once and never written to the query cache.
 */
export function OrgSecurityContainer({
  auth,
  api,
  securityApi,
  organization,
  origin,
  renderLink,
}: OrgSecurityContainerProps) {
  const queryClient = useQueryClient()
  // Adding, deleting and verifying a provider, and minting a SCIM token, need a recent sign-in.
  const guard = useReauthGuard()
  const organizationId = organization.id
  const role = useQuery(memberRoleQuery(auth, organizationId))
  const roleText = role.data ?? ""
  const canRead = role.isSuccess && api.roleAllows(roleText, READ)
  const canChange = role.isSuccess && api.roleAllows(roleText, CHANGE)
  const [scimToken, setScimToken] = useState<ScimToken | null>(null)

  const providers = useQuery({
    queryKey: orgSecurityKeys.providers(organizationId),
    queryFn: () => securityApi.listSsoProviders(organizationId),
    enabled: canRead,
  })

  const register = useMutation({
    mutationFn: (values: SsoFormValues) => {
      const providerId = newProviderId(values.domain, crypto.randomUUID().slice(0, 8))
      return guard(() => securityApi.registerSsoProvider(organizationId, providerId, values))
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: orgSecurityKeys.providers(organizationId) })
    },
  })

  const remove = useMutation({
    mutationFn: (providerId: string) =>
      guard(() => securityApi.deleteSsoProvider(organizationId, providerId)),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: orgSecurityKeys.providers(organizationId) })
    },
  })

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
    <OrgSecurityPage
      organization={{ name: organization.name, slug: organization.slug }}
      origin={origin}
      roleLabel={orgRoleLabel(roleText)}
      canRead={canRead}
      canChange={canChange}
      providers={canRead ? providers.data : undefined}
      providersError={canRead && providers.isError}
      scimToken={scimToken}
      onRegister={async (values) => {
        await register.mutateAsync(values)
      }}
      onDelete={async (providerId) => {
        await remove.mutateAsync(providerId)
      }}
      onRequestVerification={async (providerId) => {
        const provider = providers.data?.find((item) => item.providerId === providerId)
        if (!provider) throw new Error("That provider is no longer listed.")
        const token = await securityApi.requestDomainVerification(organizationId, providerId)
        return domainVerificationRecord(providerId, provider.domain, token)
      }}
      onCheckVerification={async (providerId) => {
        await guard(() => securityApi.verifyDomain(organizationId, providerId))
        await queryClient.invalidateQueries({ queryKey: orgSecurityKeys.providers(organizationId) })
      }}
      onGenerateScim={async () => {
        setScimToken(await guard(() => securityApi.generateScimToken(organizationId)))
      }}
      onDismissScim={() => setScimToken(null)}
      renderLink={renderLink}
    />
  )
}
