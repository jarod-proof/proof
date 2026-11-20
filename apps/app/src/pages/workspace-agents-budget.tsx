import { FieldIssues, FormError, invalidOf } from "../components/form"
import { useForm } from "@tanstack/react-form"
import { type ReactNode, useId, useState } from "react"

import { Button } from "@proof/ui/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@proof/ui/components/ui/field"
import { Input } from "@proof/ui/components/ui/input"

import { messageOf } from "../lib/messages"
import {
  energyBudgetLabel,
  energyBudgetPatch,
  energyBudgetSchema,
  type EnergyBudgetValues,
} from "../lib/workspace-agents"
import type { WorkspaceAgent } from "../lib/workspace-agents-api"

export interface BudgetSectionProps {
  agent: WorkspaceAgent | undefined
  /** agent:update. Viewers see the budget read-only. */
  canUpdate: boolean
  /** Saves the budget through update_agent; the server refuses anything the role may not do. */
  onSave: (agentId: string, energyBudgetWh: number | null) => Promise<void>
  /** The level-2 pills, placed beside the heading. */
  pills?: ReactNode
}

/**
 * The energy budget of the selected agent (one number per run, in watt-hours). Lives in the
 * "Budgets & footprint" tab; the server keeps the budget and checks it on every run.
 */
export function BudgetSection({ agent, canUpdate, onSave, pills }: BudgetSectionProps) {
  const inputId = useId()
  const [serverError, setServerError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const form = useForm({
    defaultValues: {
      energyBudgetWh: agent?.energyBudgetWh?.toString() ?? "",
    } as EnergyBudgetValues,
    validators: { onChange: energyBudgetSchema },
    onSubmit: async ({ value }) => {
      if (!agent) return
      setServerError(null)
      setSaved(false)
      try {
        await onSave(agent.id, energyBudgetPatch(value.energyBudgetWh))
        setSaved(true)
      } catch (caught) {
        setServerError(messageOf(caught))
      }
    },
  })

  if (!agent) {
    return (
      <section aria-labelledby="budget-heading" className="flex max-w-[640px] flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <h2 id="budget-heading" className="text-[18px] font-bold">
            Budgets and footprint
          </h2>
          {pills}
        </div>
        <p className="text-sm text-muted-foreground">Create an agent to set its energy budget.</p>
      </section>
    )
  }

  return (
    <section aria-labelledby="budget-heading" className="flex max-w-[640px] flex-col gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <h2 id="budget-heading" className="text-[18px] font-bold">
            Budgets and footprint
          </h2>
          {pills}
        </div>
        <p className="text-sm text-muted-foreground">
          The energy {agent.name} may use in one run, in watt-hours (Wh). Past it, the run pauses
          when “Go over a run’s energy budget” is on.
        </p>
      </div>

      <p className="text-sm">
        <span className="font-semibold">{agent.name}</span>
        <span className="text-muted-foreground"> · {energyBudgetLabel(agent.energyBudgetWh)}</span>
      </p>

      {canUpdate ? (
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            event.stopPropagation()
            void form.handleSubmit()
          }}
        >
          <form.Field name="energyBudgetWh">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={inputId}>Energy budget per run (Wh)</FieldLabel>
                <Input
                  id={inputId}
                  name="energyBudgetWh"
                  inputMode="decimal"
                  className="min-h-11 max-w-[240px]"
                  value={field.state.value}
                  placeholder="No budget"
                  aria-invalid={invalidOf(field)}
                  onChange={(event) => {
                    setSaved(false)
                    field.handleChange(event.currentTarget.value)
                  }}
                  onBlur={field.handleBlur}
                />
                <FieldDescription>Leave it empty for no budget.</FieldDescription>
                <FieldIssues field={field} />
              </Field>
            )}
          </form.Field>

          <FormError message={serverError} />
          {saved ? (
            <output className="block text-sm text-muted-foreground">Budget saved.</output>
          ) : null}

          <div>
            <Button type="submit" className="min-h-11">
              Save budget
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">
          Viewers can read the budget but not change it.
        </p>
      )}
    </section>
  )
}
