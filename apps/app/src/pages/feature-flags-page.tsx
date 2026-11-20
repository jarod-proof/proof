import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table"
import { useId, useMemo, useRef, useState } from "react"

import { Badge } from "@proof/ui/components/ui/badge"
import { Button } from "@proof/ui/components/ui/button"
import { Field, FieldLabel } from "@proof/ui/components/ui/field"
import { NativeSelect, NativeSelectOption } from "@proof/ui/components/ui/native-select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@proof/ui/components/ui/table"
import { type RenderLink, anchorLink } from "@proof/ui/dplus/shell/link"
import { PageBody } from "@proof/ui/dplus/shell/page-header"
import { type SettingsTab, SettingsHeader } from "@proof/ui/dplus/shell/settings-header"

import { ConfirmDialog } from "../components/confirm-dialog"
import { FormError, useAppForm } from "../components/form"
import type {
  FeatureFlag,
  FeatureFlagDetail,
  FlagPatch,
  FlagStatus,
} from "../lib/feature-flags-api"
import {
  FLAG_STATUS_LABEL,
  RAMP_STEPS,
  STALE_LABEL,
  canChangeRollout,
  errorRate,
  parseOrganizations,
  percentageSchema,
  targetsSchema,
  targetsSummary,
} from "../lib/feature-flags"
import { messageOf } from "../lib/messages"

export interface FeatureFlagsPageProps {
  /** The operator organization, which the rollouts are managed as. */
  organization: { name: string }
  /** "Owner", "Admin", "Member" or "Viewer": the caller's role there. */
  roleLabel: string
  /** The admin console's tabs this person may open (adminTabs). */
  tabs: SettingsTab[]
  /** The flags, once loaded. */
  flags: FeatureFlag[] | undefined
  flagsError: string | null
  onRetry: () => void
  /** The flag being managed, or null. */
  selectedKey: string | null
  onSelect: (key: string | null) => void
  /** The selected flag with its targets, once loaded. */
  detail: FeatureFlagDetail | undefined
  detailError: string | null
  /** Each rejects with the server's message (and hint) when refused. */
  onUpdate: (key: string, patch: FlagPatch) => Promise<void>
  onTarget: (key: string, organizations: string[], value: boolean) => Promise<void>
  onUntarget: (key: string, organization: string) => Promise<void>
  onReclaim: (key: string, value: boolean) => Promise<void>
  onDelete: (key: string) => Promise<void>
  renderLink?: RenderLink
}

const features = tableFeatures({})
const helper = createColumnHelper<typeof features, FeatureFlag>()
const NO_FLAGS: FeatureFlag[] = []

// Columns that drop out on a phone so the table never scrolls sideways.
const PHONE_HIDDEN = new Set(["targets", "exposures", "stale"])

const STATUS_VARIANT: Record<FlagStatus, "success" | "outline" | "secondary" | "solar"> = {
  on: "success",
  ramping: "outline",
  targeting: "outline",
  off: "secondary",
  paused: "solar",
  reclaimed: "secondary",
  orphaned: "solar",
}

const onOff = (value: boolean) => (value ? "on" : "off")

/**
 * The admin console's Feature flags tab: each flag's rollout, evaluations and stale signals, and the
 * controls to target, ramp, pause, reclaim and delete, as the operator organization. Props in,
 * callbacks out.
 */
