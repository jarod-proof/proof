import { FieldIssues, FormError, invalidOf } from "../components/form"
import { useForm } from "@tanstack/react-form"
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table"
import { useId, useMemo, useRef, useState } from "react"
import { z } from "zod"

import { Badge } from "@proof/ui/components/ui/badge"
import { Button } from "@proof/ui/components/ui/button"
import { Checkbox } from "@proof/ui/components/ui/checkbox"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@proof/ui/components/ui/table"
import { CopyField } from "@proof/ui/dplus/shell/copy-field"
import { type RenderLink, anchorLink } from "@proof/ui/dplus/shell/link"
import { PageBody } from "@proof/ui/dplus/shell/page-header"
import { SettingsHeader } from "@proof/ui/dplus/shell/settings-header"
import { ViewOnlyNotice } from "@proof/ui/dplus/shell/view-only-notice"

import {
  EXPIRY_OPTIONS,
  type PermissionOption,
  accessSummary,
  createdByLabel,
  expiryLabel,
  isUnused,
  maskedKey,
  permissionList,
  secretNotice,
  toPermissionsRecord,
} from "../lib/api-keys"
import { ConfirmDialog } from "../components/confirm-dialog"
import type { ApiKey, CreateApiKeyInput } from "../lib/api-keys-api"
import { settingsTabs } from "../lib/org-settings"
import { messageOf } from "../lib/messages"

export interface ApiKeysPageProps {
  organization: { id: string; name: string; slug: string }
  /** "Owner", "Admin", "Member" or "Viewer": the caller's role here. */
  roleLabel: string
  /** apiKey:read (owner, admin, member): the list is shown. Viewers get the view-only notice. */
  canList: boolean
  /** apiKey:delete (owner, admin): the Revoke action is shown. */
  canRevoke: boolean
  /** apiKey:create (owner, admin): the Create button is enabled. */
  canCreate: boolean
  /** The organization's keys, once loaded. */
  keys: ApiKey[] | undefined
  keysPending: boolean
  keysError: string | null
  onRetry: () => void
  /** The permissions the caller may grant, for the picker. */
  permissionOptions: PermissionOption[]
  /** The secret of the key just created. Shown once; cleared by the page's dismiss button. */
  secret: { name: string; key: string } | null
  onDismissSecret: () => void
  /** Rejects with the server's message when the key is refused. */
  onCreate: (input: CreateApiKeyInput) => Promise<void>
  onRevoke: (key: ApiKey) => Promise<void>
  /** For the "unused 90+ days" flag. Defaults to now. */
  now?: Date
  renderLink?: RenderLink
}

const features = tableFeatures({})
const helper = createColumnHelper<typeof features, ApiKey>()
const NO_KEYS: ApiKey[] = []

// Columns that drop out on a phone so the table never scrolls sideways.
const PHONE_HIDDEN = new Set(["access", "createdBy", "expiresAt"])

const formatDate = (value: string) =>
  new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" })

