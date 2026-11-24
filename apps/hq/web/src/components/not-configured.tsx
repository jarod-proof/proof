/**
 * The line beside a control hq cannot honour yet: what is not configured and when it arrives. The
 * control it sits beside is disabled; nothing here is a setting.
 */
export function NotConfigured({
  phase,
  what,
  id,
}: {
  phase: string
  what: string
  /** Lets a disabled control point at this note with aria-describedby. */
  id?: string
}) {
  return (
    <p id={id} role="note" className="m-0 text-xs text-faint">
      Not configured: {what}. Arrives in {phase}.
    </p>
  )
}
