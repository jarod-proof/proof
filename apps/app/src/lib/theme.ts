import { useEffect, useSyncExternalStore } from "react"

/** localStorage key. `src/theme-boot.js` reads the same key before first paint: keep them equal. */
export const THEME_STORAGE_KEY = "proof.theme"

export type ThemeChoice = "light" | "dark" | "system"

const CHOICES: readonly ThemeChoice[] = ["light", "dark", "system"]
const DARK_QUERY = "(prefers-color-scheme: dark)"

/** The stored choice, or "system" when nothing is stored, storage is blocked, or the value is unknown. */
export function readThemeChoice(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY)
    return CHOICES.includes(value as ThemeChoice) ? (value as ThemeChoice) : "system"
  } catch {
    return "system" // private windows and blocked site data throw on access
  }
}

function writeThemeChoice(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice)
  } catch {
    // Not persisted: the choice still applies for this page view.
  }
}

/** Whether the page is dark for a choice. System follows the OS setting. */
export function isDark(choice: ThemeChoice, systemPrefersDark: boolean): boolean {
  return choice === "dark" || (choice === "system" && systemPrefersDark)
}

function systemPrefersDark(): boolean {
  if (typeof window.matchMedia !== "function") return false
  return window.matchMedia(DARK_QUERY).matches
}

/** The explicit choice that flips what the page shows now: "system" on a dark OS toggles to light. */
export function toggledTheme(choice: ThemeChoice): ThemeChoice {
  return isDark(choice, systemPrefersDark()) ? "light" : "dark"
}

/** Sets or clears the `.dark` class on <html>, which styles.css keys its dark tokens on. */
export function applyTheme(choice: ThemeChoice): void {
  document.documentElement.classList.toggle("dark", isDark(choice, systemPrefersDark()))
}

// One store for the whole page: the user menu, the palette and the root all show the same choice.
const listeners = new Set<() => void>()
let current: ThemeChoice = "system"
let initialised = false

function init(): void {
  if (initialised || typeof window === "undefined") return
  initialised = true
  current = readThemeChoice()
}

function emit(): void {
  for (const listener of listeners) listener()
}

export function getThemeChoice(): ThemeChoice {
  init()
  return current
}

export function setThemeChoice(choice: ThemeChoice): void {
  init()
  current = choice
  writeThemeChoice(choice)
  applyTheme(choice)
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The stored theme choice, live across components. Server and first client render use "system". */
export function useThemeChoice(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const choice = useSyncExternalStore(subscribe, getThemeChoice, () => "system" as ThemeChoice)
  return [choice, setThemeChoice]
}

/**
 * Keeps the page's dark class in step with the choice, and with the OS setting while the choice is
 * "system". Mounted once at the root.
 */
export function useThemeSync(): void {
  // The hook's value is the server snapshot ("system") during hydration, which would undo the class
  // theme-boot.js set. So the effect reads the store itself, and re-runs when the choice changes.
  const [choice] = useThemeChoice()
  useEffect(() => {
    const current = getThemeChoice()
    applyTheme(current)
    if (current !== "system" || typeof window.matchMedia !== "function") return
    const media = window.matchMedia(DARK_QUERY)
    const onChange = () => applyTheme("system")
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [choice])
}
