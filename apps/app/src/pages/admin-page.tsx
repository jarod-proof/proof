import { FormError } from "../components/form"
import { useForm } from "@tanstack/react-form"
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useId, useMemo, useRef, useState } from "react"

import { Button } from "@proof/ui/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@proof/ui/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@proof/ui/components/ui/dropdown-menu"
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
import { type RenderLink, anchorLink } from "@proof/ui/dplus/shell/link"
import { PageBody } from "@proof/ui/dplus/shell/page-header"
import { type SettingsTab, SettingsHeader } from "@proof/ui/dplus/shell/settings-header"
import { Status } from "@proof/ui/dplus/status"

import type { AdminAction } from "../containers/admin-data"
import type { AdminRole, AdminSession, AdminUser } from "../lib/admin-api"
import { messageOf } from "../lib/messages"

export const ADMIN_PAGE_SIZE = 50
// Pages up to this many rows render in full; longer ones window the rows with TanStack Virtual.
const VIRTUAL_ROWS = 25

// Ban durations, in seconds for better-auth (`banExpiresIn`). "permanent" sends no expiry.
const BAN_DURATIONS = {
  permanent: { label: "Permanent", seconds: undefined },
  day: { label: "1 day", seconds: 86_400 },
  week: { label: "7 days", seconds: 604_800 },
  month: { label: "30 days", seconds: 2_592_000 },
} as const
type BanDuration = keyof typeof BAN_DURATIONS

type DialogKind = "ban" | "unban" | "impersonate" | "revoke" | "role"
type OpenDialog = { kind: DialogKind; user: AdminUser }

const tableFeaturesSet = tableFeatures({})
const helper = createColumnHelper<typeof tableFeaturesSet, AdminUser>()

// On a phone the table drops the columns it can't fit, so it never scrolls sideways: the email
// moves under the name, and the role shows in the actions menu (Make admin / Change role to user).
const PHONE_HIDDEN = new Set(["email", "verified", "role", "createdAt"])

export interface AdminPageProps {
  /** The signed-in admin. Used to stop them acting on their own account. */
  me: AdminSession
  /** The admin console's tabs this person may open (adminTabs). */
  tabs: SettingsTab[]
  users: AdminUser[]
  total: number
  loading: boolean
  error: string | null
  search: string
  onSearch: (value: string) => void
  offset: number
  limit?: number
  onPage: (offset: number) => void
  onAction: (action: AdminAction) => Promise<void>
  renderLink?: RenderLink
}

/**
 * The admin console's Users tab: every user, with search, paging and per-user actions. Props in,
 * callbacks out.
 */
