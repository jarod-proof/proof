import { Badge } from "@proof/ui/components/ui/badge"
import { buttonVariants } from "@proof/ui/components/ui/button"
import { cn } from "cn"
import type { ReactNode } from "react"

import { CHANGE_KINDS, type ChangeKind, formatDate } from "../data/content"

const KIND_LABELS: Record<ChangeKind, string> = {
  new: "New",
  improved: "Improved",
  fixed: "Fixed",
}

/** The title, the feed links, and the filter bar (one static page per kind, no script). */
export function ChangelogHeader({ kind }: { kind?: ChangeKind }) {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-end gap-6">
        <div className="flex min-w-70 flex-1 flex-col gap-2">
          <h1 className="type-page-title">Changelog</h1>
          <p className="text-lg text-secondary-foreground">
            Everything we ship, newest first. The same notes appear in the app's sidebar.
          </p>
        </div>
        <div className="flex gap-2">
          <a href="/changelog/rss.xml" className={cn(buttonVariants({ variant: "outline" }))}>
            RSS
          </a>
          <a href="/blog#nl-h" className={cn(buttonVariants())}>
            Email me updates
          </a>
        </div>
      </div>
      <nav aria-label="Filter by type">
        <ul className="flex flex-wrap gap-2">
          <FilterLink href="/changelog" label="All" current={!kind} />
          {CHANGE_KINDS.map((k) => (
            <FilterLink
              key={k}
              href={`/changelog/${k}`}
              label={KIND_LABELS[k]}
              current={k === kind}
            />
          ))}
        </ul>
      </nav>
    </div>
  )
}

function FilterLink({ href, label, current }: { href: string; label: string; current: boolean }) {
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

/** One release: date and version on the left, tags, title and notes on the right. */
export function ChangeEntry({
  id,
  title,
  version,
  date,
  kinds,
  post,
  children,
}: {
  /** The anchor the changelog feed links to. */
  id: string
  title: string
  version: string
  date: Date
  kinds: ChangeKind[]
  /** The slug of the blog post with the longer story. */
  post?: string
  children: ReactNode
}) {
  return (
    <article id={id} className="flex scroll-mt-6 flex-wrap gap-x-10 gap-y-3 border-b py-8">
      <div className="flex max-w-50 flex-[1_1_160px] flex-col gap-1">
        <time dateTime={date.toISOString().slice(0, 10)} className="font-bold">
          {formatDate(date)}
        </time>
        <span className="font-mono text-sm text-muted-foreground">{version}</span>
      </div>
      <div className="flex min-w-0 flex-[999_1_480px] flex-col gap-3">
        <div className="flex flex-wrap gap-1.5">
          {kinds.map((k) => (
            <KindTag key={k} kind={k} />
          ))}
        </div>
        <h2 className="text-[26px] leading-tight font-extrabold tracking-[-0.02em]">{title}</h2>
        <div className="change-body">{children}</div>
        {post && (
          <a
            href={`/blog/${post}`}
            className="self-start font-semibold underline underline-offset-3"
          >
            Read the post
          </a>
        )}
      </div>
    </article>
  )
}

/** New is solar (it is the news), improved is outlined, fixed is hatched. */
function KindTag({ kind }: { kind: ChangeKind }) {
  const label = KIND_LABELS[kind].toUpperCase()
  if (kind === "new")
    return (
      <Badge variant="solar" size="sm">
        {label}
      </Badge>
    )
  return (
    <Badge
      variant="outline"
      size="sm"
      className={cn("rounded-sm", kind === "fixed" && "hatch border-border")}
    >
      {label}
    </Badge>
  )
}
