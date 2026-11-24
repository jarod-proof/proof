import type { ReactNode } from "react"

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="m-0 text-xl font-semibold text-foreground">{title}</h1>
        {subtitle ? (
          <span className="font-mono text-xs text-faint wrap-anywhere">{subtitle}</span>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}
