import { FieldIssues, FormError, invalidOf } from "../components/form"
import { useForm } from "@tanstack/react-form"
import { cn } from "cn"
import { useId, useRef, useState, type ReactNode } from "react"
import {} from "zod"

import { Button } from "@proof/ui/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@proof/ui/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@proof/ui/components/ui/field"
import { Input } from "@proof/ui/components/ui/input"
import { Textarea } from "@proof/ui/components/ui/textarea"
import {} from "@proof/ui/dplus/status"
import {
  type LinkProps,
  type RenderLink,
  anchorLink,
  useRenderLink,
} from "@proof/ui/dplus/shell/link"
import { PageBody } from "@proof/ui/dplus/shell/page-header"
import { SettingsHeader } from "@proof/ui/dplus/shell/settings-header"

import { ConfirmDialog } from "../components/confirm-dialog"
import { messageOf } from "../lib/messages"
import { BudgetSection } from "./workspace-agents-budget"
import { PermissionsView } from "./workspace-agents-permissions"
import { settingsTabs } from "../lib/org-settings"
import {
  type AgentView,
  agentFormSchema,
  deleteConsequence,
  type AgentFormValues,
} from "../lib/workspace-agents"
import type { AgentPatch, CreateAgentInput, WorkspaceAgent } from "../lib/workspace-agents-api"

const VIEW_PILLS: { id: AgentView; label: string }[] = [
  { id: "permissions", label: "Permissions" },
  { id: "guardrails", label: "Guardrails" },
  { id: "budgets", label: "Budgets & footprint" },
  { id: "connected", label: "Connected" },
]

export interface WorkspaceAgentsPageProps {
  organization: { id: string; name: string; slug: string }
  /** "Owner", "Admin", "Member" or "Viewer": the caller's role here. */
  roleLabel: string
  view: AgentView
  /**
   * The connected-agents view (API keys and OAuth clients), shown for the "Connected" pill. It gets
   * the level-2 pills to place beside its own section heading.
   */
  connected: (pills: ReactNode) => ReactNode
  /** agent:read: the list is shown. Every role has it; a missing role shows nothing. */
  canRead: boolean
  /** agent:create (owner, admin, member). */
  canCreate: boolean
  /** agent:update (owner, admin, member): settings, rename and pinning. Viewers get view-only. */
  canUpdate: boolean
  /** agent:delete (owner, admin). */
  canDelete: boolean
  agents: WorkspaceAgent[] | undefined
  agentsPending: boolean
  agentsError: string | null
  onRetry: () => void
  /** The agent the permissions board is about. */
  selected: WorkspaceAgent | undefined
  /** The number of runs the selected agent has, once counted (owner and admin only). */
  runCount: number | undefined
  /** The last change that the server refused. */
  actionError: string | null
  onSelect: (agentId: string | null) => void
  onCreate: (input: CreateAgentInput) => Promise<void>
  onUpdate: (id: string, patch: AgentPatch) => Promise<void>
  onRemove: (id: string) => Promise<void>
  renderLink?: RenderLink
}

/**
 * The organization's workspace agents (board DirLiftSettings): the list with status and pinning, and
 * the selected agent's permissions. Props in, callbacks out.
 */
export function WorkspaceAgentsPage({
  organization,
  roleLabel,
  view,
  connected,
  canRead,
  canCreate,
  canUpdate,
  canDelete,
  agents,
  agentsPending,
  agentsError,
  onRetry,
  selected,
  runCount,
  actionError,
  onSelect,
  onCreate,
  onUpdate,
  onRemove,
  renderLink = anchorLink,
}: WorkspaceAgentsPageProps) {
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState<string | null>(null)
  // A delete runs once: the ref catches a second click that lands before the button re-renders.
  const [removeBusy, setRemoveBusy] = useState(false)
  const removeBusyRef = useRef(false)

  // Level 2 sits in each view's section heading, not in the org header.
  const pills = <ViewPills slug={organization.slug} activeView={view} renderLink={renderLink} />
  const tabs = settingsTabs(organization.slug)

  async function confirmRemove() {
    if (!selected || removeBusyRef.current) return
    removeBusyRef.current = true
    setRemoveBusy(true)
    setRemoveError(null)
    try {
      await onRemove(selected.id)
      setRemoving(false)
      onSelect(null)
    } catch (caught) {
      setRemoveError(messageOf(caught))
    } finally {
      removeBusyRef.current = false
      setRemoveBusy(false)
    }
  }

  // The connected view renders its own sections, so it is not wrapped in the page's container.
  const body =
    view === "connected" ? (
      connected(pills)
    ) : (
      <PageBody className="gap-5">
        {view === "guardrails" ? (
          <PlaceholderSection
            heading="Guardrails"
            pills={pills}
            reason="[PLACEHOLDER] The API has no guardrail settings yet, so nothing on this tab can be changed."
          />
        ) : view === "budgets" ? (
          <BudgetSection
            key={selected?.id ?? "none"}
            pills={pills}
            agent={canRead ? selected : undefined}
            canUpdate={canUpdate}
            onSave={(id, energyBudgetWh) => onUpdate(id, { energyBudgetWh })}
          />
        ) : (
          <PermissionsView
            organization={organization}
            pills={pills}
            canRead={canRead}
            canCreate={canCreate}
            canUpdate={canUpdate}
            canDelete={canDelete}
            agents={agents}
            agentsPending={agentsPending}
            agentsError={agentsError}
            onRetry={onRetry}
            selected={selected}
            runCount={runCount}
            actionError={actionError}
            onSelect={onSelect}
            onCreateOpen={() => setCreating(true)}
            onRenameOpen={() => setRenaming(true)}
            onUpdate={onUpdate}
            onRemoveOpen={() => {
              setRemoveError(null)
              setRemoving(true)
            }}
            renderLink={renderLink}
          />
        )}
      </PageBody>
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SettingsHeader
        title="Organization settings"
        context={`${organization.name} · you are ${roleLabel}`}
        tabs={tabs}
        activeTab="agents"
        viewOnly={canRead && !canUpdate ? organization.name : undefined}
        renderLink={renderLink}
      />

      {body}

      <AgentFormDialog
        open={creating}
        onOpenChange={setCreating}
        title="Create agent"
        description={`The agent works for ${organization.name}. It starts with Ask first, and its three always-ask actions on.`}
        submitLabel="Create agent"
        initial={{ name: "", description: "" }}
        onSubmit={async (values) => {
          await onCreate({ name: values.name, description: values.description || null })
          setCreating(false)
        }}
      />

      {selected && canUpdate ? (
        <AgentFormDialog
          key={`${selected.id}:${selected.name}:${selected.description ?? ""}`}
          open={renaming}
          onOpenChange={setRenaming}
          title="Edit agent details"
          description="The name is shown in the sidebar and the run list."
          submitLabel="Save details"
          initial={{ name: selected.name, description: selected.description ?? "" }}
          onSubmit={async (values) => {
            await onUpdate(selected.id, {
              name: values.name,
              description: values.description || null,
            })
            setRenaming(false)
          }}
        />
      ) : null}

      {selected && canDelete ? (
        <ConfirmDialog
          open={removing}
          onOpenChange={(open) => {
            if (!open) setRemoving(false)
          }}
          title={`Delete ${selected.name}?`}
          description={deleteConsequence(selected.name, runCount)}
          confirmLabel="Delete agent"
          destructive
          pending={removeBusy}
          error={removeError}
          onConfirm={() => void confirmRemove()}
        />
      ) : null}
    </div>
  )
}

