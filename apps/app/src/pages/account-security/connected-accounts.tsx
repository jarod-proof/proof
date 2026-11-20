import { useId, useState } from "react"

import { Button } from "@proof/ui/components/ui/button"

import { accountErrorMessage } from "../../lib/account-api"
import { ConfirmDialog } from "../../components/confirm-dialog"
import { dateLabel } from "../../lib/account-format"

// The sections of the Security page (board Security). Each takes its data and callbacks as props.
// Errors a call throws are shown in the section; the container has already mapped their copy.

import { ROW, ROW_LAST, TEXT, META } from "./shared"
import { FormError } from "../../components/form"

// ---- Connected accounts ---------------------------------------------------------------------------

export interface ConnectedRow {
  accountId: string | null
  provider: string
  label: string
  connectedAt: string | Date | null
}

export interface ConnectedAccountsSectionProps {
  rows: ConnectedRow[]
  /** The person connects a provider they are not signed in with yet. */
  onConnect: (provider: string) => Promise<void>
  onDisconnect: (accountId: string) => Promise<void>
}

export function ConnectedAccountsSection({
  rows,
  onConnect,
  onDisconnect,
}: ConnectedAccountsSectionProps) {
  const headingId = useId()
  const [error, setError] = useState<string | null>(null)
  return (
    <section aria-labelledby={headingId} className="flex flex-col">
      <div className="mb-1.5 flex flex-col">
        <h2 id={headingId} className="text-base font-bold">
          Connected accounts
        </h2>
        <span className="text-[13.5px] text-muted-foreground">
          Sign in with these instead of a password. You can't disconnect your last way to sign in.
        </span>
      </div>
      <FormError message={error} />
      {rows.map((row, index) => (
        <ConnectedRowView
          key={row.provider}
          row={row}
          last={index === rows.length - 1}
          onConnect={async () => {
            setError(null)
            try {
              await onConnect(row.provider)
            } catch (caught) {
              setError(accountErrorMessage(caught))
            }
          }}
          onDisconnect={async () => {
            if (!row.accountId) return
            setError(null)
            try {
              await onDisconnect(row.accountId)
            } catch (caught) {
              setError(accountErrorMessage(caught))
            }
          }}
        />
      ))}
    </section>
  )
}

function ConnectedRowView({
  row,
  last,
  onConnect,
  onDisconnect,
}: {
  row: ConnectedRow
  last: boolean
  onConnect: () => Promise<void>
  onDisconnect: () => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const connected = row.accountId !== null
  const disconnect = async () => {
    setBusy(true)
    try {
      await onDisconnect()
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={last ? ROW_LAST : ROW}>
      <div className={TEXT}>
        <span className="font-semibold">{row.label}</span>
        <span className={META}>
          {connected
            ? `Connected${row.connectedAt ? ` · ${dateLabel(row.connectedAt)}` : ""}`
            : "Not connected"}
        </span>
      </div>
      {connected ? (
        <Button variant="outline" onClick={() => setConfirming(true)}>
          Disconnect
        </Button>
      ) : (
        <Button
          variant="default"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await onConnect()
            } finally {
              setBusy(false)
            }
          }}
        >
          Connect
        </Button>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Disconnect ${row.label}?`}
        description={`You won't be able to sign in with ${row.label} any more. You can connect it again later.`}
        confirmLabel={`Disconnect ${row.label}`}
        destructive
        pending={busy}
        onConfirm={() => void disconnect()}
      />
    </div>
  )
}
