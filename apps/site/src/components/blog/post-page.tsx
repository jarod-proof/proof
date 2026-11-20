import { buttonVariants } from "@proof/ui/components/ui/button"
import { cn } from "cn"
import type { ReactNode } from "react"

import { CATEGORY_LABELS } from "../../data/content"
import { site } from "../../site"
import { PostCover, type PostSummary, postMeta } from "./post-card"

/** A heading in the post, for the "On this page" list. */
export interface TocItem {
  slug: string
  text: string
}

/**
 * A blog post: breadcrumb, title, byline, the "On this page" list beside the body, the author,
 * three more posts and a closing call to try the product. `children` is the rendered Markdown.
 */
export function PostPage({
  post,
  highlight,
  authorBio,
  toc,
  related,
  children,
}: {
  post: PostSummary
  /** The end of the title to underline with the highlighter. */
  highlight?: string
  authorBio?: string
  toc: TocItem[]
  related: PostSummary[]
  children: ReactNode
}) {
  return (
    <div className="mx-auto flex max-w-300 flex-col gap-10 px-6 pt-12 pb-20 text-lg leading-[1.65]">
      <header className="flex max-w-205 flex-col gap-4">
        <nav aria-label="Breadcrumb">
          <ol className="flex gap-2 text-[15px] text-muted-foreground">
            <li>
              <a href="/blog" className="underline underline-offset-3">
                Blog
              </a>
            </li>
            <li aria-hidden="true">/</li>
            <li>
              <a href={`/blog/category/${post.category}`} className="underline underline-offset-3">
                {CATEGORY_LABELS[post.category]}
              </a>
            </li>
          </ol>
        </nav>
        <h1 className="type-page-title">
          <TitleWithHighlight title={post.title} highlight={highlight} />
        </h1>
        <p className="text-[21px] leading-normal text-secondary-foreground">{post.description}</p>
        <div className="flex flex-wrap items-center gap-3 text-[15px] text-secondary-foreground">
          <Initials name={post.author} />
          <span>
            <strong className="text-foreground">{post.author}</strong>
            {postMeta(post).slice(post.author.length)}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            data-copy-link
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "text-sm")}
          >
            Copy link
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-start gap-14">
        {toc.length > 0 && (
          <nav
            aria-label="On this page"
            className="flex max-w-60 flex-[1_1_200px] flex-col gap-0.5 border-t-[3px] border-foreground pt-3.5 text-[15px] leading-normal md:sticky md:top-6"
          >
            <span className="mb-1.5 type-eyebrow text-muted-foreground">ON THIS PAGE</span>
            {toc.map((item) => (
              <a
                key={item.slug}
                href={`#${item.slug}`}
                className="flex min-h-9 items-center text-secondary-foreground hover:text-foreground"
              >
                {item.text}
              </a>
            ))}
          </nav>
        )}
        <article className="flex max-w-175 min-w-0 flex-[999_1_560px] flex-col gap-5.5">
          <div className="post-body">{children}</div>
          <div className="flex items-start gap-4 border-t pt-6">
            <Initials name={post.author} large />
            <div className="flex flex-col gap-0.5 text-base">
              <strong>{post.author}</strong>
              {authorBio && <span className="text-secondary-foreground">{authorBio}</span>}
            </div>
          </div>
        </article>
      </div>

      {related.length > 0 && (
        <section aria-labelledby="rel-h" className="flex flex-col gap-5 border-t pt-9 text-base">
          <h2 id="rel-h" className="text-[26px] font-extrabold tracking-[-0.02em]">
            Keep reading
          </h2>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-6">
            {related.map((r) => (
              <article key={r.slug} className="flex flex-col gap-2">
                <PostCover
                  cover={r.cover}
                  label={CATEGORY_LABELS[r.category].toUpperCase()}
                  className="h-30"
                />
                <h3 className="text-xl leading-tight font-extrabold">
                  <a href={`/blog/${r.slug}`} className="hover:underline">
                    {r.title}
                  </a>
                </h3>
                <span className="text-sm text-muted-foreground">{r.readingMinutes} min read</span>
              </article>
            ))}
          </div>
        </section>
      )}

      <section
        aria-labelledby="try-h"
        className="flex flex-wrap items-center gap-6 rounded-[18px] bg-primary p-9 text-primary-foreground"
      >
        <div className="flex min-w-70 flex-1 flex-col gap-1.5">
          <h2 id="try-h" className="text-[30px] leading-tight font-extrabold tracking-[-0.025em]">
            Try approvals on your own work.
          </h2>
          <p className="text-[17px] opacity-85">Free for 3 seats. No card.</p>
        </div>
        <a
          href={site.signUpUrl}
          className={cn(
            buttonVariants({ size: "lg" }),
            "h-13 border-solar bg-solar px-6.5 text-[17px] font-extrabold text-solar-foreground hover:bg-solar/85",
          )}
        >
          Start free
        </a>
      </section>
    </div>
  )
}

function TitleWithHighlight({ title, highlight }: { title: string; highlight?: string }) {
  if (!highlight || !title.endsWith(highlight)) return title
  return (
    <>
      {title.slice(0, -highlight.length)}
      <span className="highlight px-1">{highlight}</span>
    </>
  )
}

/** The author's initials in a round outline: there are no photos to load. */
function Initials({ name, large = false }: { name: string; large?: boolean }) {
  const initials = name
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}]/gu, "")[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase()
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-full border-foreground font-bold text-foreground",
        large ? "size-14 border-2 text-lg" : "size-9 border-[1.5px] text-[13px]",
      )}
    >
      {initials}
    </span>
  )
}
