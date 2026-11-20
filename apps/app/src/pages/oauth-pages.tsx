import { FieldIssues } from "../components/form"
import { useForm } from "@tanstack/react-form"
import { useEffect, useState } from "react"
import { z } from "zod"

import { Button } from "@proof/ui/components/ui/button"
import { FieldDescription } from "@proof/ui/components/ui/field"

import { AuthCard, ErrorAlert } from "../components/auth-card"
import { useReauthGuard } from "../components/reauth-dialog"
import { OrganizationSwitcher } from "../components/organization-switcher"
import { describeScope, splitScopes } from "../lib/scopes"
import { messageOf } from "../lib/messages"
import { navigateTo } from "../lib/navigation"
import type { WebAuth, WebOrganization } from "../lib/web-auth"

type Loaded<T> =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "error"; message: string }
  | ({ status: "ready" } & T)

interface ConsentData {
  clientName: string
  organizations: WebOrganization[]
  activeOrganizationId: string | null
}

/** The consent page's first state: the application and the person's organizations, or why not. */
async function loadConsent(
  auth: WebAuth,
  clientId: string | undefined,
): Promise<Loaded<ConsentData>> {
  if (!clientId) return { status: "error", message: "This page needs an authorization request." }
  try {
    const session = await auth.getSession()
    if (!session) return { status: "signed-out" }
    const [clientName, organizations] = await Promise.all([
      auth.getClientName(clientId),
      auth.listOrganizations(),
    ])
    return {
      status: "ready",
      clientName: clientName ?? "An application",
      organizations,
      activeOrganizationId: session.activeOrganizationId,
    }
  } catch (caught) {
    return { status: "error", message: messageOf(caught) }
  }
}

/**
 * Asks the signed-in person to allow an application, in one organization. The organization switcher
 * applies first: the active organization is set (set-active) before the grant is recorded, because
 * the token's `org` claim comes from the session's active organization.
 */
export function ConsentPage({
  auth,
  clientId,
  scope,
}: {
  auth: WebAuth
  clientId: string | undefined
  scope: string | undefined
}) {
  const [loaded, setLoaded] = useState<Loaded<ConsentData>>({ status: "loading" })

  useEffect(() => {
    let live = true
    void loadConsent(auth, clientId).then((next) => {
      if (live) setLoaded(next)
    })
    return () => {
      live = false
    }
  }, [auth, clientId])

  if (loaded.status === "loading") return <AuthCard title="Loading" />
  if (loaded.status === "signed-out") {
    return (
      <AuthCard
        title="Sign in to continue"
        description="You need to be signed in to allow an application."
        footer={
          <a href="/sign-in" className="underline underline-offset-4">
            Go to sign in
          </a>
        }
      >
        <p className="text-sm text-muted-foreground">Sign in, then start the connection again.</p>
      </AuthCard>
    )
  }
  if (loaded.status === "error") {
    return (
      <AuthCard title="This request cannot be shown">
        <ErrorAlert message={loaded.message} />
      </AuthCard>
    )
  }

  const scopes = splitScopes(scope)

  return (
    <AuthCard title={`Allow ${loaded.clientName} to connect?`}>
      <div className="flex flex-col gap-4">
        <section aria-labelledby="consent-scopes-heading" className="flex flex-col gap-2">
          <h2 id="consent-scopes-heading" className="text-sm font-medium">
            It will be able to
          </h2>
          {scopes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No specific permissions were requested.</p>
          ) : (
            <ul className="list-disc pl-5 text-sm">
              {scopes.map((item) => (
                <li key={item}>{describeScope(item)}</li>
              ))}
            </ul>
          )}
        </section>
        <ConsentForm
          auth={auth}
          organizations={loaded.organizations}
          initialId={initialOrganizationId(loaded.organizations, loaded.activeOrganizationId)}
        />
      </div>
    </AuthCard>
  )
}

/** The organization to start on: the active one when the person belongs to it, else the first. */
function initialOrganizationId(organizations: WebOrganization[], activeId: string | null): string {
  if (activeId && organizations.some((org) => org.id === activeId)) return activeId
  return organizations[0]?.id ?? ""
}

const choiceSchema = z.object({
  organizationId: z.string().min(1, "Choose an organization."),
})

/**
 * Allow or deny the grant. Allow sets the picked organization active first; deny does not touch the
 * active organization. Both then answer the server's consent call, which resumes the OAuth flow.
 */
