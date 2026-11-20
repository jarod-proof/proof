import { useId, useRef, useState } from "react"

import { Button } from "@proof/ui/components/ui/button"
import { FieldDescription } from "@proof/ui/components/ui/field"

import { messageOf } from "../lib/messages"

/** What the server accepts (get_upload_limits), or null while uploads are off on this server. */
export interface ImageUploadLimits {
  maxBytes: number
  contentTypes: readonly string[]
}

const TYPE_NAMES: Record<string, string> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
  "image/gif": "GIF",
}

/** "PNG, JPEG, WebP or GIF" */
function typesText(limits: ImageUploadLimits): string {
  const names = limits.contentTypes.map((type) => TYPE_NAMES[type] ?? type)
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : (names[0] ?? "")
}

/** "1 MB" */
function sizeText(limits: ImageUploadLimits): string {
  const mb = limits.maxBytes / 1024 / 1024
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
}

/** "PNG, JPEG, WebP or GIF, up to 1 MB", for the hint under the buttons. */
export const describeLimits = (limits: ImageUploadLimits) =>
  `${typesText(limits)}, up to ${sizeText(limits)}`

/** Why a picked file can't be sent, checked before the upload; null when it can. */
export function refusalOf(file: { type: string; size: number }, limits: ImageUploadLimits) {
  if (!limits.contentTypes.includes(file.type)) return `Choose a ${typesText(limits)} image.`
  if (file.size > limits.maxBytes) return `Choose an image of ${sizeText(limits)} or less.`
  return null
}

export interface ImageUploadProps {
  /**
   * Shown, the board's row: the label over the hint, the buttons on the right (the org logo).
   * Omitted, the buttons over the hint (the profile photo).
   */
  label?: string
  /** The upload button's text, e.g. "Upload photo". */
  uploadLabel: string
  /** The remove button's text, e.g. "Use initials". Shown while there is an image. */
  removeLabel: string
  hasImage: boolean
  /** Null while uploads are off on this server: the buttons are disabled with `offReason`. */
  limits: ImageUploadLimits | null
  offReason: string
  /** What the image should be, before the accepted types ("Square, at least 128px."). */
  guidance: string
  onUpload: (file: File) => Promise<void>
  onRemove: () => Promise<void>
}

/** An upload and a remove button for one image (an avatar, a logo), with the limits and any failure. */
export function ImageUpload({
  label,
  uploadLabel,
  removeLabel,
  hasImage,
  limits,
  offReason,
  guidance,
  onUpload,
  onRemove,
}: ImageUploadProps) {
  const input = useRef<HTMLInputElement>(null)
  const descriptionId = useId()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const run = async (task: () => Promise<void>) => {
    setBusy(true)
    setFailure(null)
    try {
      await task()
    } catch (caught) {
      setFailure(messageOf(caught))
    } finally {
      setBusy(false)
    }
  }

  const picked = (file: File | undefined) => {
    if (!file || !limits) return
    const refusal = refusalOf(file, limits)
    if (refusal) {
      setFailure(refusal)
      return
    }
    void run(() => onUpload(file))
  }

  const fileInput = (
    <input
      ref={input}
      type="file"
      hidden
      accept={limits?.contentTypes.join(",")}
      onChange={(event) => {
        picked(event.currentTarget.files?.[0])
        // The same file can be picked again after a failure.
        event.currentTarget.value = ""
      }}
    />
  )
  // The board's row uses 40px buttons beside the hint; the stacked layout keeps the default size.
  const buttonClass = label ? "h-10" : undefined
  const buttons = (
    <>
      <Button
        type="button"
        variant="outline"
        className={buttonClass}
        disabled={!limits || busy}
        aria-describedby={descriptionId}
        onClick={() => input.current?.click()}
      >
        {busy ? "Saving…" : uploadLabel}
      </Button>
      {hasImage ? (
        <Button
          type="button"
          variant="outline"
          className={buttonClass}
          disabled={busy}
          aria-describedby={descriptionId}
          onClick={() => void run(onRemove)}
        >
          {removeLabel}
        </Button>
      ) : null}
    </>
  )
  const description = limits ? `${guidance} ${describeLimits(limits)}.` : offReason
  const alert = failure ? (
    <p role="alert" className="basis-full text-sm text-destructive">
      {failure}
    </p>
  ) : null

  if (label) {
    return (
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-3.5">
        {fileInput}
        <div className="flex min-w-48 flex-1 flex-col">
          <span className="text-sm font-semibold">{label}</span>
          <span id={descriptionId} className="text-[13.5px] text-muted-foreground">
            {description}
          </span>
          {alert}
        </div>
        <div className="flex gap-2">{buttons}</div>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-2">
      {fileInput}
      {buttons}
      <FieldDescription id={descriptionId} className="basis-full">
        {description}
      </FieldDescription>
      {alert}
    </div>
  )
}
