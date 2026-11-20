import { buttonVariants } from "@proof/ui/components/ui/button"
import { Input } from "@proof/ui/components/ui/input"
import { Label } from "@proof/ui/components/ui/label"
import { cn } from "cn"

import { CATEGORIES, CATEGORY_LABELS, type Category } from "../../data/content"
import { site } from "../../site"
import { FeaturedPost, PostCard, type PostSummary } from "./post-card"

/**
 * The blog list: title, the category bar, the featured post (first page only), the grid, paging
 * and the newsletter. Categories with no posts are left out of the bar.
 */
export function BlogIndex({
  posts,
  featured,
  category,
  categories = [...CATEGORIES],
  page,
}: {
  posts: PostSummary[]
  featured?: PostSummary
  /** The category this list is filtered to; unset for all posts. */
  category?: Category
  categories?: Category[]
  page?: { current: number; last: number; prev?: string; next?: string }
}) {
  return (
    <div className="mx-auto flex max-w-300 flex-col gap-9 px-6 pt-16 pb-20">
      <div className="flex flex-col gap-2">
        <h1 className="type-page-title">
          {category ? `${CATEGORY_LABELS[category]} posts` : "Blog"}
        </h1>
        <p className="text-lg text-secondary-foreground">
          How we build agents people can trust — product news, engineering notes and guides.
        </p>
      </div>

      <nav aria-label="Categories">
        <ul className="flex flex-wrap gap-2">
          <CategoryLink href="/blog" label="All" current={!category} />
          {categories.map((c) => (
            <CategoryLink
              key={c}
              href={`/blog/category/${c}`}
              label={CATEGORY_LABELS[c]}
              current={c === category}
            />
          ))}
        </ul>
      </nav>

      {featured && <FeaturedPost post={featured} />}

      <section aria-labelledby="posts-h">
        {/* Keeps the outline h1 → h2 → h3 when there is no featured post (category pages). */}
        <h2 id="posts-h" className="sr-only">
          {featured ? "More posts" : "Posts"}
        </h2>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(320px,100%),1fr))] gap-6">
          {posts.map((post) => (
            <PostCard key={post.slug} post={post} />
          ))}
        </div>
      </section>

      {page && page.last > 1 && (
        <nav aria-label="Pagination" className="flex items-center gap-3 border-t pt-5">
          <PageLink href={page.prev} label="← Newer" />
          <span className="flex-1 text-center text-[15px] text-secondary-foreground">
            Page {page.current} of {page.last}
          </span>
          <PageLink href={page.next} label="Older →" />
        </nav>
      )}

      <Newsletter />
    </div>
  )
}

function CategoryLink({ href, label, current }: { href: string; label: string; current: boolean }) {
  return (
    <li>
      <a
        href={href}
        aria-current={current ? "page" : undefined}
        className={cn(
          "flex min-h-10 items-center rounded-full border-[1.5px] px-4 text-[15px] font-semibold hover:border-foreground",
          current && "border-foreground bg-primary text-primary-foreground",
        )}
      >
        {label}
      </a>
    </li>
  )
}

/** A paging link, or a dashed stand-in at either end (the disabled look from the design system). */
function PageLink({ href, label }: { href?: string; label: string }) {
  if (!href)
    return (
      <span className="flex min-h-11 items-center rounded-lg border-2 border-dashed border-muted-foreground px-4 font-semibold text-muted-foreground">
        {label}
      </span>
    )
  return (
    <a href={href} className={cn(buttonVariants({ variant: "outline" }))}>
      {label}
    </a>
  )
}

/** The monthly roundup signup. The form posts to your email provider (site.newsletterAction). */
export function Newsletter() {
  return (
    <section
      aria-labelledby="nl-h"
      className="flex flex-wrap items-center gap-6 rounded-2xl border bg-secondary p-7"
    >
      <div className="flex min-w-70 flex-1 flex-col gap-1">
        <h2 id="nl-h" className="text-2xl font-extrabold tracking-[-0.02em]">
          Get the monthly roundup
        </h2>
        <p className="text-secondary-foreground">
          One email a month. No tracking pixels. Unsubscribe in one click. Prefer feeds?{" "}
          <a href="/rss.xml" className="text-foreground underline">
            RSS
          </a>
        </p>
      </div>
      <form action={site.newsletterAction} method="post" className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="nl-e">Work email</Label>
          <Input
            id="nl-e"
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@company.com"
            className="h-12 w-70 max-w-full bg-background"
          />
        </div>
        <button type="submit" className={cn(buttonVariants({ size: "lg" }))}>
          Subscribe
        </button>
      </form>
    </section>
  )
}
