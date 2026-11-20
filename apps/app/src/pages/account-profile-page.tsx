import { FieldIssues, invalidOf, issueOf } from "../components/form"
import { useForm } from "@tanstack/react-form"
import { useId, useState } from "react"
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
import { Field, FieldError, FieldLabel } from "@proof/ui/components/ui/field"
import { Input } from "@proof/ui/components/ui/input"
import { DangerAction, DangerZone } from "@proof/ui/dplus/shell/danger-zone"
import { type RenderLink, anchorLink } from "@proof/ui/dplus/shell/link"
import { PageBody } from "@proof/ui/dplus/shell/page-header"
import { SettingsHeader } from "@proof/ui/dplus/shell/settings-header"

import { ConfirmDialog } from "../components/confirm-dialog"
import { ImageUpload, type ImageUploadLimits } from "../components/image-upload"
import { initialsOf } from "../lib/account-format"
import { messageOf } from "../lib/messages"

export interface AccountOrganization {
  id: string
  name: string
  slug: string
  /** "Owner", "Admin", "Member" or "Viewer". */
  roleLabel: string
  personal: boolean
  owner: boolean
}

export interface AccountProfileValues {
  name: string
}

/** The avatar's upload: what the server accepts (null while uploads are off) and the two actions. */
export interface AvatarUpload {
  limits: ImageUploadLimits | null
  onUpload: (file: File) => Promise<void>
  onRemove: () => Promise<void>
}

export interface AccountProfilePageProps {
  profile: { name: string; email: string; emailVerified: boolean; image?: string | null }
  /** Omitted, uploads are shown as off. */
  avatar?: AvatarUpload
  /** The address waiting for its confirmation link, or null. Local to this visit. */
  pendingEmail: string | null
  /** Set once the deletion link was emailed: the address it went to. */
  deleteRequestedTo: string | null
  organizations: AccountOrganization[]
  /** False until every organization's role is known: owned organizations can't be told apart before. */
  rolesReady: boolean
  onSaveName: (name: string) => Promise<void>
  onChangeEmail: (newEmail: string) => Promise<void>
  onResendChange: () => Promise<void>
  onCancelChange: () => void
  onLeave: (organizationId: string) => Promise<void>
  onRequestDelete: () => Promise<void>
  renderLink?: RenderLink
}

const nameSchema = z.object({
  name: z.string().trim().min(1, "Enter your name.").max(80, "Use 80 characters or fewer."),
})

const emailSchema = z.string().trim().email("Enter an email address, like you@example.com.")

/** The personal account page (board Profile): name, email, organizations and deleting the account. */
export function AccountProfilePage({
  profile,
  avatar,
  pendingEmail,
  deleteRequestedTo,
  organizations,
  rolesReady,
  onSaveName,
  onChangeEmail,
  onResendChange,
  onCancelChange,
  onLeave,
  onRequestDelete,
  renderLink = anchorLink,
}: AccountProfilePageProps) {
  const blockers = organizations.filter((org) => org.owner && !org.personal)
  const personal = organizations.find((org) => org.personal)
  const otherNames = organizations.filter((org) => !org.personal).map((org) => org.name)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SettingsHeader
        title="Personal settings"
        context={`${profile.name} · ${profile.email}`}
        tabs={[
          { id: "profile", label: "Profile & account", href: "/account/profile" },
          { id: "security", label: "Security", href: "/account/security" },
        ]}
        activeTab="profile"
        renderLink={renderLink}
      />

      <PageBody className="gap-5">
        <AvatarRow
          name={profile.name}
          email={profile.email}
          image={profile.image ?? null}
          upload={avatar}
        />
        <NameForm initialName={profile.name} onSave={onSaveName} />
        <EmailSection
          email={profile.email}
          verified={profile.emailVerified}
          pendingEmail={pendingEmail}
          onChangeEmail={onChangeEmail}
          onResendChange={onResendChange}
          onCancelChange={onCancelChange}
        />
        <OrganizationsSection
          organizations={organizations}
          rolesReady={rolesReady}
          personal={personal}
          onLeave={onLeave}
          renderLink={renderLink}
        />
        <DeleteSection
          rolesReady={rolesReady}
          blockers={blockers}
          renderLink={renderLink}
          otherNames={otherNames}
          email={profile.email}
          requestedTo={deleteRequestedTo}
          onRequestDelete={onRequestDelete}
        />
      </PageBody>
    </div>
  )
}

