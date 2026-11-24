import { Button } from "@proof/ui/components/ui/button"

export interface AccountMenuProps {
  /** The signed-in address; null while it loads or when the lookup failed. */
  email: string | null
  onSignOut(): void
  pending: boolean
  error: string | null
}

/** The sidebar's account block: who is signed in and a Sign out. */
export function AccountMenu({ email, onSignOut, pending, error }: AccountMenuProps) {
  return (
    <div className="flex flex-col gap-2 px-1">
      <span className="font-mono text-[11px] break-all text-faint">{email ?? "Signed in"}</span>
      <Button
        type="button"
        variant="outline"
        className="min-h-touch"
        disabled={pending}
        onClick={onSignOut}
      >
        Sign out
      </Button>
      {error ? (
        <p role="alert" className="m-0 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
