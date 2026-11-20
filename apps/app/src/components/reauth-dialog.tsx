import { useQueryClient } from "@tanstack/react-query"
import { type ReactNode, createContext, useCallback, useContext, useRef, useState } from "react"
import { z } from "zod"

import { Button } from "@proof/ui/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@proof/ui/components/ui/dialog"

import { type AccountApi, getAccountApi } from "../lib/account-api"
import { accountKeys } from "../lib/account-keys"
import { messageOf } from "../lib/messages"
import { navigateTo } from "../lib/navigation"
import {
  type ReauthAuth,
  type ReauthConfirm,
  type ReauthSession,
  checkReauthed,
  getReauthAuth,
  retireReplacedSession,
  signInAgainPath,
  withReauth,
} from "../lib/reauth"
import { FormError, useAppForm } from "./form"

// "Confirm it's you": the dialog a refused sensitive action opens (lib/reauth.ts). It offers only the
// ways this person can sign in again: their password (for their own email), their passkeys, or, for
// an account with neither, signing out and back in. A second factor is asked for in place.

/** The person's own sign-in ways, from their account. */
export interface ReauthMethods {
  email: string
  hasPassword: boolean
  hasPasskey: boolean
}

/** The account lists the dialog reads to know which ways to offer. */
export type ReauthMethodSource = Pick<AccountApi, "getProfile" | "listAccounts" | "listPasskeys">

const NO_METHODS: ReauthMethods = { email: "", hasPassword: false, hasPasskey: false }

async function loadMethods(source: ReauthMethodSource): Promise<ReauthMethods> {
  try {
    const [profile, accounts, passkeys] = await Promise.all([
      source.getProfile(),
      source.listAccounts(),
      source.listPasskeys(),
    ])
    return {
      email: profile.email,
      hasPassword: accounts.some((account) => account.providerId === "credential"),
      hasPasskey: passkeys.length > 0,
    }
  } catch {
    // The lists could not load: offer only the way that always works, signing out and back in.
    return NO_METHODS
  }
}

export interface ReauthDialogProps {
  open: boolean
  methods: ReauthMethods
  auth: ReauthAuth
  /** The session was replaced by the same person's: the action can be retried. */
  onConfirmed: () => void
  /** The person closed the dialog without confirming (Cancel, Escape or the close control). */
  onCancel: () => void
  /** The person signed out to sign in again; the provider takes them to sign-in. */
  onSignedOut: () => void
  /** A passkey signed in a different account; the page has to reload. */
  onMismatch: () => void
}

/** The dialog. Its body is mounted only while open, so each opening starts from the methods step. */
export function ReauthDialog(props: ReauthDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={(next) => (next ? undefined : props.onCancel())}>
      <DialogContent>{props.open ? <ReauthBody {...props} /> : null}</DialogContent>
    </Dialog>
  )
}

type Step = "methods" | "code" | "backup"

