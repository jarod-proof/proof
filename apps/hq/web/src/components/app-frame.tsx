import type { ReactNode } from "react"

/**
 * The shell: sidebar beside the main panel. Fluid: when the two do not fit on one line (a phone)
 * the sidebar sits above the panel and takes the full width. `content-start` keeps the wrapped
 * lines at their natural height (stretch would share the spare viewport height between them and
 * open a gap above the runner card); from 792px (232 + 560, where they fit on one line) the single
 * line stretches again so the sidebar fills the viewport.
 */
export function AppFrame({ sidebar, children }: { sidebar: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-wrap content-start bg-background text-foreground min-[792px]:content-stretch">
      <div className="flex-[1_0_232px]">{sidebar}</div>
      <main className="min-w-0 flex-[999_1_560px] p-3 sm:p-4">
        <div className="flex flex-col gap-5 rounded-shell border border-border bg-panel p-4 sm:p-[22px_24px]">
          {children}
        </div>
      </main>
    </div>
  )
}