/** The organization's API keys (board OrgApiKeys). Props in, callbacks out. */
export function ApiKeysPage({
  organization,
  roleLabel,
  canList,
  canCreate,
  canRevoke,
  keys,
  keysPending,
  keysError,
  onRetry,
  permissionOptions,
  secret,
  onDismissSecret,
  onCreate,
  onRevoke,
  now,
  renderLink = anchorLink,
}: ApiKeysPageProps) {
  const [creating, setCreating] = useState(false)
  const [revoking, setRevoking] = useState<ApiKey | null>(null)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  // A revoke runs once: the ref catches a second click that lands before the button re-renders.
  const [revokeBusy, setRevokeBusy] = useState(false)
  const revokeBusyRef = useRef(false)
  // The dialog keeps the key it last showed, so its title stays whole while it animates out.
  const [shownRevoking, setShownRevoking] = useState<ApiKey | null>(null)
  if (revoking && revoking !== shownRevoking) setShownRevoking(revoking)
  const dialogRevoking = revoking ?? shownRevoking
  const when = useMemo(() => now ?? new Date(), [now])

  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor("name", {
          header: "Name",
          cell: (info) => <span className="font-semibold">{info.getValue() ?? "API key"}</span>,
        }),
        helper.accessor("start", {
          header: "Key",
          cell: (info) => <span className="font-mono text-sm">{maskedKey(info.getValue())}</span>,
        }),
        helper.display({
          id: "access",
          header: "Access",
          cell: (info) => accessSummary(permissionList(info.row.original.permissions)),
        }),
        helper.display({
          id: "createdBy",
          header: "Created by",
          cell: (info) => createdByLabel(info.row.original.createdBy),
        }),
        helper.accessor("lastUsedAt", {
          header: "Last used",
          cell: (info) => {
            const key = info.row.original
            if (isUnused(key, when)) {
              return (
                <Badge className="rounded-sm bg-solar text-solar-foreground">Unused 90+ days</Badge>
              )
            }
            const value = info.getValue()
            return value ? formatDate(value) : "Never"
          },
        }),
        helper.accessor("expiresAt", {
          header: "Expires",
          cell: (info) => expiryLabel(info.getValue(), formatDate),
        }),
        helper.display({
          id: "actions",
          header: () => <span className="sr-only">Actions</span>,
          cell: (info) =>
            canRevoke ? (
              <Button
                variant="outline"
                aria-label={`Revoke ${info.row.original.name ?? "API key"}`}
                className="min-h-11 border-destructive text-destructive hover:text-destructive"
                onClick={() => {
                  setRevokeError(null)
                  setRevoking(info.row.original)
                }}
              >
                Revoke
              </Button>
            ) : null,
        }),
      ]),
    [canRevoke, when],
  )

  const table = useTable({ features, columns, data: keys ?? NO_KEYS })

  const tabs = settingsTabs(organization.slug)

  async function confirmRevoke() {
    if (!revoking || revokeBusyRef.current) return
    revokeBusyRef.current = true
    setRevokeBusy(true)
    setRevokeError(null)
    try {
      await onRevoke(revoking)
      setRevoking(null)
    } catch (caught) {
      setRevokeError(messageOf(caught))
    } finally {
      revokeBusyRef.current = false
      setRevokeBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SettingsHeader
        title="Organization settings"
        context={`${organization.name} · you are ${roleLabel}`}
        tabs={tabs}
        activeTab="api-keys"
        renderLink={renderLink}
      />

      <PageBody className="gap-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="text-[22px] font-extrabold tracking-tight">API keys</h2>
            <p className="max-w-[560px] text-[14.5px] text-muted-foreground">
              Keys act as {organization.name}, not as a person. Anyone holding a key can use it, so
              treat it like a password.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Button
              className="min-h-11 px-4.5 font-bold disabled:border-dashed disabled:border-muted-foreground"
              disabled={!canCreate}
              aria-describedby={canCreate ? undefined : "create-reason"}
              onClick={() => setCreating(true)}
            >
              Create API key
            </Button>
            {canCreate ? null : (
              <span id="create-reason" className="text-sm text-muted-foreground">
                Only owners and admins can create keys.
              </span>
            )}
          </div>
        </div>

        {secret ? (
          <section
            aria-labelledby="secret-heading"
            className="flex flex-col gap-3 rounded-xl bg-solar p-4 text-solar-foreground"
          >
            <h3 id="secret-heading" className="text-base font-extrabold">
              {secretNotice(secret.name)}
            </h3>
            <CopyField
              label="Secret key"
              value={secret.key}
              className="text-solar-foreground [&_input]:bg-background [&_input]:text-foreground [&_output]:text-solar-foreground"
            />
            <Button variant="outline" className="self-start" onClick={onDismissSecret}>
              I've saved it
            </Button>
          </section>
        ) : null}

        {canList ? null : (
          <ViewOnlyNotice subject={organization.name}>
            Viewers can't see API keys. Ask an owner, admin or member.
          </ViewOnlyNotice>
        )}

        {canList && keysError ? (
          <div role="alert" className="flex flex-col items-start gap-2 text-destructive">
            <p>{keysError}</p>
            <Button variant="outline" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : null}

        {canList && keysPending && !keys ? (
          <output className="block text-muted-foreground">Loading…</output>
        ) : null}

        {canList && keys && keys.length === 0 ? (
          <section className="flex flex-col items-start gap-3 rounded-lg border-2 border-dashed border-border p-5">
            <h3 className="font-bold">No API keys yet</h3>
            <p className="text-muted-foreground">
              Create a key for a CI job, a support bot or another tool that acts for{" "}
              {organization.name}.
            </p>
          </section>
        ) : null}

        {canList && keys && keys.length > 0 ? (
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id} className="hover:bg-transparent">
                  {group.headers.map((header) => (
                    <TableHead
                      key={header.id}
                      className={
                        PHONE_HIDDEN.has(header.column.id) ? "hidden md:table-cell" : undefined
                      }
                    >
                      {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getAllCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={
                        PHONE_HIDDEN.has(cell.column.id) ? "hidden md:table-cell" : undefined
                      }
                    >
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}

        {canList ? (
          <div className="flex flex-col gap-2 text-[13.5px] text-muted-foreground sm:flex-row sm:items-center sm:gap-6">
            <span className="flex items-center gap-2">
              <Badge className="rounded-sm bg-solar text-solar-foreground">Unused 90+ days</Badge>
              consider revoking
            </span>
            <span>Revoking takes effect at once.</span>
          </div>
        ) : null}
      </PageBody>

      <CreateKeyDialog
        open={creating}
        onOpenChange={setCreating}
        organizationName={organization.name}
        options={permissionOptions}
        onCreate={onCreate}
      />

      {canRevoke ? (
        <ConfirmDialog
          open={revoking !== null}
          onOpenChange={(open) => {
            if (!open) setRevoking(null)
          }}
          title={`Revoke ${dialogRevoking?.name ?? "this key"}?`}
          description="Agents using this key stop working immediately. This can't be undone."
          confirmLabel="Revoke key"
          destructive
          pending={revokeBusy}
          error={revokeError}
          onConfirm={() => void confirmRevoke()}
        />
      ) : null}
    </div>
  )
}

/** The first validation message for a field (a Zod issue, or a plain string). */

const createSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the key a name, so you know what uses it.")
    .max(100, "Use 100 characters or fewer."),
  permissions: z.array(z.string()).min(1, "Choose at least one permission."),
  expiry: z.string(),
})

type CreateValues = z.infer<typeof createSchema>

function CreateKeyDialog({
  open,
  onOpenChange,
  organizationName,
  options,
  onCreate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  organizationName: string
  options: PermissionOption[]
  onCreate: (input: CreateApiKeyInput) => Promise<void>
}) {
  const nameId = useId()
  const expiryId = useId()
  const [serverError, setServerError] = useState<string | null>(null)
  const defaults: CreateValues = {
    name: "",
    permissions: options.some((option) => option.key === "project:read") ? ["project:read"] : [],
    expiry: "",
  }

  const form = useForm({
    defaultValues: defaults,
    validators: { onChange: createSchema },
    onSubmit: async ({ value }) => {
      setServerError(null)
      try {
        await onCreate({
          name: value.name.trim(),
          permissions: toPermissionsRecord(value.permissions),
          expiresInDays: value.expiry ? Number(value.expiry) : undefined,
        })
        form.reset()
        onOpenChange(false)
      } catch (caught) {
        setServerError(messageOf(caught))
      }
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create API key</DialogTitle>
          <DialogDescription>
            The key acts as {organizationName}. It can hold only permissions you have yourself.
          </DialogDescription>
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
                  placeholder="CI deploy"
                  aria-invalid={invalidOf(field)}
                  onChange={(event) => field.handleChange(event.currentTarget.value)}
                  onBlur={field.handleBlur}
                />
                <FieldIssues field={field} />
              </Field>
            )}
          </form.Field>

          <form.Field name="permissions">
            {(field) => (
              <fieldset className="flex flex-col gap-2.5">
                <legend className="text-sm font-semibold">Permissions</legend>
                {options.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Your role has no permissions a key can hold.
                  </p>
                ) : null}
                {options.map((option) => {
                  const checkId = `${option.key}-${nameId}`
                  const checked = field.state.value.includes(option.key)
                  return (
                    <div key={option.key} className="flex items-center gap-3">
                      <Checkbox
                        id={checkId}
                        checked={checked}
                        onCheckedChange={(next) =>
                          field.handleChange(
                            next
                              ? [...field.state.value, option.key]
                              : field.state.value.filter((item) => item !== option.key),
                          )
                        }
                      />
                      <label htmlFor={checkId} className="text-sm">
                        {option.label}
                      </label>
                    </div>
                  )
                })}
                <FieldDescription>
                  Only what you can do yourself. Owner-only settings are not offered.
                </FieldDescription>
                <FieldIssues field={field} />
              </fieldset>
            )}
          </form.Field>

          <form.Field name="expiry">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={expiryId}>Expires</FieldLabel>
                <NativeSelect
                  id={expiryId}
                  name="expiry"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.currentTarget.value)}
                  onBlur={field.handleBlur}
                >
                  {EXPIRY_OPTIONS.map((option) => (
                    <NativeSelectOption key={option.label} value={option.value}>
                      {option.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            )}
          </form.Field>

          <FormError message={serverError} />

          <DialogFooter>
            <form.Subscribe selector={(state) => state.isSubmitting}>
              {(isSubmitting) => (
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? "Creating…" : "Create key"}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
