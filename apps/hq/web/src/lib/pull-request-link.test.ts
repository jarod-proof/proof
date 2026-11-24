import { describe, expect, it } from "vitest"

import { pullRequestLink } from "./pull-request-link"

const REPOS = ["acme/web"]
const GOOD = "https://github.com/acme/web/pull/106"

describe("pullRequestLink", () => {
  it("returns the url it built for hq's own pull request page", () => {
    expect(pullRequestLink(GOOD, 106, REPOS)).toBe(GOOD)
  })

  it("compares case-insensitively but returns the repo as the board spells it", () => {
    expect(pullRequestLink("https://GitHub.com/ACME/Web/pull/106", 106, REPOS)).toBe(GOOD)
    expect(pullRequestLink(GOOD, 106, ["Acme/Web"])).toBe("https://github.com/Acme/Web/pull/106")
  })

  it("finds the repo among several and returns that one", () => {
    expect(pullRequestLink("https://github.com/acme/api/pull/7", 7, ["acme/web", "acme/api"])).toBe(
      "https://github.com/acme/api/pull/7",
    )
  })

  it("is null for every url that is not exactly that page", () => {
    const refused: Record<string, string> = {
      userinfo: "https://github.com@evil.example/acme/web/pull/106",
      "userinfo before the host": "https://user:pass@github.com/acme/web/pull/106",
      "suffix host": "https://github.com.evil.example/acme/web/pull/106",
      "prefix host": "https://evilgithub.com/acme/web/pull/106",
      "host as a path": "https://evil.example/github.com/acme/web/pull/106",
      "another host": "https://evil.example/acme/web/pull/106",
      "encoded slash": "https://github.com/acme%2Fweb/pull/106",
      "encoded path": "https://github.com/acme/web/%70ull/106",
      "encoded number": "https://github.com/acme/web/pull/%31%30%36",
      query: "https://github.com/acme/web/pull/106?x=1",
      fragment: "https://github.com/acme/web/pull/106#files",
      "trailing slash": "https://github.com/acme/web/pull/106/",
      "path below": "https://github.com/acme/web/pull/106/files",
      "another repo": "https://github.com/acme/other/pull/106",
      "another owner": "https://github.com/evil/web/pull/106",
      "another number": "https://github.com/acme/web/pull/107",
      "leading zero": "https://github.com/acme/web/pull/0106",
      http: "http://github.com/acme/web/pull/106",
      "scheme-relative": "//github.com/acme/web/pull/106",
      "script url": "javascript:alert(1)",
      "data url": "data:text/html,<script>alert(1)</script>",
      "leading space": ` ${GOOD}`,
      "trailing space": `${GOOD} `,
      newline: `${GOOD}\n`,
      backslash: "https://github.com\\acme/web/pull/106",
      port: "https://github.com:443/acme/web/pull/106",
      empty: "",
    }
    for (const [name, url] of Object.entries(refused)) {
      expect(pullRequestLink(url, 106, REPOS), name).toBeNull()
    }
  })

  it("does not fold the Kelvin sign (U+212A) or the dotless i to ASCII", () => {
    expect(pullRequestLink("https://github.com/acme/Kweb/pull/1", 1, ["acme/kweb"])).toBeNull()
    expect(pullRequestLink("https://github.com/acme/web/pull/1", 1, ["acme/web"])).not.toBeNull()
    expect(pullRequestLink("https://github.com/acme/ıssue/pull/1", 1, ["acme/issue"])).toBeNull()
    expect(pullRequestLink("https://Kithub.com/acme/web/pull/1", 1, REPOS)).toBeNull()
  })

  it("is null with no repos and for a number that is not a pull request number", () => {
    expect(pullRequestLink(GOOD, 106, [])).toBeNull()
    expect(pullRequestLink("https://github.com/acme/web/pull/0", 0, REPOS)).toBeNull()
    expect(pullRequestLink("https://github.com/acme/web/pull/1.5", 1.5, REPOS)).toBeNull()
    expect(pullRequestLink("https://github.com/acme/web/pull/-1", -1, REPOS)).toBeNull()
  })
})
