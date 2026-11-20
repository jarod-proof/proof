import { useForm, useStore } from "@tanstack/react-form"
import { useEffect, useId, useState } from "react"
import { z } from "zod"

import { Button } from "@proof/ui/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@proof/ui/components/ui/field"
import { Input } from "@proof/ui/components/ui/input"
import { SlugField, type SlugStatus } from "@proof/ui/dplus/shell/slug-field"

import { type FieldLike, FieldIssues, invalidOf } from "../components/form"
import { type SlugProblem, slugify, slugProblem } from "../lib/org-slug"

// A reserved address has no hint: the field's status line already says it.
const PROBLEM_TEXT: Record<Exclude<SlugProblem, null | "reserved">, string> = {
  empty: "Enter a URL for the organization.",
  shape: "Use lowercase letters, numbers and hyphens, up to 48 characters.",
}

const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter a name for the organization.")
    .max(80, "Use 80 characters or fewer."),
  slug: z.string().refine((value) => slugProblem(value) === null, {
    message: "Choose a valid organization URL.",
  }),
})

export interface CreateOrganizationPageProps {
  /** Shown before the slug, e.g. "app.example.com/". */
  host: string
  /**
   * Availability of the slug as the container checked it: "checking" while it settles, undefined
   * when there is nothing to check (empty or a bad shape).
   */
  slugAvailable: boolean | "checking" | undefined
  slugCheckFailed: boolean
  /** Told each time the slug changes, so the container can check it. */
  onSlugChange: (slug: string) => void
  /** Creates the organization. Rejects with a message the page shows. */
  onSubmit: (input: { name: string; slug: string }) => Promise<void>
  onCancel: () => void
}

/**
 * Create an organization (the board's "Create an organization"). The slug follows the name until
 * the person edits it. Both client and server refuse reserved slugs; the server is the one that
 * counts.
 */
export function CreateOrganizationPage({
  host,
  slugAvailable,
  slugCheckFailed,
  onSlugChange,
  onSubmit,
  onCancel,
}: CreateOrganizationPageProps) {
  const nameId = useId()
  const [slugTouched, setSlugTouched] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const form = useForm({
    defaultValues: { name: "", slug: "" },
    validators: { onChange: schema },
    onSubmit: async ({ value }) => {
      setSubmitError(null)
      try {
        await onSubmit({ name: value.name.trim(), slug: value.slug })
      } catch (error) {
        setSubmitError(
          error instanceof Error ? error.message : "Could not create the organization.",
        )
      }
    },
  })

  const slugValue = useStore(form.store, (state) => state.values.slug)
  useEffect(() => {
    onSlugChange(slugValue)
  }, [slugValue, onSlugChange])

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Create an organization</h1>
        <p className="text-muted-foreground">
          Organizations hold your agents, members, API keys and billing. You can belong to several.
        </p>
      </header>

      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault()
          event.stopPropagation()
          void form.handleSubmit()
        }}
      >
        <form.Field name="name">
          {(field) => (
            <Field>
              <FieldLabel htmlFor={nameId}>Organization name</FieldLabel>
              <Input
                id={nameId}
                name="name"
                value={field.state.value}
                aria-invalid={invalidOf(field)}
                onChange={(event) => {
                  const name = event.currentTarget.value
                  field.handleChange(name)
                  if (!slugTouched) form.setFieldValue("slug", slugify(name))
                }}
                onBlur={field.handleBlur}
                autoComplete="organization"
              />
              <FieldIssues field={field} />
            </Field>
          )}
        </form.Field>

        <form.Field name="slug">
          {(field) => (
            <SlugBlock
              host={host}
              value={field.state.value}
              availability={slugAvailable}
              checkFailed={slugCheckFailed}
              onChange={(slug) => {
                setSlugTouched(true)
                field.handleChange(slug)
              }}
              field={field}
            />
          )}
        </form.Field>

        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold">Logo (optional)</p>
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex size-12 items-center justify-center rounded-lg border-2 border-foreground bg-muted font-semibold"
            >
              {(form.state.values.name.trim()[0] ?? "A").toUpperCase()}
            </span>
            <Button type="button" variant="outline" disabled aria-describedby="logo-reason">
              Upload
            </Button>
          </div>
          <FieldDescription id="logo-reason">
            Logo upload is not available yet, so the first letter is used. You can add one later.
          </FieldDescription>
        </div>

        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted-foreground">
          <li>You'll be the Owner of the organization.</li>
          <li>You can invite teammates later from its Members page.</li>
          <li>Plans and billing are in the organization's Billing settings.</li>
        </ol>

        {submitError ? (
          <p role="alert" className="text-destructive">
            {submitError}
          </p>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
            {([canSubmit, isSubmitting]) => (
              <Button type="submit" disabled={!canSubmit || isSubmitting}>
                {isSubmitting ? "Creating…" : "Create organization"}
              </Button>
            )}
          </form.Subscribe>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  )
}

/** The slug field with its availability: checked after the value settles, never for a bad shape. */
function SlugBlock({
  host,
  value,
  availability,
  checkFailed,
  onChange,
  field,
}: {
  host: string
  value: string
  availability: boolean | "checking" | undefined
  checkFailed: boolean
  onChange: (slug: string) => void
  field: FieldLike
}) {
  const problem = slugProblem(value)

  let status: SlugStatus = "idle"
  if (value.length > 0) {
    if (problem === "shape") status = "invalid"
    else if (problem === "reserved") status = "reserved"
    else if (availability === "checking") status = "checking"
    else if (availability === true) status = "available"
    else if (availability === false) status = "taken"
  }
  const problemText = problem && problem !== "reserved" ? PROBLEM_TEXT[problem] : null

  return (
    <div className="flex flex-col gap-1.5">
      <SlugField
        label="URL"
        prefix={`${host}/`}
        value={value}
        name="slug"
        status={status}
        onChange={onChange}
      />
      {problemText ? <FieldDescription>{problemText}</FieldDescription> : null}
      {checkFailed ? (
        <p role="alert" className="text-sm text-destructive">
          Could not check this address. Try again in a moment.
        </p>
      ) : null}
      <FieldIssues field={field} hidden={problem !== null} />
    </div>
  )
}
