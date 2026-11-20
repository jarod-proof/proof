# UI: vendored shadcn, D+ pieces and stories

## Vendored components

- `@shadcn/lint` is registered with no rules enabled. Add rules in `.oxlintrc.json`.

- `packages/ui/src/components/ui/` (60 components) and `src/hooks/` come from the shadcn CLI, style
  **`base-sera`** (Base UI primitives via `@base-ui/react`, lucide icons), set in
  `packages/ui/components.json`.
- Add new ones with `cd packages/ui && npx shadcn@latest add <name>`. Never hand-write a clone.
- They are restyled by hand to the D+ design system. The tokens are in `styles.css`: warm paper and
  ink, the `solar` "needs you" accent, `success`, and the `highlight` and `hatch` utilities. The
  rules: 8px radius, sentence case, 2px ink borders on buttons, boxed 1.5px inputs, 44px default
  targets, dashed borders for disabled, red outline for destructive, flat 2px-outlined menus.
- `add --overwrite` replaces that styling with base-sera's. After an update, re-apply the D+ classes
  (diff against git) rather than keeping upstream's. Restyle a newly added component the same way.
- `npx shadcn@latest apply` does not work here (it needs a detected framework). Change `style` in
  `packages/ui/components.json` and `add` the components instead.
- The registry's `form` is an empty stub for this style, so forms use `Field` and `FieldGroup`.
- Base UI uses a `render` prop where Radix used `asChild`.
- `sonner` pulls in `next-themes` for theming. It works without Next, but it needs a theme provider
  to follow dark mode.
- `add` may flip `"use client"` directives in existing components. That is harmless here.

## styles.css

`styles.css` must keep `@import "tw-animate-css"` and `@import "shadcn/tailwind.css"`. Without them
Tailwind silently drops the `data-open:` and `data-closed:` variants and the `animate-in` and
`animate-out` utilities, and typecheck won't notice. Rebuild Storybook and check the CSS if you
touch them. baseline allows `bg-black/20`, the overlay scrim used by dialog, sheet and drawer.

## D+ pieces

Pieces shadcn has no equivalent for live in `packages/ui/src/dplus` (`Status`, `Meter`, `OrgMark`,
`QrCode`), and the presentational app shell in `src/dplus/shell` (`@proof/ui/dplus/shell/<name>`).
They are tested and count toward coverage.

`src/dplus/pages/*.stories.tsx` rebuild the design boards (design system, run view, sidebar, org
general, create organization) from the real components, in light and dark. Check them after any UI
change. They get smoke tests (`all.test.tsx`, `examples.test.tsx`), not coverage thresholds.

## Stories

- Every component has a story that renders shadcn's own example for `base-sera`
  (`src/components/examples/<name>-example.tsx`, installed with
  `npx shadcn@latest add <name>-example --overwrite`).
- After adding examples, run `pnpm stories`. It moves them from `src/components/`, where shadcn
  writes them, into `examples/`. It writes missing `ui/<name>.stories.tsx` files (never overwriting
  existing ones) and sanitizes the demos.
- The demos assume Next. The script points `next/image` and `next/link` at
  `components/examples/example-compat.tsx`, and applies three exact-string patches for
  `noUncheckedIndexedAccess`.
- `message` and `message-scroller` have no example: their demos need the Vercel AI SDK. `direction`
  has none upstream.
- `examples.test.tsx` server-renders every example. Demos are excluded from baseline and coverage.
- The shadcn demos are not swept by the a11y helper: about half have axe violations in shadcn's own
  demo content.
- Storybook's a11y panel is a dev aid only. Nothing fails CI on it.
