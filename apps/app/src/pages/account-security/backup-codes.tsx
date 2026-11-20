import { useState } from "react"

import { Button } from "@proof/ui/components/ui/button"
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@proof/ui/components/ui/dialog"

// The sections of the Security page (board Security). Each takes its data and callbacks as props.
// Errors a call throws are shown in the section; the container has already mapped their copy.

export const BACKUP_CODE_COUNT = 10

export function BackupCodesView({
  title,
  description,
  codes,
  onDone,
}: {
  title: string
  description: string
  codes: string[]
  onDone: () => void
}) {
  const text = codes.join("\n")
  const [copied, setCopied] = useState(false)
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <ul aria-label="Backup codes" className="grid grid-cols-2 gap-2 font-mono text-sm">
        {codes.map((code) => (
          <li key={code} className="rounded-md border border-border px-2 py-1.5">
            {code}
          </li>
        ))}
      </ul>
      <DialogFooter>
        <Button
          variant="outline"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text)
              setCopied(true)
            } catch {
              setCopied(false)
            }
          }}
        >
          {copied ? "Copied" : "Copy codes"}
        </Button>
        <Button onClick={onDone}>I've saved them</Button>
      </DialogFooter>
    </>
  )
}