export function AdminPage({
  me,
  tabs,
  users,
  total,
  loading,
  error,
  search,
  onSearch,
  offset,
  limit = ADMIN_PAGE_SIZE,
  onPage,
  onAction,
  renderLink = anchorLink,
}: AdminPageProps) {
  const [dialog, setDialog] = useState<OpenDialog | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const searchId = useId()

  const columns = useMemo(
    () =>
      helper.columns([
        helper.accessor("name", {
          header: "Name",
          cell: (info) => (
            <span className="flex flex-col gap-0.5 whitespace-normal">
              <span className="break-words">{info.getValue() || "—"}</span>
              <span className="break-all text-muted-foreground md:hidden">
                {info.row.original.email}
                {info.row.original.id === me.userId ? " (you)" : null}
              </span>
            </span>
          ),
        }),
        helper.accessor("email", {
          header: "Email",
          cell: (info) => (
            <span className="break-all">
              {info.getValue()}
              {info.row.original.id === me.userId ? (
                <span className="ml-1.5 text-muted-foreground">(you)</span>
              ) : null}
            </span>
          ),
        }),
        helper.accessor("emailVerified", {
          id: "verified",
          header: "Verified",
          cell: (info) => (info.getValue() ? "Verified" : "Unverified"),
        }),
        helper.accessor("role", {
          header: "Role",
          cell: (info) => (info.getValue() === "admin" ? "Admin" : "User"),
        }),
        helper.display({
          id: "status",
          header: "Status",
          cell: (info) => {
            const user = info.row.original
            if (!user.banned) return <Status state="done">Active</Status>
            const until = user.banExpires
              ? ` until ${new Date(user.banExpires).toLocaleDateString(undefined, { dateStyle: "medium" })}`
              : ""
            return <Status state="failed">{`Banned${until}`}</Status>
          },
        }),
        helper.accessor("createdAt", {
          id: "createdAt",
          header: "Created",
          cell: (info) => {
            const value = info.getValue()
            return value
              ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" })
              : "—"
          },
        }),
        helper.display({
          id: "actions",
          header: () => <span className="sr-only">Actions</span>,
          cell: (info) => {
            const user = info.row.original
            const self = user.id === me.userId
            const isAdmin = user.role === "admin"
            const name = user.name || user.email
            return (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      aria-label={`Actions for ${name}`}
                      className="size-11 text-lg"
                    >
                      ⋯
                    </Button>
                  }
                />
                <DropdownMenuContent align="end">
                  {user.banned ? (
                    <DropdownMenuItem onClick={() => setDialog({ kind: "unban", user })}>
                      Unban
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      className="text-destructive"
                      disabled={self}
                      onClick={() => setDialog({ kind: "ban", user })}
                    >
                      Ban
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    disabled={self || isAdmin}
                    onClick={() => setDialog({ kind: "impersonate", user })}
                  >
                    Impersonate
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive"
                    disabled={self}
                    onClick={() => setDialog({ kind: "revoke", user })}
                  >
                    Sign out everywhere
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={self}
                    onClick={() => setDialog({ kind: "role", user })}
                  >
                    {isAdmin ? "Change role to user" : "Make admin"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )
          },
        }),
      ]),
    [me.userId],
  )

  // Rows keyed by user, not position: a search or refresh reorders the list, and an open actions
  // menu must stay with its user rather than close or move to whoever now sits in that row.
  const table = useTable({
    features: tableFeaturesSet,
    columns,
    data: users,
    getRowId: (user) => user.id,
  })
  const rows = table.getRowModel().rows

  const virtual = rows.length > VIRTUAL_ROWS
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 58,
    overscan: 6,
    initialRect: { width: 0, height: 480 },
  })
  const items = virtual ? virtualizer.getVirtualItems() : []
  // Row indexes to draw: the windowed ones for a long list, every row otherwise.
  const shown = virtual ? items.map((item) => item.index) : rows.map((_, index) => index)
  const paddingTop = items[0]?.start ?? 0
  const paddingBottom = Math.max(
    0,
    virtualizer.getTotalSize() - (items[items.length - 1]?.end ?? 0),
  )
  const phoneClass = (id: string) => (PHONE_HIDDEN.has(id) ? "hidden md:table-cell" : undefined)
  const first = total === 0 ? 0 : offset + 1
  const last = Math.min(offset + limit, total)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SettingsHeader
        title="Admin"
        context="Every user on this server"
        tabs={tabs}
        activeTab="users"
        renderLink={renderLink}
      />
      <PageBody className="gap-6">
        {dialog ? (
          <ActionDialog
            key={`${dialog.kind}-${dialog.user.id}`}
            dialog={dialog}
            onClose={() => setDialog(null)}
            onAction={onAction}
          />
        ) : null}

        <section aria-labelledby="users-heading" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id="users-heading" className="text-base font-bold">
              Users
            </h2>
            <Field className="w-full max-w-xs">
              <FieldLabel htmlFor={searchId}>Search by email</FieldLabel>
              <Input
                id={searchId}
                type="search"
                value={search}
                placeholder="ada@example.com"
                onChange={(event) => onSearch(event.target.value)}
                className="min-h-11"
              />
            </Field>
          </div>

          <FormError message={error} />

          <div
            ref={scrollRef}
            role={virtual ? "region" : undefined}
            aria-label={virtual ? "Users, scrollable" : undefined}
            tabIndex={virtual ? 0 : undefined}
            className={virtual ? "max-h-[560px] overflow-y-auto" : undefined}
          >
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {table.getHeaderGroups()[0]?.headers.map((header) => (
                    <TableHead key={header.id} className={phoneClass(header.column.id)}>
                      {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {paddingTop > 0 ? (
                  <TableRow aria-hidden="true" className="hover:bg-transparent">
                    <TableCell
                      colSpan={columns.length}
                      className="p-0"
                      style={{ height: paddingTop }}
                    />
                  </TableRow>
                ) : null}
                {shown.map((index) => {
                  const row = rows[index]
                  if (!row) return null
                  return (
                    <TableRow key={row.id}>
                      {row.getAllCells().map((cell) => (
                        <TableCell key={cell.id} className={phoneClass(cell.column.id)}>
                          <table.FlexRender cell={cell} />
                        </TableCell>
                      ))}
                    </TableRow>
                  )
                })}
                {paddingBottom > 0 ? (
                  <TableRow aria-hidden="true" className="hover:bg-transparent">
                    <TableCell
                      colSpan={columns.length}
                      className="p-0"
                      style={{ height: paddingBottom }}
                    />
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
            {!loading && users.length === 0 && !error ? (
              <p className="border-t border-border py-4 text-sm text-muted-foreground">
                {search ? "No users match that email." : "No users yet."}
              </p>
            ) : null}
            {loading && users.length === 0 ? (
              <output className="block border-t border-border py-4 text-sm text-muted-foreground">
                Loading users…
              </output>
            ) : null}
          </div>

          <nav aria-label="Pages" className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted-foreground" aria-live="polite">
              {total === 0 ? "No users" : `Showing ${first}–${last} of ${total}`}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={offset === 0}
                onClick={() => onPage(Math.max(0, offset - limit))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                disabled={offset + limit >= total}
                onClick={() => onPage(offset + limit)}
              >
                Next
              </Button>
            </div>
          </nav>
        </section>
      </PageBody>
    </div>
  )
}

/**
 * Shown to anyone a console tab isn't for: Users to anyone but a platform admin (and to an admin
 * acting as someone else), Feature flags to anyone outside the operator organization.
 */
export function AdminNotAvailable({
  forWhom = "platform admins",
  renderLink = anchorLink,
}: {
  /** Who the page is for, e.g. "members of the operator organization". */
  forWhom?: string
  renderLink?: RenderLink
}) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-16">
      <h1 className="text-2xl font-extrabold">Not available</h1>
      <p className="text-muted-foreground">
        This page is for {forWhom}. If you think you should have access, ask the team that runs this
        app.
      </p>
      {renderLink({
        href: "/",
        children: "Back to the app",
        className: "min-h-11 inline-flex items-center font-bold underline underline-offset-4",
      })}
    </div>
  )
}

interface ActionDialogProps {
  dialog: OpenDialog
  onClose: () => void
  onAction: (action: AdminAction) => Promise<void>
}

/** One dialog per action. Each names the consequence and confirms before the server is called. */
function ActionDialog({ dialog, onClose, onAction }: ActionDialogProps) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const { kind, user } = dialog
  const name = user.name || user.email

  const run = async (action: AdminAction) => {
    setError(null)
    setPending(true)
    try {
      await onAction(action)
      onClose()
    } catch (caught) {
      setError(messageOf(caught))
      setPending(false)
    }
  }

  const copy = COPY[kind]
  const title = copy.title(name)

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{copy.consequence(user)}</DialogDescription>
        </DialogHeader>
        {kind === "ban" ? (
          <BanForm
            pending={pending}
            error={error}
            onSubmit={(build) => run(build(user.id))}
            onCancel={onClose}
          />
        ) : kind === "role" ? (
          <RoleForm
            current={user.role === "admin" ? "admin" : "user"}
            pending={pending}
            error={error}
            onSubmit={(role) => run({ kind: "role", userId: user.id, role })}
            onCancel={onClose}
          />
        ) : (
          <>
            <FormError message={error} />
            <DialogFooter>
              <Button variant="outline" onClick={onClose} disabled={pending}>
                Cancel
              </Button>
              <Button
                variant={copy.destructive ? "destructive" : "default"}
                disabled={pending}
                onClick={() => copy.action && run(copy.action(user.id))}
              >
                {copy.confirm}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

interface BanFormValues {
  reason: string
  duration: BanDuration
}

function BanForm({
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  pending: boolean
  error: string | null
  onSubmit: (build: (userId: string) => AdminAction) => Promise<void>
  onCancel: () => void
}) {
  const reasonId = useId()
  const durationId = useId()
  const form = useForm({
    defaultValues: { reason: "", duration: "permanent" } as BanFormValues,
    onSubmit: async ({ value }) => {
      const seconds = BAN_DURATIONS[value.duration].seconds
      const reason = value.reason.trim()
      await onSubmit((userId) => ({
        kind: "ban",
        userId,
        reason,
        expiresInSeconds: seconds,
      }))
    },
  })
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        void form.handleSubmit()
      }}
    >
      <form.Field name="reason">
        {(field) => (
          <Field>
            <FieldLabel htmlFor={reasonId}>Reason (optional)</FieldLabel>
            <Input
              id={reasonId}
              value={field.state.value}
              maxLength={200}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              className="min-h-11"
            />
            <FieldDescription>Kept with the ban. Users don't see it.</FieldDescription>
          </Field>
        )}
      </form.Field>
      <form.Field name="duration">
        {(field) => (
          <Field>
            <FieldLabel htmlFor={durationId}>Ban for</FieldLabel>
            <NativeSelect
              id={durationId}
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value as BanDuration)}
            >
              {(Object.keys(BAN_DURATIONS) as BanDuration[]).map((key) => (
                <NativeSelectOption key={key} value={key}>
                  {BAN_DURATIONS[key].label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        )}
      </form.Field>
      <FormError message={error} />
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" variant="destructive" disabled={pending}>
          Ban user
        </Button>
      </DialogFooter>
    </form>
  )
}

function RoleForm({
  current,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  current: AdminRole
  pending: boolean
  error: string | null
  onSubmit: (role: AdminRole) => Promise<void>
  onCancel: () => void
}) {
  const roleId = useId()
  const [role, setRole] = useState<AdminRole>(current)
  const changed = role !== current
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (changed) void onSubmit(role)
      }}
    >
      <Field>
        <FieldLabel htmlFor={roleId}>Platform role</FieldLabel>
        <NativeSelect
          id={roleId}
          value={role}
          onChange={(event) => setRole(event.target.value as AdminRole)}
        >
          <NativeSelectOption value="user">User</NativeSelectOption>
          <NativeSelectOption value="admin">Admin</NativeSelectOption>
        </NativeSelect>
      </Field>
      <FormError message={error} />
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !changed}>
          Set role
        </Button>
      </DialogFooter>
    </form>
  )
}

const COPY: Record<
  DialogKind,
  {
    title: (name: string) => string
    consequence: (user: AdminUser) => string
    confirm: string
    destructive: boolean
    /** The server call for a one-click confirm. The ban and role dialogs take their own form instead. */
    action?: (userId: string) => AdminAction
  }
> = {
  ban: {
    title: (name) => `Ban ${name}?`,
    consequence: () => "Signs them out everywhere and blocks sign-in until the ban ends.",
    confirm: "Ban user",
    destructive: true,
  },
  unban: {
    title: (name) => `Unban ${name}?`,
    consequence: () => "They can sign in again. Sessions they had before the ban are not restored.",
    confirm: "Unban",
    destructive: false,
    action: (userId) => ({ kind: "unban", userId }),
  },
  impersonate: {
    title: (name) => `Impersonate ${name}?`,
    consequence: () =>
      "You act as them. OAuth consent, device approval and API keys are blocked while impersonating.",
    confirm: "Impersonate",
    destructive: false,
    action: (userId) => ({ kind: "impersonate", userId }),
  },
  revoke: {
    title: (name) => `Sign ${name} out everywhere?`,
    consequence: () =>
      "Signs them out everywhere. Every open session ends at once, on every device.",
    confirm: "Sign out everywhere",
    destructive: true,
    action: (userId) => ({ kind: "revoke", userId }),
  },
  role: {
    title: (name) => `Change ${name}'s role`,
    consequence: () =>
      "Admins can open this page and impersonate users. Users can't. Changing the role takes effect at their next request.",
    confirm: "Set role",
    destructive: false,
  },
}