function AvatarRow({
  name,
  email,
  image,
  upload,
}: {
  name: string
  email: string
  image: string | null
  upload: AvatarUpload | undefined
}) {
  return (
    <div className="flex items-center gap-4">
      <span
        aria-hidden="true"
        className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-full border-2 border-foreground text-xl font-bold"
      >
        {image ? (
          <img src={image} alt="" className="size-full object-cover" />
        ) : (
          initialsOf(name, email)
        )}
      </span>
      <ImageUpload
        uploadLabel="Upload photo"
        removeLabel="Use initials"
        hasImage={image !== null}
        limits={upload?.limits ?? null}
        offReason="Photo upload is off on this server, so your initials are shown."
        guidance="A square photo works best."
        onUpload={(file) => upload?.onUpload(file) ?? Promise.resolve()}
        onRemove={() => upload?.onRemove() ?? Promise.resolve()}
      />
    </div>
  )
}

function NameForm({
  initialName,
  onSave,
}: {
  initialName: string
  onSave: (name: string) => Promise<void>
}) {
  const id = useId()
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const form = useForm({
    defaultValues: { name: initialName } satisfies AccountProfileValues,
    validators: { onChange: nameSchema },
    onSubmit: async ({ value }) => {
      setSaveError(null)
      setSaved(false)
      try {
        await onSave(value.name.trim())
        setSaved(true)
      } catch (error) {
        setSaveError(messageOf(error))
      }
    },
  })

  return (
    <form
      noValidate
      className="flex flex-wrap items-end gap-2.5"
      onSubmit={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void form.handleSubmit()
      }}
    >
      <form.Field name="name">
        {(field) => (
          <Field className="min-w-[12rem] flex-1">
            <FieldLabel htmlFor={id}>Name</FieldLabel>
            <Input
              id={id}
              name="name"
              autoComplete="name"
              value={field.state.value}
              aria-invalid={invalidOf(field)}
              onChange={(event) => {
                setSaved(false)
                field.handleChange(event.currentTarget.value)
              }}
              onBlur={field.handleBlur}
            />
            <FieldIssues field={field} />
          </Field>
        )}
      </form.Field>
      <form.Subscribe selector={(state) => ({ values: state.values, busy: state.isSubmitting })}>
        {({ values, busy }) => (
          <Button
            type="submit"
            disabled={busy || values.name.trim() === initialName || values.name.trim() === ""}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        )}
      </form.Subscribe>
      {saved ? <output className="self-center text-sm text-muted-foreground">Saved.</output> : null}
      {saveError ? (
        <p role="alert" className="basis-full text-sm text-destructive">
          {saveError}
        </p>
      ) : null}
    </form>
  )
}

