import type { ReactNode } from "react"

import { type RenderLink, anchorLink } from "@proof/ui/dplus/shell/link"
import { PageBody } from "@proof/ui/dplus/shell/page-header"
import { SettingsHeader } from "@proof/ui/dplus/shell/settings-header"

import type { PasskeyInfo, TotpSetup } from "../lib/account-api"
import {
  type ConnectedRow,
  ConnectedAccountsSection,
  PasskeysSection,
  PasswordSection,
  SessionsSection,
  type SessionRow,
  TwoFactorSection,
} from "./account-security"

export interface AccountSecurityPageProps {
  name: string
  email: string
  summary: {
    hasPassword: boolean
    passwordChangedAt: string | Date | null
    twoFactorEnabled: boolean
    twoFactorEnabledAt: string | Date | null
    backupCodesRemaining: number | null
  }
  /** The sign-in this browser made, as one line of copy ("Passkey · 2 days ago · Chrome on macOS"). */
  lastSignIn: string
  passkeys: PasskeyInfo[]
  connected: ConnectedRow[]
  sessions: SessionRow[]
  sessionsNeedSignIn: boolean
  /** Confirms it's the person (a re-sign-in), then reloads the sessions list. */
  onSignInAgain: () => Promise<void>
  onAddPasskey: (name: string) => Promise<void>
  onRenamePasskey: (id: string, name: string) => Promise<void>
  onRemovePasskey: (id: string) => Promise<void>
  onEnableTwoFactor: (password: string) => Promise<TotpSetup>
  onConfirmTwoFactor: (code: string) => Promise<void>
  onDisableTwoFactor: (password: string) => Promise<void>
  onNewBackupCodes: (password: string) => Promise<string[]>
  onChangePassword: (input: { currentPassword: string; newPassword: string }) => Promise<void>
  onConnect: (provider: string) => Promise<void>
  onDisconnect: (accountId: string) => Promise<void>
  onRevokeSession: (token: string) => Promise<void>
  onRevokeOtherSessions: () => Promise<void>
  renderLink?: RenderLink
}

/** The personal security page (board Security): what sign-in uses, and what protects it. */
export function AccountSecurityPage({
  name,
  email,
  summary,
  lastSignIn,
  passkeys,
  connected,
  sessions,
  sessionsNeedSignIn,
  renderLink = anchorLink,
  ...actions
}: AccountSecurityPageProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SettingsHeader
        title="Personal settings"
        context={`${name} · ${email}`}
        tabs={[
          { id: "profile", label: "Profile & account", href: "/account/profile" },
          { id: "security", label: "Security", href: "/account/security" },
        ]}
        activeTab="security"
        renderLink={renderLink}
      />

      <PageBody className="gap-6">
        <SummaryRow
          lastSignIn={lastSignIn}
          passkeyCount={passkeys.length}
          twoFactorEnabled={summary.twoFactorEnabled}
          checkedPassword={summary.hasPassword && summary.passwordChangedAt !== null}
        />
        <PasskeysSection
          passkeys={passkeys}
          onAdd={actions.onAddPasskey}
          onRename={actions.onRenamePasskey}
          onRemove={actions.onRemovePasskey}
        />
        <TwoFactorSection
          enabled={summary.twoFactorEnabled}
          enabledAt={summary.twoFactorEnabledAt}
          backupCodesRemaining={summary.backupCodesRemaining}
          hasPassword={summary.hasPassword}
          onEnable={actions.onEnableTwoFactor}
          onConfirm={actions.onConfirmTwoFactor}
          onDisable={actions.onDisableTwoFactor}
          onNewCodes={actions.onNewBackupCodes}
        />
        <PasswordSection
          hasPassword={summary.hasPassword}
          changedAt={summary.passwordChangedAt}
          onChange={actions.onChangePassword}
        />
        <ConnectedAccountsSection
          rows={connected}
          onConnect={actions.onConnect}
          onDisconnect={actions.onDisconnect}
        />
        <SessionsSection
          sessions={sessions}
          needsSignIn={sessionsNeedSignIn}
          onSignInAgain={actions.onSignInAgain}
          onRevoke={actions.onRevokeSession}
          onRevokeOthers={actions.onRevokeOtherSessions}
        />
      </PageBody>
    </div>
  )
}

function SummaryRow({
  lastSignIn,
  passkeyCount,
  twoFactorEnabled,
  checkedPassword,
}: {
  lastSignIn: string
  passkeyCount: number
  twoFactorEnabled: boolean
  checkedPassword: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-xl border-2 border-foreground p-4">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] text-muted-foreground">Last sign-in</span>
        <strong className="truncate">{lastSignIn}</strong>
      </div>
      <ul className="flex flex-wrap gap-3.5 text-sm">
        <SummaryItem>{passkeyCount === 1 ? "1 passkey" : `${passkeyCount} passkeys`}</SummaryItem>
        <SummaryItem on={twoFactorEnabled}>
          {twoFactorEnabled ? "Two-factor on" : "Two-factor off"}
        </SummaryItem>
        {checkedPassword ? <SummaryItem on>Password checked when set</SummaryItem> : null}
      </ul>
    </div>
  )
}

function SummaryItem({ on = true, children }: { on?: boolean; children: ReactNode }) {
  return (
    <li className={`flex items-center gap-1.5 ${on ? "text-success" : "text-muted-foreground"}`}>
      {on ? (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M3.5 8.5l3 3 6-7"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
      <span className="text-foreground">{children}</span>
    </li>
  )
}
