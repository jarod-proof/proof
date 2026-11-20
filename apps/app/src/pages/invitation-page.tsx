import { useEffect, useState } from "react"

import { OrgMark } from "@proof/ui/dplus/org-mark"
import { Button } from "@proof/ui/components/ui/button"

import { AuthCard, ErrorAlert } from "../components/auth-card"
import { NotYou } from "../components/not-you"
import { SignInOrUp } from "../components/sign-in-or-up"
import type { InvitationPreview } from "../lib/invitation-preview"
import { messageOf } from "../lib/messages"
import { type Permission, roleLabelOf } from "../lib/members"
import { getOrgSettingsApi } from "../lib/org-settings-api"
import { type WebAuth, type WebInvitation, WebError } from "../lib/web-auth"

type State =
  | { status: "loading" }
  | { status: "signed-out"; preview: InvitationPreview | null }
  | { status: "wrong-account"; preview: InvitationPreview; signedInAs: string }
  | { status: "error"; message: string }
  | { status: "ready"; invitation: WebInvitation; signedInAs: string }
  | { status: "accepted"; organizationName: string }
  | { status: "declined"; organizationName: string }

/** What a role can do, as the catalog answers it (roleAllows = the plugin's own check). */
const CAPABILITIES: { can: string; cannot: string; permission: Permission }[] = [
  {
    can: "See agents, runs and settings",
    cannot: "Can't see agents, runs or settings",
    permission: { agent: ["read"] },
  },
  {
    can: "Start runs and steer them",
    cannot: "Can't start runs or steer them",
    permission: { run: ["create"] },
  },
  { can: "Approve actions", cannot: "Can't approve actions", permission: { run: ["approve"] } },
  {
    can: "Change settings",
    cannot: "Can't change settings",
    permission: { organization: ["update"] },
  },
]

/** Whole days until the invitation stops working, as the copy says it. */
function expiryLine(expiresAt: string | undefined, now: number): string | null {
  if (!expiresAt) return null
  const days = Math.ceil((Date.parse(expiresAt) - now) / 86_400_000)
  if (Number.isNaN(days)) return null
  if (days <= 0) return "This invitation has expired."
  if (days === 1) return "This invitation expires in 1 day."
  return `This invitation expires in ${days} days.`
}

/** Reads the invitation from the link alone, with no session. */
type LoadPreview = (invitationId: string) => Promise<InvitationPreview>

/** Whether the invitation was sent to this address (addresses compare without case). */
const sentTo = (invited: string | null, address: string) =>
  invited === null || invited.toLowerCase() === address.toLowerCase()

/**
 * The page's first state: the invitation for a signed-in person, or why there isn't one. The
 * preview needs no session, so it names the organization and the invited address before sign-in and
 * catches a wrong account before the person tries to accept.
 */
async function loadInvitation(
  auth: WebAuth,
  invitationId: string,
  loadPreview: LoadPreview | undefined,
): Promise<State> {
  try {
    let preview: InvitationPreview | null = null
    if (loadPreview) {
      try {
        preview = await loadPreview(invitationId)
      } catch (caught) {
        // No such invitation is final; any other failure leaves the plain page.
        if (caught instanceof WebError && caught.status === 404) throw caught
      }
    }
    const session = await auth.getSession()
    if (!session) return { status: "signed-out", preview }
    if (preview && !sentTo(preview.email, session.user.email)) {
      return { status: "wrong-account", preview, signedInAs: session.user.email }
    }
    const invitation = await auth.getInvitation(invitationId)
    return { status: "ready", invitation, signedInAs: session.user.email }
  } catch (caught) {
    return { status: "error", message: messageOf(caught) }
  }
}

/** Why a preview that is no longer open can't be accepted, as the page says it. */
function closedLine(preview: InvitationPreview): string {
  switch (preview.status) {
    case "expired":
      return "This invitation has expired."
    case "accepted":
      return "This invitation has already been accepted."
    case "rejected":
      return "This invitation was declined."
    default:
      return "This invitation was canceled."
  }
}

/**
 * The link in an invitation email. Accepting needs a signed-in person with the invited address, so
 * the page shows who invited them to what (the preview), opens on sign-up or sign-in with that
 * address filled in, then shows the invitation to accept.
 */
