// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import {
  CreateOrganizationPage,
  type CreateOrganizationPageProps,
} from "./create-organization-page"

function renderPage(overrides: Partial<CreateOrganizationPageProps> = {}) {
  const props: CreateOrganizationPageProps = {
    host: "app.example.com",
    slugAvailable: undefined,
    slugCheckFailed: false,
    onSlugChange: vi.fn(),
    onSubmit: vi.fn(async () => undefined),
    onCancel: vi.fn(),
    ...overrides,
  }
  const view = render(<CreateOrganizationPage {...props} />)
  const rerender = (next: Partial<CreateOrganizationPageProps>) =>
    view.rerender(<CreateOrganizationPage {...props} {...next} />)
  return { props, rerender }
}

const nameInput = () => screen.getByLabelText("Organization name")
const urlInput = () => screen.getByRole("textbox", { name: "URL" }) as HTMLInputElement

describe("CreateOrganizationPage", () => {
  it("suggests a slug from the name until the URL is edited", async () => {
    renderPage()
    await userEvent.type(nameInput(), "Acme Labs")
    expect(urlInput().value).toBe("acme-labs")

    await userEvent.clear(urlInput())
    await userEvent.type(urlInput(), "acme-x")
    await userEvent.type(nameInput(), " Ltd")
    expect(urlInput().value).toBe("acme-x")
  })

  it("reports each slug to the container so it can be checked", async () => {
    const { props } = renderPage()
    await userEvent.type(nameInput(), "Acme")
    await waitFor(() => expect(props.onSlugChange).toHaveBeenLastCalledWith("acme"))
  })

  it("shows that the slug is being checked, then whether it is free", async () => {
    const { rerender } = renderPage({ slugAvailable: "checking" })
    await userEvent.type(nameInput(), "Acme Labs")
    expect(await screen.findByText(/Checking/)).toBeTruthy()
    rerender({ slugAvailable: true })
    expect(await screen.findByText("Available")).toBeTruthy()
  })

  it("reports a taken slug", async () => {
    renderPage({ slugAvailable: false })
    await userEvent.type(nameInput(), "Babbage")
    expect(await screen.findByText("Taken")).toBeTruthy()
  })

  it("refuses a reserved slug without needing a check", async () => {
    renderPage()
    await userEvent.type(nameInput(), "Admin")
    await userEvent.clear(urlInput())
    await userEvent.type(urlInput(), "admin")
    expect(await screen.findByText("That address is reserved. Choose another.")).toBeTruthy()
    expect(urlInput().getAttribute("aria-invalid")).toBe("true")
  })

  it("names the reserved address in the status its field points at", async () => {
    renderPage()
    await userEvent.type(nameInput(), "Admin")
    await userEvent.clear(urlInput())
    await userEvent.type(urlInput(), "admin")
    await screen.findByText("That address is reserved. Choose another.")
    const describedBy = urlInput().getAttribute("aria-describedby")
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      "That address is reserved. Choose another.",
    )
    expect(screen.queryByText(/Use lowercase letters/)).toBeNull()
    expect(screen.queryByText("Choose a valid organization URL.")).toBeNull()
  })

  it("does not say Available when the check fails", async () => {
    renderPage({ slugCheckFailed: true })
    await userEvent.type(nameInput(), "Acme")
    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(screen.queryByText("Available")).toBeNull()
  })

  it("submits the trimmed name and the slug", async () => {
    const { props } = renderPage({ slugAvailable: true })
    await userEvent.type(nameInput(), "  Acme Labs  ")
    await screen.findByText("Available")
    await userEvent.click(screen.getByRole("button", { name: "Create organization" }))
    await waitFor(() => expect(props.onSubmit).toHaveBeenCalled())
    expect(props.onSubmit).toHaveBeenCalledWith({ name: "Acme Labs", slug: "acme-labs" })
  })

  it("shows the refusal from submit", async () => {
    renderPage({
      slugAvailable: true,
      onSubmit: vi.fn(async () => {
        throw new Error("That slug is taken")
      }),
    })
    await userEvent.type(nameInput(), "Acme Labs")
    await screen.findByText("Available")
    await userEvent.click(screen.getByRole("button", { name: "Create organization" }))
    expect((await screen.findByRole("alert")).textContent).toContain("That slug is taken")
  })

  it("calls back when cancelled", async () => {
    const { props } = renderPage()
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(props.onCancel).toHaveBeenCalled()
  })

  it("explains that logo upload is unavailable", () => {
    renderPage()
    expect(screen.getByRole("button", { name: "Upload" }).hasAttribute("disabled")).toBe(true)
    expect(screen.getByText(/Logo upload is not available yet/)).toBeTruthy()
  })

  it("has no accessibility violations", async () => {
    renderPage({ slugAvailable: true })
    await userEvent.type(nameInput(), "Acme")
    await screen.findByText("Available")
    await expectNoA11yViolations(document.body.innerHTML)
  })
})
