// @vitest-environment jsdom
import { expectNoA11yViolations } from "@proof/ui/a11y"
import { describe, expect, it } from "vitest"

import { coverFor, formatDate, usedCategories } from "../../data/content"
import { linksNamed, render } from "../../test/render"
import { BlogIndex } from "./blog-index"
import type { PostSummary } from "./post-card"
import { PostPage } from "./post-page"

function post(slug: string, overrides: Partial<PostSummary> = {}): PostSummary {
  return {
    slug,
    title: `Title ${slug}`,
    description: `About ${slug}`,
    category: "guides",
    author: "Jordan Lee",
    date: new Date("2026-10-14T00:00:00Z"),
    readingMinutes: 5,
    cover: "ink",
    ...overrides,
  }
}

describe("BlogIndex", () => {
  it("shows the featured post, the grid and the paging", async () => {
    const html = render(
      <BlogIndex
        featured={post("lead", { cover: "solar", coverText: "Short line." })}
        posts={[post("a", { cover: "hatch" }), post("b", { cover: "outline" })]}
        categories={["guides", "security"]}
        page={{ current: 1, last: 2, next: "/blog/2" }}
      />,
    )
    expect(document.querySelector("h1")?.textContent).toBe("Blog")
    expect(document.body.textContent).toContain("Short line.")
    expect(linksNamed("Older →")[0]?.getAttribute("href")).toBe("/blog/2")
    // The newer end has no page: a dashed stand-in, not a link.
    expect(linksNamed("← Newer")).toHaveLength(0)
    expect(document.body.textContent).toContain("Page 1 of 2")
    expect(linksNamed("All")[0]?.getAttribute("aria-current")).toBe("page")
    await expectNoA11yViolations(html)
  })

  it("titles and marks a category page and hides paging for one page", () => {
    render(
      <BlogIndex
        posts={[post("a")]}
        category="guides"
        categories={["guides"]}
        page={{ current: 1, last: 1 }}
      />,
    )
    expect(document.querySelector("h1")?.textContent).toBe("Guides posts")
    expect(linksNamed("Guides")[0]?.getAttribute("aria-current")).toBe("page")
    expect(document.querySelector("nav[aria-label=Pagination]")).toBeNull()
  })

  it("labels the newsletter field", () => {
    render(<BlogIndex posts={[]} />)
    expect(document.querySelector("label[for=nl-e]")?.textContent).toBe("Work email")
    expect(document.querySelector("form")?.getAttribute("method")).toBe("post")
  })
})

describe("PostPage", () => {
  const props = {
    toc: [
      { slug: "one", text: "One" },
      { slug: "two", text: "Two" },
    ],
    related: [post("next", { category: "security" })],
  }

  it("highlights the end of the title and lists the sections", async () => {
    const html = render(
      <PostPage
        post={post("p", { title: "How we review work before it ships" })}
        highlight="before it ships"
        authorBio="Writes about agents."
        {...props}
      >
        <p>Body</p>
      </PostPage>,
    )
    expect(document.querySelector("h1 .highlight")?.textContent).toBe("before it ships")
    expect(linksNamed("Two")[0]?.getAttribute("href")).toBe("#two")
    expect(document.body.textContent).toContain("Writes about agents.")
    expect(document.body.textContent).toContain("JL")
    expect(linksNamed("Title next")[0]?.getAttribute("href")).toBe("/blog/next")
    await expectNoA11yViolations(html)
  })

  it("leaves the title whole when the highlight doesn't end it", () => {
    render(
      <PostPage post={post("p")} highlight="nope" toc={[]} related={[]}>
        <p>Body</p>
      </PostPage>,
    )
    expect(document.querySelector("h1")?.textContent).toBe("Title p")
    expect(document.querySelector("h1 .highlight")).toBeNull()
    expect(document.querySelector("nav[aria-label='On this page']")).toBeNull()
  })
})

describe("content helpers", () => {
  it("formats dates in UTC", () => {
    expect(formatDate(new Date("2026-10-14T00:00:00Z"))).toBe("Oct 14, 2026")
  })

  it("cycles covers unless a post picks one", () => {
    expect([0, 1, 2, 3, 4].map((i) => coverFor(i))).toEqual([
      "ink",
      "hatch",
      "outline",
      "solar",
      "ink",
    ])
    expect(coverFor(0, "solar")).toBe("solar")
  })

  it("keeps used categories in the bar's order", () => {
    expect(usedCategories([{ category: "opinion" }, { category: "product" }])).toEqual([
      "product",
      "opinion",
    ])
  })
})
