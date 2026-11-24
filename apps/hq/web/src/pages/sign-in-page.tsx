import { Button } from "@proof/ui/components/ui/button"
import { Input } from "@proof/ui/components/ui/input"
import { Label } from "@proof/ui/components/ui/label"
import type { FormEvent } from "react"

export interface SignInPageProps {
  onSubmit(input: { email: string; password: string }): void
  pending: boolean
  error: string | null
}

const field = (data: FormData, name: string): string => {
  const value = data.get(name)
  return typeof value === "string" ? value : ""
}

/** The sign-in form. Presentational: the container sends the request and words the error. */
export function SignInPage({ onSubmit, pending, error }: SignInPageProps) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    onSubmit({ email: field(data, "email"), password: field(data, "password") })
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <form
        method="post"
        onSubmit={submit}
        className="flex w-full max-w-sm flex-col gap-4 rounded-shell border border-border bg-panel p-6"
      >
        <div className="flex flex-col gap-1">
          <span className="font-mono text-xs tracking-wide text-faint">software factory</span>
          <h1 className="m-0 text-xl font-semibold text-foreground">Sign in</h1>
          <p className="m-0 text-sm text-muted-foreground">
            hq is for the organization's founders.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sign-in-email">Email</Label>
          <Input
            id="sign-in-email"
            name="email"
            type="email"
            autoComplete="username"
            required
            disabled={pending}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sign-in-password">Password</Label>
          <Input
            id="sign-in-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            disabled={pending}
          />
        </div>
        {error ? (
          <p role="alert" className="m-0 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" className="min-h-touch" disabled={pending}>
          {pending ? "Signing in" : "Sign in"}
        </Button>
      </form>
    </main>
  )
}
