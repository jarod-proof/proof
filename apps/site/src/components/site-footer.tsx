import { StatusIcon } from "@proof/ui/dplus/status"

import { footerColumns, site } from "../site"
import { Logo } from "./logo"

/** The tagline, the link columns, and the copyright row. */
export function SiteFooter({ year = new Date().getFullYear() }: { year?: number }) {
  return (
    <footer className="border-t text-[15px]">
      <div className="mx-auto flex max-w-300 flex-col gap-9 px-6 pt-12 pb-7">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(170px,100%),1fr))] gap-7">
          <div className="flex min-w-55 flex-col gap-2.5">
            <Logo />
            <p className="max-w-65 text-sm text-secondary-foreground">{site.tagline}</p>
            <p className="flex items-center gap-2 text-sm">
              <StatusIcon state="done" />
              {/* Point this at your status page, or drop it. */}
              [SYSTEM STATUS]
            </p>
          </div>
          {footerColumns.map((column) => (
            <nav key={column.title} aria-label={column.title} className="flex flex-col gap-1">
              <h2 className="mb-1 type-eyebrow text-muted-foreground">{column.title}</h2>
              {column.links.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  className="flex min-h-8 items-center text-[14.5px] text-secondary-foreground hover:text-foreground"
                >
                  {link.label}
                </a>
              ))}
            </nav>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t pt-5 text-[13.5px] text-muted-foreground">
          <span>
            © {year} {site.company}, Inc.
          </span>
          <span className="flex-1" />
          <span>System fonts · no third-party trackers</span>
          {site.social.map((link) => (
            <a key={link.label} href={link.href} className="text-secondary-foreground underline">
              {link.label}
            </a>
          ))}
        </div>
      </div>
    </footer>
  )
}
