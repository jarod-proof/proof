import type { PaletteGroup } from "@proof/ui/dplus/shell/command-palette"

import type { ThemeChoice } from "../lib/theme"
import type { WebOrganization } from "../lib/web-auth"

// Palette item ids encode the action: "go:<path>" navigates, "theme:<choice>" sets the theme.
export const goId = (href: string) => `go:${href}`
export const themeId = (choice: ThemeChoice) => `theme:${choice}`

export type PaletteContext = {
  /** The organization the page is in, or null when there is none to link to. */
  current: WebOrganization | null
  organizations: WebOrganization[]
}

/** The palette's groups: navigation for the current org, the orgs to switch to, actions, theme. */
export function paletteGroups({ current, organizations }: PaletteContext): PaletteGroup[] {
  const navigation = current
    ? [
        { id: goId(`/${current.slug}`), label: "Home" },
        { id: goId(`/${current.slug}/settings/agents`), label: "Agents" },
        { id: goId(`/${current.slug}/settings/general`), label: "Organization settings" },
      ]
    : []
  return [
    {
      heading: "Navigation",
      items: [...navigation, { id: goId("/account/profile"), label: "Account" }],
    },
    {
      heading: "Organizations",
      items: organizations.map((org) => ({
        id: goId(`/${org.slug}`),
        label: `Switch to ${org.name}`,
      })),
    },
    {
      heading: "Actions",
      items: [{ id: goId("/new"), label: "Create organization" }],
    },
    {
      heading: "Theme",
      items: [
        { id: themeId("light"), label: "Light theme" },
        { id: themeId("dark"), label: "Dark theme" },
        { id: themeId("system"), label: "System theme" },
      ],
    },
  ]
}

export type PaletteAction =
  | { kind: "navigate"; href: string }
  | { kind: "theme"; choice: ThemeChoice }

/** Decodes a palette id. Unknown ids are ignored (null). */
export function paletteAction(id: string): PaletteAction | null {
  if (id.startsWith("go:")) return { kind: "navigate", href: id.slice(3) }
  if (id.startsWith("theme:")) {
    const choice = id.slice(6)
    if (choice === "light" || choice === "dark" || choice === "system")
      return { kind: "theme", choice }
  }
  return null
}
