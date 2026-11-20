import { useForm } from "@tanstack/react-form"
import { useId, useState } from "react"
import { z } from "zod"

import { Button } from "@proof/ui/components/ui/button"
import { Field, FieldLabel } from "@proof/ui/components/ui/field"
import { Input } from "@proof/ui/components/ui/input"

import { type PasskeyInfo } from "../../lib/account-api"
import { ConfirmDialog } from "../../components/confirm-dialog"
import { dateLabel } from "../../lib/account-format"

// The sections of the Security page (board Security). Each takes its data and callbacks as props.
// Errors a call throws are shown in the section; the container has already mapped their copy.

import { ROW, TEXT, META, useAction } from "./shared"
import { FieldIssues, FormDialog, FormError, invalidOf, useAppForm } from "../../components/form"

const passkeyNameSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter a name for this passkey.")
    .max(80, "Use 80 characters or fewer."),
})

// ---- Passkeys -------------------------------------------------------------------------------------

export interface PasskeysSectionProps {
  passkeys: PasskeyInfo[]
  onAdd: (name: string) => Promise<void>
  onRename: (id: string, name: string) => Promise<void>
  onRemove: (id: string) => Promise<void>
}

export function PasskeysSection({ passkeys, onAdd, onRename, onRemove }: PasskeysSectionProps) {
  const headingId = useId()
  const [adding, setAdding] = useState(false)
  return (
    <section aria-labelledby={headingId} className="flex flex-col">
      <div className="mb-1.5 flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 id={headingId} className="text-base font-bold">
            Passkeys
          </h2>
          <span className="text-[13.5px] text-muted-foreground">
            Sign in with Touch ID, Face ID or a security key. Nothing to remember, nothing to phish.
          </span>
        </div>
        <Button variant="default" onClick={() => setAdding(true)}>
          Add a passkey
        </Button>
      </div>
      {passkeys.length === 0 ? (
        <p className={ROW}>
          <span className={META}>No passkeys yet.</span>
        </p>
      ) : null}
      {passkeys.map((passkey) => (
        <PasskeyRow key={passkey.id} passkey={passkey} onRename={onRename} onRemove={onRemove} />
      ))}
      <AddPasskeyDialog open={adding} onOpenChange={setAdding} onAdd={onAdd} />
    </section>
  )
}

function PasskeyRow({
  passkey,
  onRename,
  onRemove,
}: {
  passkey: PasskeyInfo
  onRename: (id: string, name: string) => Promise<void>
  onRemove: (id: string) => Promise<void>
}) {
  const label = passkey.name || "Passkey"
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const renameAction = useAction(async (name: string) => {
    await onRename(passkey.id, name)
    setEditing(false)
  })
  const removeAction = useAction(async () => {
    await onRemove(passkey.id)
    setConfirming(false)
  })

  if (editing) {
    return (
      <RenameForm
        label={label}
        busy={renameAction.busy}
        error={renameAction.error}
        onSave={async (name) => {
          await renameAction.call(name)
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }

  return (
    <div className={ROW}>
      <div className={TEXT}>
        <span className="font-semibold">{label}</span>
        <span className={META}>
          {passkey.createdAt ? `Added ${dateLabel(passkey.createdAt)}` : "Added on this account"}
        </span>
      </div>
      <Button variant="outline" aria-label={`Rename ${label}`} onClick={() => setEditing(true)}>
        Rename
      </Button>
      <Button
        variant="outline"
        className="border-destructive text-destructive"
        aria-label={`Remove ${label}`}
        onClick={() => setConfirming(true)}
      >
        Remove
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Remove ${label}?`}
        description="You won't be able to sign in with this passkey any more. Your other ways in stay as they are."
        confirmLabel="Remove passkey"
        pendingLabel="Removing…"
        destructive
        pending={removeAction.busy}
        error={removeAction.error}
        onConfirm={() => void removeAction.call()}
      />
    </div>
  )
}

/** Inline rename of a passkey. Mounts when editing starts, so it always opens on the current name. */
function RenameForm({
  label,
  busy,
  error,
  onSave,
  onCancel,
}: {
  label: string
  busy: boolean
  error: string | null
  onSave: (name: string) => Promise<void>
  onCancel: () => void
}) {
  const inputId = useId()
  const form = useForm({
    defaultValues: { name: label },
    validators: { onSubmit: passkeyNameSchema },
    onSubmit: async ({ value }) => {
      await onSave(value.name.trim())
    },
  })
  return (
    <form
      noValidate
      className={ROW}
      onSubmit={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void form.handleSubmit()
      }}
    >
      <form.Field name="name">
        {(field) => (
          <Field className="min-w-0 flex-1">
            <FieldLabel htmlFor={inputId} className="sr-only">
              Passkey name
            </FieldLabel>
            <Input
              id={inputId}
              value={field.state.value}
              maxLength={80}
              aria-invalid={invalidOf(field)}
              onChange={(event) => field.handleChange(event.currentTarget.value)}
              onBlur={field.handleBlur}
            />
            <FieldIssues field={field} />
          </Field>
        )}
      </form.Field>
      <Button type="submit" disabled={busy}>
        Save name
      </Button>
      <Button type="button" variant="outline" onClick={onCancel}>
        Cancel
      </Button>
      <FormError message={error} />
    </form>
  )
}

function AddPasskeyDialog({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdd: (name: string) => Promise<void>
}) {
  const action = useAction(async (value: string) => {
    await onAdd(value)
    onOpenChange(false)
  })
  const form = useAppForm({
    defaultValues: { name: "This device" },
    validators: { onSubmit: passkeyNameSchema },
    onSubmit: async ({ value }) => {
      await action.call(value.name.trim())
    },
  })
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a passkey"
      description="Your browser will ask you to confirm with this device. The name is only for your list."
      onSubmit={() => void form.handleSubmit()}
      submitLabel="Continue"
      pendingLabel="Waiting for your device…"
      pending={action.busy}
      error={action.error}
    >
      <form.AppField name="name">
        {(field) => <field.TextField label="Passkey name" maxLength={80} />}
      </form.AppField>
    </FormDialog>
  )
}
