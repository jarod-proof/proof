import { FieldIssues, FormError, invalidOf, type FieldLike } from "../components/form"
import { useForm } from "@tanstack/react-form"
import { useDebouncedValue } from "@tanstack/react-pacer"
import { useEffect, useId, useState } from "react"
import { z } from "zod"

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
import { NativeSelect, NativeSelectOption } from "@proof/ui/components/ui/native-select"
import { CopyField } from "@proof/ui/dplus/shell/copy-field"
import { DangerAction, DangerZone } from "@proof/ui/dplus/shell/danger-zone"
import { type RenderLink, anchorLink } from "@proof/ui/dplus/shell/link"
import { PageBody } from "@proof/ui/dplus/shell/page-header"
import { SettingsHeader } from "@proof/ui/dplus/shell/settings-header"
import { type SlugStatus, SlugField } from "@proof/ui/dplus/shell/slug-field"
import { ViewOnlyNotice } from "@proof/ui/dplus/shell/view-only-notice"
import { OrgMark } from "@proof/ui/dplus/org-mark"

import { ASSIGNABLE_ROLES, type AssignableRole } from "../lib/members"
import { ROLE_LABEL } from "../lib/roles"
import { settingsTabs, slugChangeWarning } from "../lib/org-settings"
import { ConfirmDialog } from "../components/confirm-dialog"
import { ImageUpload, type ImageUploadLimits } from "../components/image-upload"
import { type SlugProblem, slugProblem } from "../lib/org-slug"

export type GeneralValues = { name: string; slug: string; defaultInviteRole: AssignableRole }

/** The logo's upload: what the server accepts (null while uploads are off) and the two actions. */
export interface LogoUpload {
  limits: ImageUploadLimits | null
  onUpload: (file: File) => Promise<void>
  onRemove: () => Promise<void>
}

export interface OrgGeneralPageProps {
  organization: { id: string; name: string; slug: string; logo?: string | null }
  /** Omitted, uploads are shown as off. Only used when `canEdit`. */
  logoUpload?: LogoUpload
  /** The app's host, shown before the URL slug (e.g. "app.example.com"). */
  host: string
  /** The caller's role name here, as shown ("Owner", "Approver", ...). */
  roleLabel: string
  /** owner/admin: may change the name, URL and default invite role. */
  canEdit: boolean
  /** owner: the danger zone (transfer, delete). */
  isOwner: boolean
  /** The owner is the only owner, so they cannot leave yet. */
  soleOwner: boolean
  defaultInviteRole: AssignableRole
  /** Live counts where known; `undefined` shows [PLACEHOLDER]. */
  counts: { members?: number; apiKeys?: number; agents?: number }
  /** Admins who can be made owner. */
  admins: { memberId: string; label: string }[]
  checkSlug: (slug: string) => Promise<boolean>
  onSave: (values: GeneralValues) => Promise<void>
  onTransfer: (memberId: string) => Promise<void>
  onLeave: () => Promise<void>
  onDelete: () => Promise<void>
  renderLink?: RenderLink
}

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter a name for the organization.")
    .max(80, "Use 80 characters or fewer."),
  slug: z.string().refine((value) => slugProblem(value) === null, {
    message: "Choose a valid URL.",
  }),
  defaultInviteRole: z.enum(ASSIGNABLE_ROLES),
})

// A reserved address has no hint: the field's status line already says it.
const PROBLEM_TEXT: Record<Exclude<SlugProblem, null | "reserved">, string> = {
  empty: "Enter a URL for the organization.",
  shape: "Use lowercase letters, numbers and hyphens, up to 48 characters.",
}

/** "1 member", "12 members", or the placeholder for a count that is not known yet. */
function countNoun(count: number | undefined, one: string, many: string): string {
  if (count === undefined) return `[PLACEHOLDER] ${many}`
  return `${count} ${count === 1 ? one : many}`
}

