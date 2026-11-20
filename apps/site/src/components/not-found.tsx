import { buttonVariants } from "@proof/ui/components/ui/button"
import { cn } from "cn"

/** The 404 page body: say so plainly and offer the way back. */
export function NotFound() {
  return (
    <section className="mx-auto flex max-w-300 flex-col items-start gap-5 px-6 py-24">
      <span className="type-eyebrow text-muted-foreground">404</span>
      <h1 className="type-page-title">That page isn't here.</h1>
      <p className="type-lead text-secondary-foreground">
        It may have moved, or the link may be mistyped.
      </p>
      <div className="flex flex-wrap gap-2.5">
        <a href="/" className={cn(buttonVariants())}>
          Go home
        </a>
        <a href="/blog" className={cn(buttonVariants({ variant: "outline" }))}>
          Read the blog
        </a>
      </div>
    </section>
  )
}
