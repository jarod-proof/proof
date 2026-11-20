import { AppError } from "@proof/errors"

/** The image types an upload may be. No SVG: it can carry script, and the files are public. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const
export type ImageType = (typeof IMAGE_TYPES)[number]

/** The largest image an upload may be, in bytes (decoded). */
export const MAX_IMAGE_BYTES = 1024 * 1024

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  prefix.every((b, i) => bytes[at + i] === b)
const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0))

/** The image type the bytes are, read from their magic numbers (never from a claimed type), or null. */
export function imageTypeOf(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif"
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp"
  return null
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const DATA_URL = /^data:[\w.+-]+\/[\w.+-]+;base64,/

/**
 * An uploaded image from its base64 text (or a `data:` URL, as a browser's FileReader gives it):
 * the bytes and the type they really are. Anything else, or anything over MAX_IMAGE_BYTES, is a
 * BAD_REQUEST that says what to send instead.
 */
export function decodeImage(text: string): {
  bytes: Uint8Array<ArrayBuffer>
  contentType: ImageType
} {
  const base64 = text.replace(DATA_URL, "").replace(/\s+/g, "")
  if (base64.length % 4 !== 0 || !BASE64.test(base64)) {
    throw new AppError("BAD_REQUEST", "image must be base64", {
      hint: "Send the file's bytes base64-encoded (a data: URL also works).",
    })
  }
  const bytes = new Uint8Array(Buffer.from(base64, "base64"))
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new AppError("BAD_REQUEST", `The image is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB`, {
      hint: "Send a smaller image: a square of 256 to 512 pixels is plenty.",
    })
  }
  const contentType = imageTypeOf(bytes)
  if (!contentType) {
    throw new AppError("BAD_REQUEST", "The image is not a PNG, JPEG, WebP or GIF", {
      hint: "Convert it to PNG, JPEG, WebP or GIF. SVG is not accepted.",
    })
  }
  return { bytes, contentType }
}
