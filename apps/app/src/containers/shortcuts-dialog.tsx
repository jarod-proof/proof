import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@proof/ui/components/ui/dialog"
import { Shortcut } from "@proof/ui/dplus/shell/shortcut"
import { type ModifierKeyLabel, modifierKeyLabel } from "../lib/platform"

/**
 * The `?` list: every key the shell binds, shown with the same keycaps the palette uses. The palette
 * row shows this platform's modifier (⌘ or Ctrl); both are bound, see `useShellHotkeys`.
 */
export function shellShortcuts(
  modifier: ModifierKeyLabel,
): Array<{ label: string; keys: string[] }> {
  return [
    { label: "Go to home", keys: ["G", "H"] },
    { label: "Go to agents", keys: ["G", "A"] },
    { label: "Go to organization settings", keys: ["G", "O"] },
    { label: "Open the command palette", keys: [modifier, "K"] },
    { label: "Toggle light and dark theme", keys: ["D"] },
    { label: "Use the system theme", keys: ["Shift", "D"] },
    { label: "Show this list", keys: ["?"] },
  ]
}

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const shortcuts = shellShortcuts(modifierKeyLabel())
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Shortcuts don't fire while you are typing in a field.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-3">
          {shortcuts.map((shortcut) => (
            <li key={shortcut.label} className="flex items-center justify-between gap-4">
              <span>{shortcut.label}</span>
              <Shortcut keys={shortcut.keys} />
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