export function FeatureFlagsPage({
  organization,
  roleLabel,
  tabs,
  flags,
  flagsError,
  onRetry,
  selectedKey,
  onSelect,
  detail,
  detailError,
  onUpdate,
  onTarget,
  onUntarget,
  onReclaim,
  onDelete,
  renderLink = anchorLink,
}: FeatureFlagsPageProps) {
  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor("key", {
          header: "Flag",
          cell: (info) => (
            <span className="flex flex-col gap-0.5">
              <span className="font-mono text-sm font-semibold">{info.getValue()}</span>
              <span className="text-[13.5px] text-muted-foreground">
                {info.row.original.description ?? "No longer declared in code"}
              </span>
            </span>
          ),
        }),
        helper.accessor("status", {
          header: "Status",
          cell: (info) => (
            <Badge variant={STATUS_VARIANT[info.getValue()]}>
              {FLAG_STATUS_LABEL[info.getValue()]}
            </Badge>
          ),
        }),
        helper.accessor("percentage", {
          header: "Percent",
          cell: (info) => `${info.getValue()}%`,
        }),
        helper.display({
          id: "targets",
          header: "Targets",
          cell: (info) => targetsSummary(info.row.original),
        }),
        helper.display({
          id: "exposures",
          header: "Last 7 days",
          cell: (info) => {
            const { on, off, errorsOn, errorsOff } = info.row.original.exposures
            return (
              <span className="flex flex-col text-[13.5px]">
                <span>
                  on {on} · off {off}
                </span>
                <span className="text-muted-foreground">
                  errors {errorsOn} · {errorsOff}
                </span>
              </span>
            )
          },
        }),
        helper.display({
          id: "stale",
          header: "Stale",
          cell: (info) => (
            <span className="flex flex-wrap gap-1">
              {info.row.original.stale.map((signal) => (
                <Badge key={signal} variant="solar" size="sm">
                  {STALE_LABEL[signal]}
                </Badge>
              ))}
            </span>
          ),
        }),
        helper.display({
          id: "actions",
          header: () => <span className="sr-only">Actions</span>,
          cell: (info) => (
            <Button
              variant="outline"
              className="min-h-11"
              aria-label={`Manage ${info.row.original.key}`}
              aria-pressed={selectedKey === info.row.original.key}
              onClick={() =>
                onSelect(selectedKey === info.row.original.key ? null : info.row.original.key)
              }
            >
              Manage
            </Button>
          ),
        }),
      ]),
    [selectedKey, onSelect],
  )
  const table = useTable({ features, columns, data: flags ?? NO_FLAGS })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SettingsHeader
        title="Admin"
        context={`As ${organization.name} · you are ${roleLabel}`}
        tabs={tabs}
        activeTab="flags"
        renderLink={renderLink}
      />
      <PageBody className="gap-6">
        {flagsError ? (
          <div role="alert" className="flex flex-col items-start gap-2 text-destructive">
            <p>{flagsError}</p>
            <Button variant="outline" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : null}

        {!flags && !flagsError ? (
          <output className="block text-muted-foreground">Loading…</output>
        ) : null}

        {flags && flags.length === 0 ? (
          <section className="flex flex-col items-start gap-2 rounded-lg border-2 border-dashed border-border p-5">
            <h2 className="font-bold">No feature flags yet</h2>
            <p className="text-muted-foreground">
              Declare one with defineFlags in packages/flags/src/catalog.ts and deploy it.
            </p>
          </section>
        ) : null}

        {flags && flags.length > 0 ? (
          <Table aria-label="Feature flags">
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
                <TableRow
                  key={row.id}
                  data-state={row.original.key === selectedKey ? "selected" : undefined}
                >
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

        {selectedKey ? (
          detail && detail.key === selectedKey ? (
            <FlagDetail
              // A new flag starts with fresh forms and no leftover error.
              key={detail.key}
              flag={detail}
              onUpdate={onUpdate}
              onTarget={onTarget}
              onUntarget={onUntarget}
              onReclaim={onReclaim}
              onDelete={onDelete}
            />
          ) : detailError ? (
            <p role="alert" className="text-destructive">
              {detailError}
            </p>
          ) : (
            <output className="block text-muted-foreground">Loading {selectedKey}…</output>
          )
        ) : null}
      </PageBody>
    </div>
  )
}

/** Runs one action at a time, keeping its error for the section to show. */
function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const busyRef = useRef(false)
  async function run(action: () => Promise<void>): Promise<boolean> {
    if (busyRef.current) return false
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
      return true
    } catch (caught) {
      setError(messageOf(caught))
      return false
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  return { busy, error, run }
}

function FlagDetail({
  flag,
  onUpdate,
  onTarget,
  onUntarget,
  onReclaim,
  onDelete,
}: {
  flag: FeatureFlagDetail
  onUpdate: FeatureFlagsPageProps["onUpdate"]
  onTarget: FeatureFlagsPageProps["onTarget"]
  onUntarget: FeatureFlagsPageProps["onUntarget"]
  onReclaim: FeatureFlagsPageProps["onReclaim"]
  onDelete: FeatureFlagsPageProps["onDelete"]
}) {
  const headingId = useId()
  const action = useAction()
  const changeable = canChangeRollout(flag)
  const [reclaiming, setReclaiming] = useState<boolean | null>(null)
  const [deleting, setDeleting] = useState(false)
  const { on, off, errorsOn, errorsOff } = flag.exposures

  const ramp = useAppForm({
    defaultValues: { percentage: String(flag.percentage) },
    validators: { onSubmit: percentageSchema },
    onSubmit: async ({ value }) => {
      await action.run(() => onUpdate(flag.key, { percentage: Number(value.percentage) }))
    },
  })
  const targets = useAppForm({
    defaultValues: { organizations: "", value: "on" as "on" | "off" },
    validators: { onSubmit: targetsSchema },
    onSubmit: async ({ value, formApi }) => {
      const done = await action.run(() =>
        onTarget(flag.key, parseOrganizations(value.organizations), value.value === "on"),
      )
      if (done) formApi.reset()
    },
  })
  const valueSelectId = useId()

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-5 rounded-lg border-2 border-foreground p-4"
    >
      <header className="flex flex-col gap-1">
        <h2 id={headingId} className="font-mono text-lg font-bold">
          {flag.key}
        </h2>
        <p className="text-muted-foreground">
          {flag.description ?? "No longer declared in code."}
          {flag.owner ? ` Owner: ${flag.owner}.` : ""}
          {flag.default !== null ? ` Default: ${onOff(flag.default)}.` : ""}
          {flag.reclaimBy ? ` Reclaim by ${flag.reclaimBy}.` : ""}
        </p>
      </header>

      {flag.status === "reclaimed" && flag.reclaimedValue !== null ? (
        <p className="rounded-lg bg-muted p-3 text-sm">
          Reclaimed: every organization gets {onOff(flag.reclaimedValue)}. Remove the flag from the
          code, deploy, then delete its rollout here.
        </p>
      ) : null}

      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">Evaluations on (7 days)</dt>
          <dd className="font-semibold">{on}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Evaluations off (7 days)</dt>
          <dd className="font-semibold">{off}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Errors per 1,000, on</dt>
          <dd className="font-semibold">{errorRate(on, errorsOn)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Errors per 1,000, off</dt>
          <dd className="font-semibold">{errorRate(off, errorsOff)}</dd>
        </div>
      </dl>

      {changeable ? (
        <div className="flex flex-col gap-3">
          <h3 className="font-bold">Rollout</h3>
          <fieldset className="flex flex-wrap gap-2">
            <legend className="sr-only">Ramp to</legend>
            {RAMP_STEPS.map((step) => (
              <Button
                key={step}
                variant={flag.percentage === step ? "default" : "outline"}
                className="min-h-11"
                aria-pressed={flag.percentage === step}
                disabled={action.busy}
                onClick={() => void action.run(() => onUpdate(flag.key, { percentage: step }))}
              >
                {step}%
              </Button>
            ))}
          </fieldset>
          <form
            noValidate
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void ramp.handleSubmit()
            }}
          >
            <ramp.AppField name="percentage">
              {(field) => (
                <field.TextField label="Percentage" inputMode="numeric" className="w-28" />
              )}
            </ramp.AppField>
            <ramp.AppForm>
              <ramp.SubmitButton variant="outline" className="min-h-11" pending={action.busy}>
                Set percentage
              </ramp.SubmitButton>
            </ramp.AppForm>
          </form>
          <Button
            variant="outline"
            className="min-h-11 self-start"
            disabled={action.busy}
            onClick={() => void action.run(() => onUpdate(flag.key, { enabled: !flag.enabled }))}
          >
            {flag.enabled ? "Pause (serve the default to all)" : "Resume"}
          </Button>
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        <h3 className="font-bold">Targets</h3>
        {flag.targets.length === 0 ? (
          <p className="text-muted-foreground">No organizations are targeted.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {flag.targets.map((target) => (
              <li
                key={target.organizationId}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-semibold">{target.name}</span>
                  <span className="font-mono text-[13px] text-muted-foreground">{target.slug}</span>
                </span>
                <Badge variant={target.value ? "success" : "secondary"}>
                  {onOff(target.value)}
                </Badge>
                {changeable ? (
                  <Button
                    variant="outline"
                    className="min-h-11"
                    aria-label={`Remove ${target.name} from ${flag.key}`}
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(() => onUntarget(flag.key, target.organizationId))
                    }
                  >
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {changeable ? (
          <form
            noValidate
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void targets.handleSubmit()
            }}
          >
            <targets.AppField name="organizations">
              {(field) => (
                <field.TextField
                  label="Organizations"
                  description="Ids or slugs, separated by commas."
                  placeholder="acme, org_123"
                />
              )}
            </targets.AppField>
            <targets.Field name="value">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={valueSelectId}>Turn the flag</FieldLabel>
                  <NativeSelect
                    id={valueSelectId}
                    name="value"
                    value={field.state.value}
                    onChange={(event) =>
                      field.handleChange(event.currentTarget.value === "off" ? "off" : "on")
                    }
                    onBlur={field.handleBlur}
                  >
                    <NativeSelectOption value="on">On for them</NativeSelectOption>
                    <NativeSelectOption value="off">Off for them</NativeSelectOption>
                  </NativeSelect>
                </Field>
              )}
            </targets.Field>
            <targets.AppForm>
              <targets.SubmitButton className="min-h-11 self-start" pending={action.busy}>
                Add targets
              </targets.SubmitButton>
            </targets.AppForm>
          </form>
        ) : null}
      </div>

      <FormError message={action.error} />

      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        {changeable ? (
          <>
            <Button variant="destructive" className="min-h-11" onClick={() => setReclaiming(true)}>
              Reclaim as on
            </Button>
            <Button variant="destructive" className="min-h-11" onClick={() => setReclaiming(false)}>
              Reclaim as off
            </Button>
          </>
        ) : null}
        <Button
          variant="destructive"
          className="min-h-11"
          disabled={flag.status !== "orphaned"}
          onClick={() => setDeleting(true)}
        >
          Delete rollout
        </Button>
      </div>
      {flag.status === "orphaned" ? null : (
        <p className="text-[13.5px] text-muted-foreground">
          Delete is for a flag the code no longer declares: reclaim it, remove it from the code and
          deploy first.
        </p>
      )}

      <ConfirmDialog
        open={reclaiming !== null}
        onOpenChange={(open) => {
          if (!open) setReclaiming(null)
        }}
        title={`Reclaim ${flag.key} as ${onOff(reclaiming ?? true)}?`}
        description={`Every organization gets ${onOff(reclaiming ?? true)} from now on, whatever its targets or the percentage. This can't be undone.`}
        confirmLabel={`Reclaim as ${onOff(reclaiming ?? true)}`}
        pendingLabel="Reclaiming…"
        destructive
        pending={action.busy}
        error={action.error}
        onConfirm={() => {
          const value = reclaiming
          if (value === null) return
          void action
            .run(() => onReclaim(flag.key, value))
            .then((done) => {
              if (done) setReclaiming(null)
            })
        }}
      />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete the rollout of ${flag.key}?`}
        description="Its targets go with it. The code no longer declares this flag, so nothing reads it."
        confirmLabel="Delete rollout"
        pendingLabel="Deleting…"
        destructive
        pending={action.busy}
        error={action.error}
        onConfirm={() => {
          void action
            .run(() => onDelete(flag.key))
            .then((done) => {
              if (done) setDeleting(false)
            })
        }}
      />
    </section>
  )
}