function ConsentForm({
  auth,
  organizations,
  initialId,
}: {
  auth: WebAuth
  organizations: WebOrganization[]
  initialId: string
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The consent call is refused when the session is older than the fresh window: confirm, then retry.
  const guard = useReauthGuard()

  const form = useForm({
    defaultValues: { organizationId: initialId },
    validators: { onSubmit: choiceSchema },
    onSubmit: async ({ value }) => {
      await decide(true, value.organizationId)
    },
  })

  async function decide(accept: boolean, organizationId: string) {
    setPending(true)
    setError(null)
    try {
      // Always, not only on a change: another tab may have switched the active org since load,
      // and consent grants whichever org is active on the server.
      if (accept) await auth.setActiveOrganization(organizationId)
      const url = await guard(() => auth.consent(accept))
      if (url) navigateTo(url)
      else setPending(false)
    } catch (caught) {
      setError(messageOf(caught))
      setPending(false)
    }
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void form.handleSubmit()
      }}
    >
      {organizations.length === 0 ? (
        <ErrorAlert message="You do not belong to an organization, so there is nothing to grant." />
      ) : (
        <form.Field name="organizationId">
          {(field) => (
            <div className="flex flex-col gap-2">
              <OrganizationSwitcher
                organizations={organizations}
                value={field.state.value}
                disabled={pending}
                onChange={(organizationId) => field.handleChange(organizationId)}
              />
              <FieldIssues field={field} />
            </div>
          )}
        </form.Field>
      )}
      <ErrorAlert message={error} />
      <div className="flex gap-2">
        <Button type="submit" className="flex-1" disabled={pending || organizations.length === 0}>
          Allow
        </Button>
        <Button
          type="button"
          variant="outline"
          className="flex-1"
          disabled={pending}
          onClick={() => void decide(false, form.getFieldValue("organizationId"))}
        >
          Deny
        </Button>
      </div>
      <FieldDescription>You can revoke this access later in the agents settings.</FieldDescription>
    </form>
  )
}

interface OrganizationChoice {
  organizations: WebOrganization[]
  activeOrganizationId: string | null
}

/** The organization picker's first state: the person's organizations, or why not. */
async function loadOrganizationChoice(auth: WebAuth): Promise<Loaded<OrganizationChoice>> {
  try {
    const session = await auth.getSession()
    if (!session) return { status: "signed-out" }
    const organizations = await auth.listOrganizations()
    return { status: "ready", organizations, activeOrganizationId: session.activeOrganizationId }
  } catch (caught) {
    return { status: "error", message: messageOf(caught) }
  }
}

/**
 * Shown when the session has no usable active organization. Sets the one picked, then resumes the
 * OAuth flow with `POST /oauth2/continue { postLogin: true }`.
 */
export function SelectOrganizationPage({ auth }: { auth: WebAuth }) {
  const [loaded, setLoaded] = useState<Loaded<OrganizationChoice>>({ status: "loading" })

  useEffect(() => {
    let live = true
    void loadOrganizationChoice(auth).then((next) => {
      if (live) setLoaded(next)
    })
    return () => {
      live = false
    }
  }, [auth])

  if (loaded.status === "loading") return <AuthCard title="Loading" />
  if (loaded.status === "signed-out") {
    return (
      <AuthCard
        title="Sign in first"
        footer={
          <a href="/sign-in" className="underline underline-offset-4">
            Go to sign in
          </a>
        }
      >
        <p className="text-sm text-muted-foreground">Choose an organization after you sign in.</p>
      </AuthCard>
    )
  }
  if (loaded.status === "error") {
    return (
      <AuthCard title="Organizations unavailable">
        <ErrorAlert message={loaded.message} />
      </AuthCard>
    )
  }

  return (
    <AuthCard
      title="Choose an organization"
      description="The application will act in the organization you pick."
    >
      <SelectOrganizationForm
        auth={auth}
        organizations={loaded.organizations}
        initialId={initialOrganizationId(loaded.organizations, loaded.activeOrganizationId)}
      />
    </AuthCard>
  )
}

/** Sets the picked organization active, then resumes the OAuth flow (POST /oauth2/continue). */
function SelectOrganizationForm({
  auth,
  organizations,
  initialId,
}: {
  auth: WebAuth
  organizations: WebOrganization[]
  initialId: string
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const form = useForm({
    defaultValues: { organizationId: initialId },
    validators: { onSubmit: choiceSchema },
    onSubmit: async ({ value }) => {
      setPending(true)
      setError(null)
      try {
        await auth.setActiveOrganization(value.organizationId)
        const url = await auth.continueOAuth()
        if (url) navigateTo(url)
        else {
          setError("The sign-in could not be resumed. Start it again from the application.")
          setPending(false)
        }
      } catch (caught) {
        setError(messageOf(caught))
        setPending(false)
      }
    },
  })

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void form.handleSubmit()
      }}
    >
      {organizations.length === 0 ? (
        <ErrorAlert message="You do not belong to an organization yet." />
      ) : (
        <form.Field name="organizationId">
          {(field) => (
            <div className="flex flex-col gap-2">
              <OrganizationSwitcher
                organizations={organizations}
                value={field.state.value}
                disabled={pending}
                onChange={(organizationId) => field.handleChange(organizationId)}
              />
              <FieldIssues field={field} />
            </div>
          )}
        </form.Field>
      )}
      <ErrorAlert message={error} />
      <Button type="submit" disabled={pending || organizations.length === 0}>
        {pending ? "Please wait" : "Continue"}
      </Button>
    </form>
  )
}
