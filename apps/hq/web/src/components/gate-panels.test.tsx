// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { HqError } from "../api/errors"
import { NotFounderPanel, RefusedPanel } from "./gate-panels"

const refused = new HqError({ kind: "refused", status: 503, message: "service unavailable" })

describe("the gate panels", () => {
  it("NotFounderPanel has no a11y violations, with and without an email or an error", async () => {
    for (const props of [
      { email: "visitor@example.com", error: null },
      { email: null, error: "Could not reach the server. Check your connection, then retry." },
    ]) {
      const view = render(
        <NotFounderPanel
          email={props.email}
          error={props.error}
          pending={false}
          onSignOut={() => {}}
        />,
      )
      expect(view.container.querySelector("[style]")).toBeNull()
      expect(view.getByRole("button", { name: "Sign out" }).className).toContain("min-h-touch")
      await expectNoA11yViolations(view.container.innerHTML)
      view.unmount()
    }
  })

  it("RefusedPanel has no a11y violations and a Retry that is at least 44px", async () => {
    const onRetry = vi.fn()
    const view = render(<RefusedPanel error={refused} onRetry={onRetry} retrying={false} />)
    const retry = view.getByRole("button", { name: "Retry" })
    expect(retry.className).toContain("min-h-touch")
    retry.click()
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(view.container.querySelector("[style]")).toBeNull()
    await expectNoA11yViolations(view.container.innerHTML)
  })

  it("RefusedPanel disables Retry while retrying", () => {
    const view = render(<RefusedPanel error={refused} onRetry={() => {}} retrying />)
    expect((view.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true)
  })
})