/** The dialog's content: the methods, or the code step. Exported so its markup can be checked on its own. */
export function ReauthBody({
  methods,
  auth,
  onConfirmed,
  onSignedOut,
  onMismatch,
}: Omit<ReauthDialogProps, "open" | "onCancel">) {
  const [step, setStep] = useState<Step>("methods")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // One sign-in step. Its session is compared before and after: the step is done once a new session
  // for the same person replaces the old one. A second-factor step leaves the old session in place
  // until the code is accepted, so it is not compared yet.
  async function attempt(action: () => Promise<"done" | "two-factor">) {
    setBusy(true)
    setError(null)
    try {
      const before: ReauthSession | null = await auth.session()
      const outcome = await action()
      if (outcome === "two-factor") {
        setStep("code")
        return
      }
      const after = await auth.session()
      const check = checkReauthed(before, after)
      if (check === "other-account") {
        onMismatch()
        return
      }
      if (check !== "ok" || !after) {
        setError("Could not confirm it's you. Try again.")
        return
      }
      // A new session starts in the first organization. Put back the one the person was working in,
      // or the product calls would be refused for acting in another organization.
      const was = before?.activeOrganizationId
      if (was && after.activeOrganizationId !== was) await auth.setActiveOrganization(was)
      // The old session is still a valid row: retire it, so the list doesn't keep a duplicate.
      if (before) await retireReplacedSession(auth, before)
      onConfirmed()
    } catch (caught) {
      setError(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }

  async function signOutAgain() {
    setBusy(true)
    setError(null)
    try {
      await auth.signOut()
      onSignedOut()
    } catch (caught) {
      setError(messageOf(caught))
      setBusy(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Confirm it's you</DialogTitle>
        <DialogDescription>For your security, confirm it's you to continue.</DialogDescription>
      </DialogHeader>
      {step === "methods" ? (
        <div className="flex flex-col gap-4">
          {methods.hasPassword ? (
            <PasswordForm
              key="password"
              busy={busy}
              onSubmit={(password) =>
                attempt(() => auth.signInWithPassword(methods.email, password))
              }
            />
          ) : null}
          {methods.hasPassword && methods.hasPasskey ? (
            <p className="text-center text-sm text-muted-foreground">or</p>
          ) : null}
          {methods.hasPasskey ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void attempt(async () => {
                  await auth.signInWithPasskey()
                  return "done"
                })
              }
            >
              Use your passkey
            </Button>
          ) : null}
          {!methods.hasPassword && !methods.hasPasskey ? (
            <p className="text-sm text-muted-foreground">
              This account signs in another way, so there is no password or passkey to confirm with.
              Sign out and sign in again instead.
            </p>
          ) : null}
        </div>
      ) : (
        <CodeForm
          key={step}
          backup={step === "backup"}
          busy={busy}
          onSubmit={(code) =>
            attempt(async () => {
              if (step === "backup") await auth.verifyBackupCode(code)
              else await auth.verifyCode(code)
              return "done"
            })
          }
          onToggle={() => setStep(step === "backup" ? "code" : "backup")}
        />
      )}
      <FormError message={error} />
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          className="sm:mr-auto"
          disabled={busy}
          onClick={() => void signOutAgain()}
        >
          Sign out and sign in again
        </Button>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
      </DialogFooter>
    </>
  )
}

function PasswordForm({
  busy,
  onSubmit,
}: {
  busy: boolean
  onSubmit: (password: string) => Promise<void>
}) {
  const form = useAppForm({
    defaultValues: { password: "" },
    validators: {
      onSubmit: z.object({ password: z.string().min(1, "Enter your password.") }),
    },
    onSubmit: async ({ value }) => {
      await onSubmit(value.password)
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
      <form.AppField name="password">
        {(field) => (
          <field.PasswordField
            label="Password"
            autoComplete="current-password"
            required
            disabled={busy}
          />
        )}
      </form.AppField>
      <div>
        <Button type="submit" disabled={busy}>
          Confirm
        </Button>
      </div>
    </form>
  )
}

function CodeForm({
  backup,
  busy,
  onSubmit,
  onToggle,
}: {
  backup: boolean
  busy: boolean
  onSubmit: (code: string) => Promise<void>
  onToggle: () => void
}) {
  const form = useAppForm({
    defaultValues: { code: "" },
    validators: {
      onSubmit: z.object({
        code: z
          .string()
          .trim()
          .min(1, backup ? "Enter a backup code." : "Enter the code from your app."),
      }),
    },
    onSubmit: async ({ value }) => {
      await onSubmit(value.code.trim())
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
      <p className="text-sm text-muted-foreground">
        {backup
          ? "Enter one of your backup codes. It works once."
          : "Enter the six-digit code from your authenticator app."}
      </p>
      <form.AppField name="code">
        {(field) => (
          <field.TextField
            label={backup ? "Backup code" : "Authenticator code"}
            autoComplete="one-time-code"
            inputMode={backup ? "text" : "numeric"}
            required
            disabled={busy}
          />
        )}
      </form.AppField>
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={busy}>
          Confirm
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onToggle}>
          {backup ? "Use your authenticator app" : "Use a backup code"}
        </Button>
      </div>
    </form>
  )
}

interface OpenRequest {
  methods: ReauthMethods
  /** Where to return after "Sign out and sign in again": the page the person was on. */
  returnTo: string
  answer: (ok: boolean) => void
}

const ReauthContext = createContext<ReauthConfirm>(() => Promise.resolve(false))

/**
 * The confirm function for `withReauth`. Without a provider above it, nothing can be confirmed, so
 * the original refusal reaches the caller and its own copy is shown.
 */
export function useReauth(): ReauthConfirm {
  return useContext(ReauthContext)
}

/**
 * `withReauth` bound to the provider's confirm: `guard(() => call)` runs the call, and if it is
 * refused as not fresh, asks the person to confirm it's them and runs it once more.
 */
export function useReauthGuard(): <T>(action: () => Promise<T>) => Promise<T> {
  const confirm = useReauth()
  return useCallback(<T,>(action: () => Promise<T>) => withReauth(action, confirm), [confirm])
}

export interface ReauthProviderProps {
  children: ReactNode
  /** The sign-in calls. Defaults to the page's reauth client. */
  auth?: ReauthAuth
  /** The account lists. Defaults to the page's account API. */
  api?: ReauthMethodSource
  /** Reloads the page after a passkey signed in another account. Defaults to a reload. */
  reload?: () => void
}

/**
 * Mount once, inside the query client, around the app. It owns the one "Confirm it's you" dialog:
 * concurrent confirms share one dialog, and a confirmed re-sign-in invalidates the account data
 * (the new session is the current one now).
 */
export function ReauthProvider({ children, auth, api, reload }: ReauthProviderProps) {
  const queryClient = useQueryClient()
  const [request, setRequest] = useState<OpenRequest | null>(null)
  const inFlight = useRef<Promise<boolean> | null>(null)
  const source = api ?? getAccountApi()
  const reauth = auth ?? getReauthAuth()

  const confirm = useCallback<ReauthConfirm>(() => {
    const pending =
      inFlight.current ??
      loadMethods(source).then(
        (methods) =>
          new Promise<boolean>((resolve) => {
            setRequest({
              methods,
              returnTo: `${window.location.pathname}${window.location.search}`,
              answer: (ok) => {
                inFlight.current = null
                setRequest(null)
                resolve(ok)
              },
            })
          }),
      )
    inFlight.current = pending
    return pending
  }, [source])

  return (
    <ReauthContext.Provider value={confirm}>
      {children}
      <ReauthDialog
        open={request !== null}
        methods={request?.methods ?? NO_METHODS}
        auth={reauth}
        onCancel={() => request?.answer(false)}
        onConfirmed={() => {
          void queryClient.invalidateQueries({ queryKey: accountKeys.all() })
          request?.answer(true)
        }}
        onSignedOut={() => {
          if (!request) return
          request.answer(false)
          navigateTo(signInAgainPath(request.returnTo))
        }}
        onMismatch={() => {
          request?.answer(false)
          if (reload) reload()
          else window.location.reload()
        }}
      />
    </ReauthContext.Provider>
  )
}
