import { describe, expect, it } from "vitest"

// The server's header name. @proof/api/headers has no imports, so the test can read it; the client
// keeps its own literal in org-header.ts and this test keeps the two equal.
import { ORGANIZATION_HEADER } from "@proof/api/headers"
import { X_ORGANIZATION_ID, organizationHeaders } from "./org-header"

describe("X-Organization-Id", () => {
  it("is the header the server reads", () => {
    expect(X_ORGANIZATION_ID).toBe(ORGANIZATION_HEADER)
  })

  it("sends the organization under that header", () => {
    expect(organizationHeaders("org-a")).toEqual({ [ORGANIZATION_HEADER]: "org-a" })
  })
})