function EmailSection({
  email,
  verified,
  pendingEmail,
  onChangeEmail,
  onResendChange,
  onCancelChange,
}: {
  email: string
  verified: boolean
  pendingEmail: string | null
  onChangeEmail: (newEmail: string) => Promise<void>
  onResendChange: () => Promise<void>
  onCancelChange: () => void
}) {
  const [open, setOpen] = useState(false)
  const [resent, setResent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const headingId = useId()

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2.5">
      <h2 id={headingId} className="text-base font-bold">
        Email
      </h2>
      <div className="flex items-center gap-3 border-y border-border py-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-semibold">{email}</span>
          <span className="text-[13.5px] text-muted-foreground">
            {verified
              ? "Verified · used to sign in and for notices"
              : "Not verified yet · check your inbox for the link we sent"}
          </span>
        </div>
        <Button
          variant="outline"
          disabled={pendingEmail !== null}
          onClick={() => {
            setError(null)
            setOpen(true)
          }}
        >
          Change email
        </Button>
      </div>

      {pendingEmail ? (
        <output className="flex flex-wrap items-start gap-3 rounded-[10px] border-2 border-foreground p-3.5">
          <span className="rounded bg-solar px-1.5 text-xs font-extrabold text-solar-foreground">
            Pending
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span>
              We sent a confirmation link to <strong>{pendingEmail}</strong>.
            </span>
            <span className="text-[13.5px] text-muted-foreground">
              Your email stays {email} until you click it. We also told your current address, in
              case this wasn't you.
            </span>
            {resent ? (
              <span className="text-[13.5px] text-muted-foreground">Sent again.</span>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError(null)
                try {
                  await onResendChange()
                  setResent(true)
                } catch (caught) {
                  setError(messageOf(caught))
                } finally {
                  setBusy(false)
                }
              }}
            >
              Resend
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setResent(false)
                onCancelChange()
              }}
            >
              Cancel change
            </Button>
          </div>
        </output>
      ) : null}
      {error && !open ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <ChangeEmailDialog
        open={open}
        onOpenChange={setOpen}
        currentEmail={email}
        onSubmit={async (newEmail) => {
          setResent(false)
          await onChangeEmail(newEmail)
          setOpen(false)
        }}
      />
    </section>
  )
}

