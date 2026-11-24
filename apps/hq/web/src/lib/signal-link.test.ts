import { describe, expect, it } from "vitest"

import { signalLink } from "./signal-link"

const REPO = "acme/web"

describe("signalLink", () => {
  it("returns the url it built for an issue, a pull request or a commit of the repo", () => {
    expect(signalLink("https://github.com/acme/web/issues/101", REPO, true)).toEqual({
      href: "https://github.com/acme/web/issues/101",
      kind: "issue",
    })
    expect(signalLink("https://github.com/acme/web/pull/7", REPO, true)).toEqual({
      href: "https://github.com/acme/web/pull/7",
      kind: "pull request",
    })
    expect(signalLink("https://github.com/acme/web/commit/ABCDEF1", REPO, true)).toEqual({
      href: "https://github.com/acme/web/commit/abcdef1",
      kind: "commit",
    })
  })

  it("is never a link when hq did not check the url, whatever the url says", () => {
    expect(signalLink("https://github.com/acme/web/issues/101", REPO, false)).toBeNull()
  })

  it("is null without a url", () => {
    expect(signalLink(null, REPO, true)).toBeNull()
  })

  it("is null for anything that is not exactly a page of the item's own repo", () => {
    const refused = [
      "javascript:alert(1)",
      "http://github.com/acme/web/issues/101",
      "https://github.com.evil.example/acme/web/issues/101",
      "https://user:pass@github.com/acme/web/issues/101",
      "https://github.com/acme/other/issues/101",
      "https://github.com/acme/web/issues/101?x=1",
      "https://github.com/acme/web/issues/101#c",
      "https://github.com/acme/web/issues/101/",
      "https://github.com/acme/web/issues/0",
      "https://github.com/acme/web/issues/%31",
      "https://github.com/acme/web/actions/runs/1",
      "https://github.com/acme/web/commit/xyz",
      "https://github.com/acme/web/commit/abc12",
      "https://github.com/acme/web/issues/101\nhttps://evil.example",
    ]
    for (const url of refused) expect(signalLink(url, REPO, true), url).toBeNull()
  })

  it("is null when the repo is not owner/name", () => {
    expect(signalLink("https://github.com/acme/web/issues/1", "acme", true)).toBeNull()
    expect(signalLink("https://github.com/acme/web/issues/1", "acme/web/../x", true)).toBeNull()
  })
})