/** The organization settings "General" page (board OrgGeneral). Props in, callbacks out. */
export function OrgGeneralPage({
  organization,
  logoUpload,
  host,
  roleLabel,
  canEdit,
  isOwner,
  soleOwner,
  defaultInviteRole,
  counts,
  admins,
  checkSlug,
  onSave,
  onTransfer,
  onLeave,
  onDelete,
  renderLink = anchorLink,
}: OrgGeneralPageProps) {
  const defaults: GeneralValues = {
    name: organization.name,
    slug: organization.slug,
    defaultInviteRole,
  }
  const [saveError, setSaveError] = useState<string | null>(null)
  const nameId = useId()
  const inviteId = useId()

  const form = useForm({
    defaultValues: defaults,
    validators: { onChange: schema },
    onSubmit: async ({ value }) => {
      setSaveError(null)
      try {
        await onSave({ ...value, name: value.name.trim() })
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : "Could not save the changes.")
      }
    },
  })

  const tabs = settingsTabs(organization.slug)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SettingsHeader
        title="Organization settings"
        context={`${organization.name} · you are ${roleLabel}`}
        tabs={tabs}
        activeTab="general"
        renderLink={renderLink}
      />

      <PageBody className="gap-5">
        {!canEdit ? (
          <ViewOnlyNotice subject={organization.name}>
            Ask an owner or admin to change these settings.
          </ViewOnlyNotice>
        ) : null}

        <form
          noValidate
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault()
            event.stopPropagation()
            void form.handleSubmit()
          }}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <form.Field name="name">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={nameId}>Organization name</FieldLabel>
                  <Input
                    id={nameId}
                    name="name"
                    value={field.state.value}
                    disabled={!canEdit}
                    aria-invalid={invalidOf(field)}
                    onChange={(event) => field.handleChange(event.currentTarget.value)}
                    onBlur={field.handleBlur}
                    autoComplete="organization"
                  />
                  <FieldIssues field={field} />
                </Field>
              )}
            </form.Field>

            <form.Field name="slug">
              {(field) => (
                <SlugEditor
                  host={host}
                  currentSlug={organization.slug}
                  value={field.state.value}
                  disabled={!canEdit}
                  checkSlug={checkSlug}
                  onChange={(slug) => field.handleChange(slug)}
                  field={field}
                />
              )}
            </form.Field>
          </div>

          <div className="flex items-center gap-3.5">
            <OrgMark name={organization.name} logo={organization.logo} size="lg" />
            {canEdit ? (
              <ImageUpload
                label="Logo"
                uploadLabel="Upload"
                removeLabel="Remove"
                hasImage={Boolean(organization.logo)}
                limits={logoUpload?.limits ?? null}
                offReason="Logo upload is off on this server, so the first letter is shown."
                guidance="Square, at least 128px."
                onUpload={(file) => logoUpload?.onUpload(file) ?? Promise.resolve()}
                onRemove={() => logoUpload?.onRemove() ?? Promise.resolve()}
              />
            ) : (
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-semibold">Logo</span>
                <span className="text-[13.5px] text-muted-foreground">
                  {organization.logo
                    ? "Owners and admins can change it."
                    : "None yet, so the first letter is shown. Owners and admins can upload one."}
                </span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <form.Field name="defaultInviteRole">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={inviteId}>Default role for new invites</FieldLabel>
                  <NativeSelect
                    id={inviteId}
                    name="defaultInviteRole"
                    value={field.state.value}
                    disabled={!canEdit}
                    onChange={(event) =>
                      field.handleChange(event.currentTarget.value as AssignableRole)
                    }
                    onBlur={field.handleBlur}
                  >
                    {ASSIGNABLE_ROLES.map((role) => (
                      <NativeSelectOption key={role} value={role}>
                        {ROLE_LABEL[role]}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <FieldDescription>
                    Used when you invite someone without choosing a role.
                  </FieldDescription>
                </Field>
              )}
            </form.Field>

            <CopyField label="Organization ID" value={organization.id} />
          </div>

          {canEdit ? (
            <form.Subscribe
              selector={(state) => ({
                values: state.values,
                canSubmit: state.canSubmit,
                isSubmitting: state.isSubmitting,
              })}
            >
              {({ values, canSubmit, isSubmitting }) => {
                const dirty =
                  values.name.trim() !== defaults.name ||
                  values.slug !== defaults.slug ||
                  values.defaultInviteRole !== defaults.defaultInviteRole
                return (
                  <div className="flex flex-col gap-2">
                    <FormError message={saveError} />
                    <div className="flex justify-end gap-2.5 border-b border-border pb-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!dirty || isSubmitting}
                        onClick={() => {
                          setSaveError(null)
                          form.reset()
                        }}
                      >
                        Discard
                      </Button>
                      <Button type="submit" disabled={!dirty || !canSubmit || isSubmitting}>
                        {isSubmitting ? "Saving…" : "Save changes"}
                      </Button>
                    </div>
                  </div>
                )
              }}
            </form.Subscribe>
          ) : null}
        </form>

        {isOwner ? (
          <OwnerDangerZone
            organizationName={organization.name}
            counts={counts}
            admins={admins}
            soleOwner={soleOwner}
            onTransfer={onTransfer}
            onLeave={onLeave}
            onDelete={onDelete}
          />
        ) : (
          <div className="border-t border-border pt-4">
            <LeaveRow organizationName={organization.name} onLeave={onLeave} />
          </div>
        )}
      </PageBody>
    </div>
  )
}

/** The URL field: availability is checked after a pause, and not for the address already in use. */
function SlugEditor({
  host,
  currentSlug,
  value,
  disabled,
  checkSlug,
  onChange,
  field,
}: {
  host: string
  currentSlug: string
  value: string
  disabled: boolean
  checkSlug: (slug: string) => Promise<boolean>
  onChange: (slug: string) => void
  field: FieldLike
}) {
  const status = useSlugAvailability(value, currentSlug, checkSlug)
  const problem = slugProblem(value)
  const changed = value !== currentSlug
  return (
    <div className="flex flex-col gap-1.5">
      <SlugField
        label="URL"
        prefix={`${host}/`}
        value={value}
        name="slug"
        status={disabled ? "idle" : status}
        disabled={disabled}
        onChange={onChange}
      />
      {!disabled && problem && problem !== "reserved" ? (
        <FieldDescription>{PROBLEM_TEXT[problem]}</FieldDescription>
      ) : null}
      <FieldIssues field={field} hidden={disabled || problem !== null} />
      {!disabled && changed && problem === null ? (
        <FieldDescription>{slugChangeWarning(host, currentSlug)}</FieldDescription>
      ) : null}
    </div>
  )
}

/**
 * The availability of a slug as the field shows it. The current address is never checked (the server
 * reports it as taken), and a check that fails shows nothing rather than a wrong answer.
 */
function useSlugAvailability(
  value: string,
  currentSlug: string,
  checkSlug: (slug: string) => Promise<boolean>,
): SlugStatus {
  const [settled] = useDebouncedValue(value, { wait: 300 })
  const [result, setResult] = useState<{ slug: string; available: boolean | null } | null>(null)

  const checkable = settled !== currentSlug && settled.length > 0 && slugProblem(settled) === null

  useEffect(() => {
    if (!checkable) return
    let live = true
    checkSlug(settled)
      .then((available) => {
        if (live) setResult({ slug: settled, available })
      })
      .catch(() => {
        if (live) setResult({ slug: settled, available: null })
      })
    return () => {
      live = false
    }
  }, [checkable, settled, checkSlug])

  if (value.length === 0 || value === currentSlug) return "idle"
  if (slugProblem(value) === "reserved") return "reserved"
  if (slugProblem(value) !== null) return "invalid"
  if (value !== settled) return "checking"
  if (!checkable || result === null || result.slug !== settled) return "checking"
  if (result.available === null) return "idle"
  return result.available ? "available" : "taken"
}

function OwnerDangerZone({
  organizationName,
  counts,
  admins,
  soleOwner,
  onTransfer,
  onLeave,
  onDelete,
}: {
  organizationName: string
  counts: { members?: number; apiKeys?: number; agents?: number }
  admins: { memberId: string; label: string }[]
  soleOwner: boolean
  onTransfer: (memberId: string) => Promise<void>
  onLeave: () => Promise<void>
  onDelete: () => Promise<void>
}) {
  return (
    <DangerZone>
      <TransferRow admins={admins} onTransfer={onTransfer} />
      <DeleteRow organizationName={organizationName} counts={counts} onDelete={onDelete} />
      <LeaveRow
        organizationName={organizationName}
        onLeave={onLeave}
        disabled={soleOwner}
        disabledReason="You are the only owner, so you can't leave yet. Transfer ownership to an admin first."
      />
    </DangerZone>
  )
}

function TransferRow({
  admins,
  onTransfer,
}: {
  admins: { memberId: string; label: string }[]
  onTransfer: (memberId: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [memberId, setMemberId] = useState(admins[0]?.memberId ?? "")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const selectId = useId()
  const chosen = admins.some((admin) => admin.memberId === memberId)
    ? memberId
    : (admins[0]?.memberId ?? "")

  return (
    <>
      <DangerAction
        label="Transfer…"
        title="Transfer ownership"
        consequence="Make another admin the owner. You become an admin."
        disabled={admins.length === 0}
        disabledReason="Make another member an admin first, then transfer ownership to them."
        onAction={() => {
          setError(null)
          setOpen(true)
        }}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transfer ownership</DialogTitle>
            <DialogDescription>
              The new owner gets every owner permission, including deleting the organization. You
              become an admin straight away.
            </DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor={selectId}>New owner</FieldLabel>
            <NativeSelect
              id={selectId}
              value={chosen}
              onChange={(event) => setMemberId(event.currentTarget.value)}
            >
              {admins.map((admin) => (
                <NativeSelectOption key={admin.memberId} value={admin.memberId}>
                  {admin.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <FormError message={error} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy || chosen === ""}
              onClick={async () => {
                setBusy(true)
                setError(null)
                try {
                  await onTransfer(chosen)
                  setOpen(false)
                } catch (caught) {
                  setError(
                    caught instanceof Error
                      ? `${caught.message} Try again to finish the transfer.`
                      : "Could not transfer ownership. Try again.",
                  )
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? "Transferring…" : "Transfer ownership"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function DeleteRow({
  organizationName,
  counts,
  onDelete,
}: {
  organizationName: string
  counts: { members?: number; apiKeys?: number; agents?: number }
  onDelete: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputId = useId()
  const consequence = `Permanently deletes ${countNoun(counts.agents, "agent", "agents")}, ${countNoun(counts.apiKeys, "API key", "API keys")} (they stop working) and all run history, removes ${countNoun(counts.members, "member", "members")}. Cancel any subscription in Billing first. You'll type the organization name to confirm.`

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await onDelete()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the organization.")
      setBusy(false)
    }
  }
  return (
    <>
      <DangerAction
        label="Delete organization"
        title={`Delete ${organizationName}`}
        consequence={consequence}
        onAction={() => {
          setTyped("")
          setError(null)
          setOpen(true)
        }}
      />
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete ${organizationName}?`}
        description={consequence}
        confirmLabel="Delete organization"
        pendingLabel="Deleting…"
        destructive
        pending={busy}
        confirmDisabled={typed !== organizationName}
        error={error}
        onConfirm={() => void remove()}
      >
        <Field>
          <FieldLabel htmlFor={inputId}>Type {organizationName} to confirm</FieldLabel>
          <Input
            id={inputId}
            value={typed}
            autoComplete="off"
            onChange={(event) => setTyped(event.currentTarget.value)}
          />
        </Field>
      </ConfirmDialog>
    </>
  )
}

/** Leave the organization: the consequence, then a confirmation. Red outline, not the page's primary action. */
function LeaveRow({
  organizationName,
  onLeave,
  disabled = false,
  disabledReason,
}: {
  organizationName: string
  onLeave: () => Promise<void>
  disabled?: boolean
  disabledReason?: string
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const consequence = `You'll lose access to ${organizationName} right away. An admin can invite you again.`
  const leave = async () => {
    setBusy(true)
    setError(null)
    try {
      await onLeave()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not leave the organization.")
      setBusy(false)
    }
  }
  return (
    <>
      <DangerAction
        label="Leave organization"
        title={`Leave ${organizationName}`}
        consequence={consequence}
        disabled={disabled}
        disabledReason={disabledReason}
        onAction={() => {
          setError(null)
          setOpen(true)
        }}
      />
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Leave ${organizationName}?`}
        description={consequence}
        confirmLabel="Leave organization"
        pendingLabel="Leaving…"
        destructive
        pending={busy}
        error={error}
        onConfirm={() => void leave()}
      />
    </>
  )
}
