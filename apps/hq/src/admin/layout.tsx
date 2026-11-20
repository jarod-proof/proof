import type { Child } from "hono/jsx"

/**
 * The admin pages' stylesheet, served at /admin/admin.css (no inline styles, so a stricter content
 * security policy can follow). System colours with a dark variant: no brand, no framework.
 */
export const ADMIN_CSS = `
:root { color-scheme: light dark; --bg: #fafafa; --fg: #1a1a1a; --muted: #5c5c5c; --line: #d4d4d4; --card: #ffffff; --accent: #1d4ed8; --danger: #b91c1c; --ok: #15803d; }
@media (prefers-color-scheme: dark) { :root { --bg: #111113; --fg: #ececec; --muted: #a3a3a3; --line: #3a3a3f; --card: #1a1a1d; --accent: #8ab4ff; --danger: #f87171; --ok: #4ade80; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
header, main { max-width: 64rem; margin: 0 auto; padding: 1rem; }
header { display: flex; flex-wrap: wrap; gap: 1rem; align-items: baseline; border-bottom: 1px solid var(--line); }
header strong { margin-right: auto; }
nav { display: flex; gap: 1rem; }
a { color: var(--accent); }
h1 { font-size: 1.5rem; margin: 0 0 1rem; }
h2 { font-size: 1.15rem; margin: 2rem 0 0.75rem; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 0.5rem; padding: 1rem; margin: 0 0 1rem; }
.meta { color: var(--muted); font-size: 0.875rem; }
.body { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0.5rem 0; }
.actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: end; }
.actions label { display: grid; gap: 0.25rem; flex: 1 1 14rem; font-size: 0.875rem; }
input, button { font: inherit; padding: 0.5rem 0.75rem; border: 1px solid var(--line); border-radius: 0.375rem; background: var(--card); color: var(--fg); min-height: 2.5rem; }
button.approve { border-color: var(--ok); }
button.reject { border-color: var(--danger); }
.error { border: 1px solid var(--danger); color: var(--danger); padding: 0.75rem; border-radius: 0.375rem; margin: 0 0 1rem; }
table { width: 100%; border-collapse: collapse; }
caption { text-align: left; color: var(--muted); padding-bottom: 0.5rem; }
th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid var(--line); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
`

/** The shared page frame. Everything dynamic is a JSX child, so Hono escapes it. */
export function Layout(props: { title: string; nav?: boolean; children?: Child }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{props.title} · HQ</title>
        <link rel="stylesheet" href="/admin/admin.css" />
      </head>
      <body>
        <header>
          <strong>HQ</strong>
          {props.nav === false ? null : (
            <nav aria-label="Admin">
              <a href="/admin/proposals">Proposals</a>
              <a href="/admin/spend">Spend</a>
            </nav>
          )}
        </header>
        <main>{props.children}</main>
      </body>
    </html>
  )
}
