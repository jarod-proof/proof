// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { FormDialog, FormError, useAppForm } from "./form"

function SignInHarness({ onValid }: { onValid: (value: { email: string }) => void }) {
  const form = useAppForm({
    defaultValues: { email: "" },
    validators: { onSubmit: z.object({ email: z.string().min(1, "Enter your email.") }) },
    onSubmit: ({ value }) => onValid(value),
  })
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        void form.handleSubmit()
      }}
    >
      <form.AppField name="email">
        {(field) => <field.TextField label="Email" type="email" description="We never share it." />}
      </form.AppField>
      <form.AppForm>
        <form.SubmitButton pendingLabel="Saving…">Save</form.SubmitButton>
      </form.AppForm>
    </form>
  )
}

describe("TextField", () => {
  it("labels the input and shows its description", () => {
    render(<SignInHarness onValid={vi.fn()} />)
    const input = screen.getByLabelText("Email")
    expect(input.getAttribute("type")).toBe("email")
    expect(screen.getByText("We never share it.")).toBeTruthy()
  })

  it("shows the Zod message under the field and marks it invalid", async () => {
    const onValid = vi.fn()
    render(<SignInHarness onValid={onValid} />)
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByText("Enter your email.")).toBeTruthy()
    expect(screen.getByLabelText("Email").getAttribute("aria-invalid")).toBe("true")
    expect(onValid).not.toHaveBeenCalled()
  })

  it("submits the values when they are valid", async () => {
    const onValid = vi.fn()
    render(<SignInHarness onValid={onValid} />)
    await userEvent.type(screen.getByLabelText("Email"), "ada@example.com")
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onValid).toHaveBeenCalled())
    expect(onValid).toHaveBeenCalledWith({ email: "ada@example.com" })
  })

  it("has no accessibility violations", async () => {
    const { container } = render(<SignInHarness onValid={vi.fn()} />)
    await expectNoA11yViolations(container.innerHTML)
  })
})

describe("FormError", () => {
  it("renders nothing without a message", () => {
    const { container } = render(<FormError message={null} />)
    expect(container.textContent).toBe("")
  })

  it("renders the message as an alert", () => {
    render(<FormError message="Could not save." />)
    expect(screen.getByRole("alert").textContent).toBe("Could not save.")
  })
})

describe("FormDialog", () => {
  function renderDialog(props: Partial<Parameters<typeof FormDialog>[0]> = {}) {
    const onSubmit = vi.fn()
    const onOpenChange = vi.fn()
    const view = render(
      <FormDialog
        open
        onOpenChange={onOpenChange}
        title="Turn off two-factor?"
        description="Your backup codes stop working."
        onSubmit={onSubmit}
        submitLabel="Turn off two-factor"
        pendingLabel="Turning off…"
        destructive
        {...props}
      >
        <label htmlFor="pw">Password</label>
        <input id="pw" name="password" type="password" />
      </FormDialog>,
    )
    return { onSubmit, onOpenChange, unmount: view.unmount }
  }

  it("renders the title, the body and the footer actions", () => {
    renderDialog()
    expect(screen.getByRole("dialog", { name: "Turn off two-factor?" })).toBeTruthy()
    expect(screen.getByLabelText("Password")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy()
  })

  it("calls its submit when the form is submitted", async () => {
    const { onSubmit } = renderDialog()
    await userEvent.click(screen.getByRole("button", { name: "Turn off two-factor" }))
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it("disables submit and shows the pending label while pending", () => {
    renderDialog({ pending: true })
    const submit = screen.getByRole("button", { name: "Turning off…" })
    expect(submit.hasAttribute("disabled")).toBe(true)
  })

  it("shows an error from the submit", () => {
    renderDialog({ error: "That password is wrong." })
    expect(screen.getByRole("alert").textContent).toBe("That password is wrong.")
  })

  it("is an alert dialog when it confirms a security change", () => {
    renderDialog({ alert: true })
    expect(screen.getByRole("alertdialog", { name: "Turn off two-factor?" })).toBeTruthy()
  })

  it("has no accessibility violations, as a dialog or an alert dialog", async () => {
    // The dialog is portaled into document.body, so snapshot the body before unmounting.
    for (const alert of [false, true]) {
      const view = renderDialog({ alert, error: "That password is wrong." })
      const html = document.body.innerHTML
      view.unmount()
      await expectNoA11yViolations(html)
    }
  })

  it("asks to close when Cancel is pressed", async () => {
    const { onOpenChange } = renderDialog()
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(false)
  })
})