/** The level-2 pills (Permissions, Guardrails, Budgets & footprint, Connected), as links. */
function ViewPills({
  slug,
  activeView,
  renderLink: renderLinkProp,
}: {
  slug: string
  activeView: AgentView
  renderLink?: RenderLink
}) {
  const renderLink = useRenderLink(renderLinkProp)
  return (
    <nav aria-label="Organization settings sub-sections" className="flex flex-wrap gap-1.5">
      {VIEW_PILLS.map((pill) => {
        const current = pill.id === activeView
        const href =
          pill.id === "permissions"
            ? `/${slug}/settings/agents`
            : `/${slug}/settings/agents?view=${pill.id}`
        return (
          <span key={pill.id}>
            {renderLink({
              href,
              "aria-current": current ? "page" : undefined,
              className: cn(
                "inline-flex h-9 items-center rounded-full border-[1.5px] px-3.5 text-sm font-semibold",
                current
                  ? "border-foreground bg-foreground text-background"
                  : "border-border text-foreground hover:bg-accent",
              ),
              children: pill.label,
            } as LinkProps)}
          </span>
        )
      })}
    </nav>
  )
}

/** A section heading row: the heading on the left, the level-2 pills on the right (wrapping on phones). */
function SectionTitle({
  id,
  children,
  pills,
}: {
  id: string
  children: ReactNode
  pills?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-5">
      <h2 id={id} className="text-[18px] font-bold">
        {children}
      </h2>
      {pills}
    </div>
  )
}

function PlaceholderSection({
  heading,
  reason,
  pills,
}: {
  heading: string
  reason: string
  pills?: ReactNode
}) {
  return (
    <section
      aria-labelledby="placeholder-heading"
      className="flex max-w-[640px] flex-col gap-2 rounded-lg border-2 border-dashed border-muted-foreground p-5"
    >
      <SectionTitle id="placeholder-heading" pills={pills}>
        {heading}
      </SectionTitle>
      <p className="text-sm text-muted-foreground">{reason}</p>
    </section>
  )
}

/** The first validation message for a field (a Zod issue, or a plain string). */

function AgentFormDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  initial,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  submitLabel: string
  initial: AgentFormValues
  onSubmit: (values: AgentFormValues) => Promise<void>
}) {
  const nameId = useId()
  const descriptionId = useId()
  const [serverError, setServerError] = useState<string | null>(null)

  const form = useForm({
    defaultValues: initial,
    validators: { onChange: agentFormSchema },
    onSubmit: async ({ value }) => {
      setServerError(null)
      try {
        await onSubmit(agentFormSchema.parse(value))
        form.reset()
      } catch (caught) {
        setServerError(messageOf(caught))
      }
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            event.stopPropagation()
            void form.handleSubmit()
          }}
        >
          <form.Field name="name">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={nameId}>Name</FieldLabel>
                <Input
                  id={nameId}
                  name="name"
                  value={field.state.value}
                  placeholder="Release triage"
                  aria-invalid={invalidOf(field)}
                  onChange={(event) => field.handleChange(event.currentTarget.value)}
                  onBlur={field.handleBlur}
                />
                <FieldIssues field={field} />
              </Field>
            )}
          </form.Field>

          <form.Field name="description">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={descriptionId}>Description</FieldLabel>
                <Textarea
                  id={descriptionId}
                  name="description"
                  value={field.state.value}
                  placeholder="What it does"
                  aria-invalid={invalidOf(field)}
                  onChange={(event) => field.handleChange(event.currentTarget.value)}
                  onBlur={field.handleBlur}
                />
                <FieldDescription>Optional.</FieldDescription>
                <FieldIssues field={field} />
              </Field>
            )}
          </form.Field>

          <FormError message={serverError} />

          <DialogFooter>
            <form.Subscribe selector={(state) => state.isSubmitting}>
              {(isSubmitting) => (
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? "Saving…" : submitLabel}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
