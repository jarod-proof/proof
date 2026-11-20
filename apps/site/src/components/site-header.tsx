import { buttonVariants } from "@proof/ui/components/ui/button"
import { cn } from "cn"

import { type NavId, nav, site } from "../site"
import { Logo } from "./logo"

/** The announcement bar, the logo, the main nav (the current page highlighted) and the two CTAs. */
export function SiteHeader({
  active,
  announce = true,
}: {
  active?: NavId
  /** Legal pages drop the announcement bar. */
  announce?: boolean
}) {
  const announcement = announce ? site.announcement : null
  return (
    <>
      {announcement && (
        <aside aria-label="Announcement">
          <a
            href={announcement.href}
            className="flex min-h-9 flex-wrap items-center justify-center gap-2.5 bg-solar px-4 py-1 text-center text-sm text-solar-foreground"
          >
            <strong className="font-extrabold">{announcement.label}</strong>
            <span>{announcement.text}</span>
            <span className="font-semibold underline underline-offset-3">{announcement.cta}</span>
          </a>
        </aside>
      )}
      <header className="border-b">
        <div className="mx-auto flex max-w-300 flex-wrap items-center gap-x-7 gap-y-2 px-6 py-3.5">
          <Logo />
          <nav aria-label="Main" className="flex-1">
            <ul className="flex flex-wrap gap-1">
              {nav.map((item) => {
                const current = item.id === active
                return (
                  <li key={item.id}>
                    <a
                      href={item.href}
                      aria-current={current ? "page" : undefined}
                      className={cn(
                        "flex min-h-11 items-center px-2.5 text-[15px] text-secondary-foreground hover:text-foreground",
                        current && "font-bold text-foreground",
                      )}
                    >
                      <span className={cn("px-0.5", current && "highlight")}>{item.label}</span>
                    </a>
                  </li>
                )
              })}
            </ul>
          </nav>
          <div className="flex items-center gap-2">
            <a
              href={site.signInUrl}
              className={cn(buttonVariants({ variant: "ghost" }), "text-[15px] font-semibold")}
            >
              Sign in
            </a>
            <a href={site.signUpUrl} className={cn(buttonVariants(), "text-[15px]")}>
              Start free
            </a>
          </div>
        </div>
      </header>
    </>
  )
}