function ChangeEmailDialog({
  open,
  onOpenChange,
  currentEmail,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentEmail: string
  onSubmit: (newEmail: string) => Promise<void>
}) {
  const id = useId()
  const [serverError, setServerError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const form = useForm({
    defaultValues: { email: "" },
    validators: {
      onSubmit: z.object({
        email: emailSchema.refine(
          (value) => value.trim().toLowerCase() !== currentEmail.toLowerCase(),
          { message: "That is already your email." },
        ),
      }),
    },
    onSubmit: async ({ value }) => {
      setBusy(true)
      setServerError(null)
      try {
        await onSubmit(value.email.trim().toLowerCase())
        form.reset()
      } catch (caught) {
        setServerError(messageOf(caught))
      } finally {
        setBusy(false)
      }
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change email</DialogTitle>
          <DialogDescription>
            We'll send a confirmation link to the new address. Your email doesn't change until you
            open it, and we'll tell your current address that a change was requested.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            event.stopPropagation()
            void form.handleSubmit()
          }}
        >
          <form.Field name="email">
            {(field) => {
              const message = issueOf(field) ?? serverError
              return (
                <Field>
                  <FieldLabel htmlFor={id}>New email</FieldLabel>
                  <Input
                    id={id}
                    name="email"
                    type="email"
                    autoComplete="email"
                    value={field.state.value}
                    aria-invalid={message ? true : undefined}
                    onChange={(event) => {
                      setServerError(null)
                      field.handleChange(event.currentTarget.value)
                    }}
                    onBlur={field.handleBlur}
                  />
                  {message ? <FieldError>{message}</FieldError> : null}
                </Field>
              )
            }}
          </form.Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send confirmation link"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function OrganizationsSection({
  organizations,
  rolesReady,
  personal,
  onLeave,
  renderLink,
}: {
  organizations: AccountOrganization[]
  rolesReady: boolean
  personal: AccountOrganization | undefined
  onLeave: (organizationId: string) => Promise<void>
  renderLink: RenderLink
}) {
  const headingId = useId()
  const rows = [...(personal ? [personal] : []), ...organizations.filter((org) => !org.personal)]
  return (
    <section aria-labelledby={headingId} className="flex flex-col">
      <h2 id={headingId} className="mb-1.5 text-base font-bold">
        Your organizations
      </h2>
      {rows.length === 0 ? (
        <p className="border-t border-border py-2.5 text-muted-foreground">
          You're not in any organizations yet.
        </p>
      ) : null}
      {rows.map((org) => (
        <div key={org.id} className="flex items-center gap-3 border-t border-border py-2.5">
          <span
            aria-hidden="true"
            className="grid size-7 place-items-center rounded-md border-[1.5px] border-foreground text-sm font-extrabold"
          >
            {org.name.trim()[0]?.toUpperCase() ?? "?"}
          </span>
          <span className="min-w-0 flex-1 truncate font-semibold">{org.name}</span>
          <span className="text-sm text-muted-foreground">
            {org.personal ? `Personal · ${org.roleLabel}` : org.roleLabel}
          </span>
          {!org.personal && !org.owner ? <LeaveButton org={org} onLeave={onLeave} /> : null}
          {rolesReady && !org.personal && org.owner ? (
            <span className="text-sm text-muted-foreground">
              {renderLink({
                href: `/${org.slug}/settings/general`,
                className: "underline underline-offset-4",
                children: "Transfer first",
              })}
            </span>
          ) : null}
        </div>
      ))}
    </section>
  )
}

function LeaveButton({
  org,
  onLeave,
}: {
  org: AccountOrganization
  onLeave: (organizationId: string) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const consequence = `You'll lose access to ${org.name} right away. An admin can invite you again.`
  const leave = async () => {
    setBusy(true)
    setError(null)
    try {
      await onLeave(org.id)
      setOpen(false)
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Leave
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Leave ${org.name}?`}
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

function DeleteSection({
  rolesReady,
  blockers,
  otherNames,
  email,
  requestedTo,
  onRequestDelete,
  renderLink,
}: {
  rolesReady: boolean
  blockers: AccountOrganization[]
  otherNames: string[]
  email: string
  requestedTo: string | null
  onRequestDelete: () => Promise<void>
  renderLink: RenderLink
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const removal = otherNames.length > 0 ? ` and removes you from ${otherNames.join(", ")}` : ""
  const consequence = `Deletes your user, sessions, passkeys and connected accounts${removal}. We email a confirmation link before anything is deleted.`
  const blocked = rolesReady && blockers.length > 0
  const requestDelete = async () => {
    setBusy(true)
    setError(null)
    try {
      await onRequestDelete()
      setOpen(false)
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DangerZone title="Delete account">
      {requestedTo ? (
        <output className="block text-sm">
          We emailed a confirmation link to <strong>{requestedTo}</strong>. Open it to finish
          deleting your account. Nothing is deleted until you do.
        </output>
      ) : blocked ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <p className="flex max-w-prose flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="rounded bg-solar px-1.5 text-xs font-extrabold text-solar-foreground">
              Blocked
            </span>
            <span>You own {blockers.map((org) => org.name).join(", ")}.</span>
            {renderLink({
              href: `/${blockers[0]?.slug ?? ""}/settings/general`,
              className: "text-foreground underline underline-offset-4",
              children: "Transfer or delete it first",
            })}
          </p>
          <Button variant="destructive" disabled className="shrink-0 border-dashed">
            Delete my account
          </Button>
        </div>
      ) : !rolesReady ? (
        <DangerAction
          label="Delete my account"
          consequence={consequence}
          disabled
          disabledReason="Checking your organizations…"
          onAction={() => undefined}
        />
      ) : (
        <DangerAction
          label="Delete my account"
          consequence={consequence}
          onAction={() => {
            setError(null)
            setOpen(true)
          }}
        />
      )}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete your account?"
        description={
          <>
            {consequence} We'll send the link to {email}.
          </>
        }
        confirmLabel="Email me the link"
        pendingLabel="Sending…"
        destructive
        pending={busy}
        error={error}
        onConfirm={() => void requestDelete()}
      />
    </DangerZone>
  )
}
