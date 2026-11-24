import type { ReactNode } from "react"

export function Section({
  id,
  title,
  count,
  tone = "default",
  description,
  children,
}: {
  id: string
  title: string
  count?: number
  tone?: "default" | "attention"
  description?: string
  children: ReactNode
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2
          id={id}
          className={`m-0 flex items-center gap-2 text-base font-semibold ${
            tone === "attention" ? "text-solar" : "text-foreground"
          }`}
        >
          {title}
          {count === undefined ? null : (
            <span className="font-mono text-xs font-normal text-faint">{count}</span>
          )}
        </h2>
        {description ? <p className="m-0 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  )
}
