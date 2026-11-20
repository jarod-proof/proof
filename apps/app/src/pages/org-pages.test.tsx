// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { OrgNotFoundPage } from "./org-not-found-page"

describe("OrgNotFoundPage", () => {
  it("says there is no such organization and links to create one", async () => {
    render(<OrgNotFoundPage slug="nowhere" />)
    expect(screen.getByRole("heading", { name: "No organization at this address" })).toBeTruthy()
    expect(screen.getByRole("link", { name: "Create an organization" }).getAttribute("href")).toBe(
      "/new",
    )
    await expectNoA11yViolations(document.body.innerHTML)
  })
})
