import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"

import { takesSeat } from "@proof/plans"

import type { RenderLink } from "@proof/ui/dplus/shell/link"

import {
  type BillingAdapter,
  type BillingRedirect,
  CHECKOUT_RETURN_PARAM,
} from "../lib/billing/adapter"
import { getBillingAdapter } from "../lib/billing/select"
import { billingKeys } from "../lib/billing-keys"
import { type OrgSettingsApi } from "../lib/org-settings-api"
import { qk } from "../lib/query-keys"
import type { WebAuth, WebOrganization } from "../lib/web-auth"
import { memberRoleQuery, orgRoleLabel } from "./shell-data"
import { OrgBillingPage } from "../pages/org-billing-page"

/** Seeing the Billing page: owners and admins (members and viewers have no subscription grant). */
const VIEW_BILLING = { subscription: ["read"] }
/** Changing the subscription (plan, seats, payment, invoices, cancellation): owners and admins. */
const CHANGE_BILLING = { subscription: ["update"] }

export interface OrgBillingContainerProps {
  auth: WebAuth
  api: OrgSettingsApi
  organization: WebOrganization
  /** Given by tests. The route leaves it out, and the server's `stripe` flag chooses the adapter. */
  adapter?: BillingAdapter
  /** How the adapter is chosen when none is given: the page's own (`getBillingAdapter`) by default. */
  chooseAdapter?: () => Promise<BillingAdapter>
  renderLink?: RenderLink
}

/**
 * Data and actions for the Billing page. The adapter supplies the plan, the invoices and the
 * provider's pages; the caller's role decides which controls work. Every call names the
 * organization.
 */
export function OrgBillingContainer({
  auth,
  api,
  organization,
  adapter: adapterProp,
  chooseAdapter = getBillingAdapter,
  renderLink,
}: OrgBillingContainerProps) {
  const queryClient = useQueryClient()
  const organizationId = organization.id
  const role = useQuery(memberRoleQuery(auth, organizationId))
  const roleText = role.data ?? ""
  const canView = role.isSuccess && api.roleAllows(roleText, VIEW_BILLING)
  const canChange = role.isSuccess && api.roleAllows(roleText, CHANGE_BILLING)

  const modeQuery = useQuery({
    queryKey: billingKeys.mode(),
    queryFn: chooseAdapter,
    staleTime: Number.POSITIVE_INFINITY,
    enabled: adapterProp === undefined,
  })
  // A service, not data: the lint allowlists the type, and its `mode` stands for it in query keys.
  const adapter: BillingAdapter | undefined = adapterProp ?? modeQuery.data

  // The mode in the key keeps the fixture's data apart from Stripe's; invalidating the snapshot
  // prefix still reaches both queries.
  const snapshot = useQuery({
    queryKey: [...billingKeys.snapshot(organizationId), adapter?.mode],
    queryFn: () => {
      if (!adapter) throw new Error("Billing is not ready.")
      return adapter.load(organizationId)
    },
    enabled: canView && adapter !== undefined,
  })

  const usage = useQuery({
    queryKey: [...billingKeys.usage(organizationId), adapter?.mode],
    queryFn: () => {
      if (!adapter) throw new Error("Billing is not ready.")
      return adapter.usage(organizationId)
    },
    enabled: canView && adapter !== undefined,
  })

  // Back from checkout (?checkout=success): the webhook may still be on its way, so the plan is
  // re-read from the provider now, then the page's billing data is loaded again.
  const refreshAdapter = canChange ? adapter : undefined
  useEffect(() => {
    if (!refreshAdapter?.refresh || typeof window === "undefined") return
    const url = new URL(window.location.href)
    if (url.searchParams.get(CHECKOUT_RETURN_PARAM) !== "success") return
    url.searchParams.delete(CHECKOUT_RETURN_PARAM)
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`)
    void refreshAdapter
      .refresh(organizationId)
      .catch(() => {})
      .finally(() => {
        void queryClient.invalidateQueries({ queryKey: billingKeys.snapshot(organizationId) })
      })
  }, [refreshAdapter, organizationId, queryClient])

  const members = useQuery({
    queryKey: qk.org(organizationId).members(),
    queryFn: () => api.listMembers(organizationId),
    enabled: canView,
  })

  // Every provider action returns a page to open. The window is opened only after the server has
  // answered, so the browser may block it; `noopener` means the page can't tell us it was blocked.
  const open = useMutation({
    mutationFn: (action: () => Promise<BillingRedirect>) => action(),
    onSuccess: (result) => {
      if (result.url) window.open(result.url, "_blank", "noopener")
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: billingKeys.snapshot(organizationId) })
    },
  })

  if (role.isError) {
    return (
      <p role="alert" className="p-6 text-destructive">
        Could not load your role in this organization.
      </p>
    )
  }
  if (role.isSuccess && !canView) {
    return (
      <p className="p-6 text-muted-foreground">
        Billing isn&apos;t available for your role. Ask an owner or admin.
      </p>
    )
  }
  if (modeQuery.isError || snapshot.isError || usage.isError) {
    return (
      <p role="alert" className="p-6 text-destructive">
        Could not load billing for this organization.
      </p>
    )
  }
  if (!role.isSuccess || !adapter || !snapshot.isSuccess || !members.isSuccess) {
    return <output className="block p-6 text-muted-foreground">Loading…</output>
  }

  const actionError = open.error instanceof Error ? open.error.message : null

  return (
    <OrgBillingPage
      organization={{ name: organization.name, slug: organization.slug }}
      roleLabel={orgRoleLabel(roleText)}
      canChange={canChange}
      mode={adapter.mode}
      snapshot={snapshot.data}
      usage={usage.data ?? null}
      seatsUsed={members.data.members.filter((member) => takesSeat(member.role)).length}
      pending={open.isPending}
      actionError={actionError}
      onOpenPortal={() => open.mutate(() => adapter.openPortal(organizationId))}
      onChangePlan={(planId) => open.mutate(() => adapter.changePlan(organizationId, planId))}
      onCancel={() => open.mutate(() => adapter.cancel(organizationId))}
      renderLink={renderLink}
    />
  )
}
