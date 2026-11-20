import { useId } from "react"

import { Field, FieldDescription, FieldLabel } from "@proof/ui/components/ui/field"
import { NativeSelect, NativeSelectOption } from "@proof/ui/components/ui/native-select"

import type { WebOrganization } from "../lib/web-auth"

/**
 * Picks the organization a token or device grant will act in. The choice only takes effect once the
 * page calls set-active, so the caller decides when to apply it.
 */
export function OrganizationSwitcher({
  organizations,
  value,
  onChange,
  disabled,
}: {
  organizations: WebOrganization[]
  value: string
  onChange: (organizationId: string) => void
  disabled?: boolean
}) {
  const id = useId()
  return (
    <Field>
      <FieldLabel htmlFor={id}>Organization</FieldLabel>
      <NativeSelect
        id={id}
        value={value}
        disabled={disabled}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {organizations.map((org) => (
          <NativeSelectOption key={org.id} value={org.id}>
            {org.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <FieldDescription id={`${id}-hint`}>
        The access granted applies to this organization only.
      </FieldDescription>
    </Field>
  )
}
