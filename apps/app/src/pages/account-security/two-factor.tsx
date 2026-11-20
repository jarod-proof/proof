import {} from "@tanstack/react-form"
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
import {} from "@proof/ui/components/ui/input"
import { QrCode } from "@proof/ui/dplus/qr-code"
import { CopyField } from "@proof/ui/dplus/shell/copy-field"

import { type TotpSetup, totpSecretOf } from "../../lib/account-api"
import { dateLabel } from "../../lib/account-format"

// The sections of the Security page (board Security). Each takes its data and callbacks as props.
// Errors a call throws are shown in the section; the container has already mapped their copy.

import { ROW, ROW_LAST, TEXT, META, useAction } from "./shared"
import { FormDialog, FormError, useAppForm } from "../../components/form"
import { BACKUP_CODE_COUNT, BackupCodesView } from "./backup-codes"

const passwordSchema = z.object({ password: z.string().min(1, "Enter your password.") })
const codeSchema = z.object({
  code: z.string().trim().min(1, "Enter the six-digit code from your app."),
})

export interface TwoFactorSectionProps {
  enabled: boolean
  enabledAt: string | Date | null
  backupCodesRemaining: number | null
  /** False for an account without a password: enabling and the codes both ask for one. */
  hasPassword: boolean
  onEnable: (password: string) => Promise<TotpSetup>
  onConfirm: (code: string) => Promise<void>
  onDisable: (password: string) => Promise<void>
  onNewCodes: (password: string) => Promise<string[]>
}

export function TwoFactorSection(props: TwoFactorSectionProps) {
  const headingId = useId()
  const [enrolling, setEnrolling] = useState(false)
  const [turningOff, setTurningOff] = useState(false)
  const [newCodes, setNewCodes] = useState(false)
  const noPassword = !props.hasPassword
  const reason = noPassword
    ? "This account has no password. Two-factor asks for one to confirm it's you."
    : undefined

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="text-base font-bold">
        Two-factor authentication
      </h2>
      <div className={ROW}>
        <div className={TEXT}>
          <span className="font-semibold">Authenticator app</span>
          <span className={META}>
            {props.enabled
              ? `On since ${dateLabel(props.enabledAt) || "a while ago"} · asked when you sign in with a password`
              : "Off · add a second step at sign-in with an authenticator app"}
          </span>
          {reason && !props.enabled ? <span className={META}>{reason}</span> : null}
        </div>
        {props.enabled ? (
          <Button variant="outline" onClick={() => setTurningOff(true)}>
            Turn off
          </Button>
        ) : (
          <Button variant="default" disabled={noPassword} onClick={() => setEnrolling(true)}>
            Turn on
          </Button>
        )}
      </div>
      <div className={ROW_LAST}>
        <div className={TEXT}>
          <span className="font-semibold">Backup codes</span>
          <span className={META}>
            {props.enabled && props.backupCodesRemaining !== null
              ? `${props.backupCodesRemaining} of ${BACKUP_CODE_COUNT} left · each works once`
              : "Available once two-factor is on"}
          </span>
        </div>
        <Button variant="outline" disabled aria-describedby={`${headingId}-codes`}>
          View codes
        </Button>
        <Button
          variant="outline"
          disabled={!props.enabled || noPassword}
          onClick={() => setNewCodes(true)}
        >
          Make new codes
        </Button>
      </div>
      <p id={`${headingId}-codes`} className={META}>
        Codes are shown once, when they are made. To replace them, make new codes.
      </p>

      {enrolling ? (
        <EnrolDialog
          onClose={() => setEnrolling(false)}
          onEnable={props.onEnable}
          onConfirm={props.onConfirm}
        />
      ) : null}
      <TurnOffDialog open={turningOff} onOpenChange={setTurningOff} onDisable={props.onDisable} />
      <NewCodesDialog open={newCodes} onOpenChange={setNewCodes} onNewCodes={props.onNewCodes} />
    </section>
  )
}

type EnrolStep = "password" | "scan" | "codes"