export function InvitationPage({
  auth,
  invitationId,
  loadPreview,
}: {
  auth: WebAuth
  invitationId: string
  /** Reads the invitation without a session; without it the signed-out card stays generic. */
  loadPreview?: LoadPreview
}) {
  const [state, setState] = useState<State>({ status: "loading" })
  const [reloads, setReloads] = useState(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void loadInvitation(auth, invitationId, loadPreview).then((next) => {
      if (live) setState(next)
    })
    return () => {
      live = false
    }
  }, [auth, invitationId, loadPreview, reloads])

  async function accept(invitation: WebInvitation) {
    setPending(true)
    setError(null)
    try {
      await auth.acceptInvitation(invitation.id)
      setState({ status: "accepted", organizationName: invitation.organizationName })
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setPending(false)
    }
  }

  async function decline(invitation: WebInvitation) {
    setPending(true)
    setError(null)
    try {
      await auth.rejectInvitation?.(invitation.id)
      setState({ status: "declined", organizationName: invitation.organizationName })
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setPending(false)
    }
  }

  if (state.status === "loading") return <AuthCard title="Loading" />

  if (state.status === "signed-out") {
    const { preview } = state
    if (preview && preview.status !== "pending") {
      return (
        <AuthCard
          title={preview.organizationName}
          description={
            preview.status === "accepted"
              ? closedLine(preview)
              : `${closedLine(preview)} Ask ${preview.inviterName ?? "the person who invited you"} to send a new one.`
          }
          footer={
            preview.status === "accepted" ? (
              <a href="/sign-in" className="underline underline-offset-4">
                Sign in
              </a>
            ) : undefined
          }
        />
      )
    }
    return (
      <AuthCard
        title={preview ? `Join ${preview.organizationName}` : "Accept your invitation"}
        description={
          preview
            ? `${preview.inviterName ?? "Someone"} invited you as ${roleLabelOf(preview.role)}. Create your account to accept, or sign in if you already have one.`
            : "Sign in or create an account with the email address the invitation was sent to."
        }
      >
        <SignInOrUp
          auth={auth}
          email={preview?.email ?? undefined}
          initialMode={preview?.email ? "sign-up" : "sign-in"}
          hint={
            preview?.email
              ? `This invitation was sent to ${preview.email}, so that address is used. You will then be asked to accept.`
              : "You will then be asked to accept the invitation."
          }
          onSignedIn={() => setReloads((n) => n + 1)}
        />
      </AuthCard>
    )
  }

  if (state.status === "wrong-account") {
    const { preview, signedInAs } = state
    return (
      <AuthCard
        title={preview.organizationName}
        description={`${preview.inviterName ?? "Someone"} invited you to join as ${roleLabelOf(preview.role)}.`}
      >
        <p role="alert" className="rounded-[10px] border border-border p-3.5 text-sm">
          This invitation was sent to {preview.email}, but you are signed in as {signedInAs}. Sign
          in with {preview.email} to accept it.
        </p>
        <Button
          type="button"
          size="lg"
          className="h-12"
          onClick={() => {
            void auth.signOut().then(() => setReloads((n) => n + 1))
          }}
        >
          Sign out and use {preview.email}
        </Button>
      </AuthCard>
    )
  }

  if (state.status === "error") {
    return (
      <AuthCard
        title="Invitation unavailable"
        footer={<NotYou auth={auth} onSignedOut={() => setReloads((n) => n + 1)} />}
      >
        <ErrorAlert message={state.message} />
      </AuthCard>
    )
  }

  if (state.status === "accepted") {
    return (
      <AuthCard
        title="You have joined"
        description={`You are now a member of ${state.organizationName}.`}
        footer={
          <a href="/settings/agents" className="underline underline-offset-4">
            Go to your settings
          </a>
        }
      />
    )
  }

  if (state.status === "declined") {
    return (
      <AuthCard
        title="Invitation declined"
        description={`You did not join ${state.organizationName}. The person who invited you can see that.`}
      />
    )
  }

  const { invitation, signedInAs } = state
  const expiry = expiryLine(invitation.expiresAt, Date.now())
  const expired =
    invitation.expiresAt !== undefined && Date.parse(invitation.expiresAt) <= Date.now()
  const notPending = invitation.status !== "pending" || expired
  const api = getOrgSettingsApi()

  return (
    <AuthCard
      title={invitation.organizationName}
      description={
        invitation.inviterEmail
          ? `${invitation.inviterEmail} invited you to join this organization.`
          : "You have been invited to join this organization."
      }
    >
      <div className="flex items-center gap-3">
        <OrgMark name={invitation.organizationName} look="outline" size="lg" />
        <div className="flex flex-col">
          <span className="text-sm text-muted-foreground">Your role</span>
          <span className="w-fit rounded-full border-[1.5px] border-foreground px-2.5 text-[13px] font-bold">
            {roleLabelOf(invitation.role)}
          </span>
        </div>
      </div>
      <ul className="flex flex-col gap-1 rounded-[10px] border border-border p-3.5 text-sm">
        {CAPABILITIES.map((item) => {
          const allowed = api.roleAllows(invitation.role, item.permission)
          return (
            <li key={item.can} className={`flex gap-2 ${allowed ? "" : "text-muted-foreground"}`}>
              <span aria-hidden="true" className="mt-0.5">
                {allowed ? "✓" : "–"}
              </span>
              {allowed ? item.can : item.cannot}
            </li>
          )
        })}
      </ul>
      {notPending ? (
        <p className="text-sm text-destructive">
          {expired && invitation.status === "pending"
            ? "This invitation has expired."
            : `This invitation is ${invitation.status}.`}
        </p>
      ) : null}
      <ErrorAlert message={error} />
      <div className="flex gap-2">
        <Button
          type="button"
          size="lg"
          className="h-12 flex-1"
          disabled={pending || notPending}
          onClick={() => void accept(invitation)}
        >
          {pending ? "Please wait" : "Accept"}
        </Button>
        {auth.rejectInvitation ? (
          <Button
            type="button"
            size="lg"
            variant="outline"
            className="h-12 flex-1"
            disabled={pending || notPending}
            onClick={() => void decline(invitation)}
          >
            Decline
          </Button>
        ) : null}
      </div>
      <p className="text-sm">
        Signed in as {signedInAs} ·{" "}
        <button
          type="button"
          className="text-foreground underline underline-offset-4"
          disabled={pending}
          onClick={() => {
            void auth.signOut().then(() => setReloads((n) => n + 1))
          }}
        >
          Switch account
        </button>
      </p>
      {expiry ? (
        <p className="text-[13px] text-muted-foreground">
          {expiry} Declining tells the person who invited you; nothing else is shared.
        </p>
      ) : null}
    </AuthCard>
  )
}
