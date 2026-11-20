# Marketing site (`apps/site`)

`@proof/site` is the public marketing site: Astro, prerendered to static HTML in `apps/site/dist`,
with no client JavaScript except the "Copy link" button on blog posts. It is built from the
"Marketing site template" boards of the D+ design canvas (`SiteHome`, `SitePricing`, `SiteBlog`,
`SitePost`, `SiteChangelog`, `SiteLegal`, `SiteHeader`, `SiteFooter`).

## Layout

- `src/pages/*.astro` are thin: they load content and compose components. `src/layouts/base.astro`
  holds `<head>`, the pre-paint theme script, the header and the footer.
- `src/components/**/*.tsx` are React components from `@proof/ui`, rendered by Astro at build
  time with no `client:` directive, so they ship as HTML. Markup goes here, not in `.astro` files:
  oxlint's `jsx-a11y` rules, baseline's dark-mode and raw-colour rules, and the tests only see
  `.tsx`.
- `src/site.ts` holds the name, the links and the placeholders (`[Product]`, `[DOCS_URL]`, ...).
  `src/data/` holds the plans, the comparison table and the FAQs.
- `src/content/` is three content collections (`src/content.config.ts`): `blog/` (one Markdown file
  per post, named by its slug), `changelog/` (one per release) and `legal/` (one per document tab).
  `src/lib/content.ts` queries them for the pages.

Routes: `/`, `/pricing`, `/blog` (paged by six, `/blog/2`...), `/blog/<slug>`,
`/blog/category/<category>`, `/changelog` and `/changelog/{new,improved,fixed}`, `/legal/<slug>`,
`/rss.xml`, `/changelog/rss.xml`, and `404.html`.

## Styling

`src/site.css` imports `@proof/ui/styles.css`, so the site uses the app's tokens and dark mode
(the `.dark` class, set before paint from the same `proof.theme` key as the app). It adds the
marketing type scale (`type-hero`, `type-page-title`, `type-section`, `type-lead`) and the styles
for rendered Markdown (`.post-body`, `.legal-body`, `.change-body`), which has no classes of its
own. Code blocks are not syntax-coloured (`markdown.syntaxHighlight: false`).

- Link CTAs are `<a className={cn(buttonVariants(...))}>`. Always through `cn`: `buttonVariants`
  alone keeps the base's `border-transparent` next to the variant's border colour.
- No JavaScript for interaction: FAQs are `<details>`, the Monthly/Annual switch is a radio pair
  whose price shows through `:has()`, and the blog and changelog filters are separate static pages.
- The previews (a run, the inbox, blog covers) are drawn from the design system, not screenshots.

## Config

`SITE_URL` (canonical URLs, RSS) and `APP_URL` (where "Sign in" and "Start free" go) are read by
`astro.config.ts` at build time; both are declared in `packages/env`. Under `pnpm dev`, portless
serves the site as `site.proof` and both default to the portless URLs.

## Before publishing

Fill in every bracketed placeholder (`grep -rn '\[' apps/site/src`): prices, logos, the customer
quote, compliance status, the training-data policy, legal text (have counsel draft it), the
newsletter endpoint, docs and social links. The sample posts and changelog entries are the
design's copy; replace or delete them.

## Tooling notes

- `pnpm --filter @proof/site typecheck` runs `astro sync && tsc`. `astro check` is not used: it
  needs TypeScript 5 or 6, and the repo is on 7. `.astro` files are therefore not type-checked,
  which is another reason to keep them thin.
- Tests server-render each component with `renderToStaticMarkup` (as Astro does) and run
  `expectNoA11yViolations` on it.
- Run by an agent, `astro dev` and `astro preview` detach into the background; stop them with
  `astro dev stop` / `astro preview stop`. Run by a person they stay in the foreground.