function EnrolDialog({
  onClose,
  onEnable,
  onConfirm,
}: {
  onClose: () => void
  onEnable: (password: string) => Promise<TotpSetup>
  onConfirm: (code: string) => Promise<void>
}) {
  const [step, setStep] = useState<EnrolStep>("password")
  // The secret and codes live in this dialog only: not in a query, gone when it closes.
  const [setup, setSetup] = useState<TotpSetup | null>(null)
  const [secret, setSecret] = useState("")
  const password = useAction(async (value: string) => {
    const result = await onEnable(value)
    setSetup(result)
    setSecret(totpSecretOf(result.totpURI))
    setStep("scan")
  })
  const confirm = useAction(async (code: string) => {
    await onConfirm(code)
    setStep("codes")
  })
  const passwordForm = useAppForm({
    defaultValues: { password: "" },
    validators: { onSubmit: passwordSchema },
    onSubmit: async ({ value }) => {
      await password.call(value.password)
    },
  })
  const codeForm = useAppForm({
    defaultValues: { code: "" },
    validators: { onSubmit: codeSchema },
    onSubmit: async ({ value }) => {
      await confirm.call(value.code.trim())
    },
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {step === "password" ? (
          <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void passwordForm.handleSubmit()
            }}
          >
            <DialogHeader>
              <DialogTitle>Turn on two-factor</DialogTitle>
              <DialogDescription>Confirm your password to start.</DialogDescription>
            </DialogHeader>
            <passwordForm.AppField name="password">
              {(field) => (
                <field.PasswordField label="Password" autoComplete="current-password" required />
              )}
            </passwordForm.AppField>
            <FormError message={password.error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={password.busy}>
                {password.busy ? "Checking…" : "Continue"}
              </Button>
            </DialogFooter>
          </form>
        ) : null}

        {step === "scan" && setup ? (
          <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void codeForm.handleSubmit()
            }}
          >
            <DialogHeader>
              <DialogTitle>Add to your authenticator app</DialogTitle>
              <DialogDescription>
                Scan the code with your app. Can't scan? Enter the setup key, or open the setup link
                on this device.
              </DialogDescription>
            </DialogHeader>
            <QrCode
              value={setup.totpURI}
              label="QR code for the setup link"
              className="self-center"
            />
            <CopyField label="Setup key" value={secret} />
            <CopyField label="Setup link" value={setup.totpURI} />
            <codeForm.AppField name="code">
              {(field) => (
                <field.TextField
                  label="Six-digit code from the app"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  required
                  description="Enter the code the app shows now."
                />
              )}
            </codeForm.AppField>
            <FormError message={confirm.error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={confirm.busy}>
                {confirm.busy ? "Checking…" : "Turn on"}
              </Button>
            </DialogFooter>
          </form>
        ) : null}

        {step === "codes" && setup ? (
          <BackupCodesView
            title="Save your backup codes"
            description="Each code works once if you lose your device. We won't show these again."
            codes={setup.backupCodes}
            onDone={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function TurnOffDialog({
  open,
  onOpenChange,
  onDisable,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onDisable: (password: string) => Promise<void>
}) {
  const action = useAction(async (value: string) => {
    await onDisable(value)
  })
  const form = useAppForm({
    defaultValues: { password: "" },
    validators: { onSubmit: passwordSchema },
    onSubmit: async ({ value }) => {
      if (await action.call(value.password)) onOpenChange(false)
    },
  })
  // Once closed (after the exit animation), the dialog forgets what was typed and any error.
  const forget = () => {
    action.setError(null)
    form.reset()
  }
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(next) => {
        if (!next) forget()
      }}
      title="Turn off two-factor?"
      alert
      description="Signing in with a password will need only the password. Your backup codes stop working."
      onSubmit={() => void form.handleSubmit()}
      submitLabel="Turn off two-factor"
      pendingLabel="Turning off…"
      destructive
      pending={action.busy}
      error={action.error}
    >
      <form.AppField name="password">
        {(field) => (
          <field.PasswordField label="Password" autoComplete="current-password" required />
        )}
      </form.AppField>
    </FormDialog>
  )
}

function NewCodesDialog({
  open,
  onOpenChange,
  onNewCodes,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onNewCodes: (password: string) => Promise<string[]>
}) {
  const [codes, setCodes] = useState<string[] | null>(null)
  const action = useAction(async (value: string) => {
    setCodes(await onNewCodes(value))
  })
  const form = useAppForm({
    defaultValues: { password: "" },
    validators: { onSubmit: passwordSchema },
    onSubmit: async ({ value }) => {
      await action.call(value.password)
    },
  })
  // Once closed (after the exit animation), the codes and what was typed are forgotten: reopening
  // asks for the password again.
  const forget = () => {
    setCodes(null)
    action.setError(null)
    form.reset()
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(next) => {
        if (!next) forget()
      }}
    >
      <DialogContent>
        {codes ? (
          <BackupCodesView
            title="Your new backup codes"
            description="The old codes no longer work. Save these now; we won't show them again."
            codes={codes}
            onDone={() => onOpenChange(false)}
          />
        ) : (
          <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              event.stopPropagation()
              void form.handleSubmit()
            }}
          >
            <DialogHeader>
              <DialogTitle>Make new backup codes</DialogTitle>
              <DialogDescription>
                Confirm your password. The old codes stop working.
              </DialogDescription>
            </DialogHeader>
            <form.AppField name="password">
              {(field) => (
                <field.PasswordField label="Password" autoComplete="current-password" required />
              )}
            </form.AppField>
            <FormError message={action.error} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={action.busy}>
                {action.busy ? "Making codes…" : "Make new codes"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
