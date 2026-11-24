const TONE_CLASS = {
  default: "text-foreground",
  ok: "text-success",
  attention: "text-solar",
  bad: "text-destructive",
} as const

export function KpiCard({
  label,
  value,
  status,
  note,
  tone = "default",
}: {
  label: string
  value: string
  status?: string
  note?: string
  tone?: keyof typeof TONE_CLASS
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-card border border-border bg-muted p-3.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`font-mono text-xl font-medium ${TONE_CLASS[tone]}`}>{value}</span>
      {status ? <span className="text-xs text-soft">{status}</span> : null}
      {note ? <span className="text-xs text-faint">{note}</span> : null}
    </div>
  )
}
