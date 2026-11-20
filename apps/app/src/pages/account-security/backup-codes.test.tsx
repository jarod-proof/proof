// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { Dialog, DialogContent } from "@proof/ui/components/ui/dialog"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactElement } from "react"
import { describe, expect, it, vi } from "vitest"

import { BACKUP_CODE_COUNT, BackupCodesView } from "./backup-codes"

// BackupCodesView is the content of a dialog, so it is rendered inside one, as it is in the app.
function inDialog(element: ReactElement) {
  return (
    <Dialog open onOpenChange={vi.fn()}>
      <DialogContent>{element}</DialogContent>
    </Dialog>
  )
}

const codes = ["aaaa-1111", "bbbb-2222"]

describe("BackupCodesView", () => {
  it("lists every code, under the title and description", () => {
    render(
      inDialog(
        <BackupCodesView
          title="Save your backup codes"
          description="Each code works once."
          codes={codes}
          onDone={vi.fn()}
        />,
      ),
    )
    expect(screen.getByRole("heading", { name: "Save your backup codes" })).toBeTruthy()
    expect(screen.getByText("Each code works once.")).toBeTruthy()
    const list = screen.getByRole("list", { name: "Backup codes" })
    expect(list.querySelectorAll("li")).toHaveLength(2)
    expect(screen.getByText("aaaa-1111")).toBeTruthy()
  })

  it("calls back when the person has saved them", async () => {
    const onDone = vi.fn()
    render(
      inDialog(
        <BackupCodesView
          title="Your new backup codes"
          description="Save these."
          codes={codes}
          onDone={onDone}
        />,
      ),
    )
    await userEvent.click(screen.getByRole("button", { name: "I've saved them" }))
    expect(onDone).toHaveBeenCalledOnce()
  })

  it("uses ten codes as the full set", () => {
    expect(BACKUP_CODE_COUNT).toBe(10)
  })

  it("has no accessibility violations", async () => {
    // The dialog is portaled into document.body, so snapshot the body before unmounting.
    const view = render(
      inDialog(
        <BackupCodesView
          title="Your new backup codes"
          description="Save these."
          codes={codes}
          onDone={vi.fn()}
        />,
      ),
    )
    const html = document.body.innerHTML
    view.unmount()
    await expectNoA11yViolations(html)
  })
})
