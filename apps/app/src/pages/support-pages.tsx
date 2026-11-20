import type { ReactNode } from "react"

import { Button } from "@proof/ui/components/ui/button"
import type { RenderLink } from "@proof/ui/dplus/shell/link"
import { PageBody, PageHeader } from "@proof/ui/dplus/shell/page-header"
import { type SettingsTab, SettingsHeader } from "@proof/ui/dplus/shell/settings-header"

/**
 * The requester's support page (/account/support, and /account/support/$id where thread mail and
 * the "new reply" notification link): support's widget, inline.
 */
export function SupportTicketPage({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title="Support tickets" />
      <PageBody className="gap-4">{children}</PageBody>
    </div>
  )
}

/** The admin console's Support tab: the console's header and tabs, then the support queue. */
export function SupportAdminPage({
  tabs,
  notice,
  renderLink,
  children,
}: {
  /** The admin console's tabs this person may open (adminTabs). */
  tabs: SettingsTab[]
  /** Shown above the queue, e.g. which ticket a link was for. */
  notice?: ReactNode
  renderLink?: RenderLink
  children: ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SettingsHeader
        title="Admin"
        context="Support queue"
        tabs={tabs}
        activeTab="support"
        renderLink={renderLink}
      />
      {/* A work queue: the full width, and the height that is left, so the queue, the thread and
          the details panel each scroll on their own and the composer stays in view. */}
      <PageBody className="min-h-0 max-w-none flex-1 gap-4 pb-4 md:pb-6">
        {notice}
        {children}
      </PageBody>
    </div>
  )
}

/** The support access check failed for another reason than sign-in or staff: offer a retry. */
export function SupportAdminError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="mx-auto flex w-full max-w-xl flex-col items-start gap-3 px-4 py-16"
    >
      <p>Could not check your support access.</p>
      <Button type="button" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}
