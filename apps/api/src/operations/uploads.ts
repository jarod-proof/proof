import { AppError, reportError } from "@proof/errors"
import {
  decodeImage,
  type FileStore,
  IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  newFileKey,
  organizationFilesPrefix,
  personFilesPrefix,
} from "@proof/storage"
import { z } from "zod"

import { setOrganizationLogo, setOwnAvatar } from "../data/uploads"
import { inCallerOrg } from "../tenant"
import { defineOperation, type OperationDeps, requirePerson } from "./shared"

/** A 1x1 transparent PNG: the examples' upload. */
const EXAMPLE_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

// Base64 of MAX_IMAGE_BYTES, plus room for a data: URL prefix and line breaks. decodeImage checks the
// decoded size exactly; this only stops a huge string before it is decoded.
const imageInput = z
  .string()
  .min(1)
  .max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1024)
  .describe(
    `The image file, base64-encoded (a data: URL also works). PNG, JPEG, WebP or GIF, at most ` +
      `${MAX_IMAGE_BYTES / 1024 / 1024} MB; the type is read from the bytes. A square of 256 to 512 pixels is plenty.`,
  )

/** The file store, or CONFLICT when this server has none (STORAGE_DRIVER unset). */
function storeOf(files: FileStore | undefined): FileStore {
  if (files) return files
  throw new AppError("CONFLICT", "Uploads are off on this server", {
    hint: "No file store is configured (STORAGE_DRIVER). get_upload_limits says whether uploads are on.",
  })
}

/**
 * The key prefix of an organization's logo and of a person's avatar: every file they get starts so.
 * Built on the store's directory helpers, which the sweep on deletion removes (file-sweep.ts).
 */
const logoPrefix = (orgId: string) => `${organizationFilesPrefix(orgId)}logo`
const avatarPrefix = (userId: string) => `${personFilesPrefix(userId)}avatar`

/**
 * Whether `url` is a file stored under `prefix`. The row's URL can be set by better-auth's own update
 * endpoints to any string, so one may be another organization's or person's file: the store only
 * checks that it is its own, not whose. Deleting a replaced URL needs both checks.
 */
function isOwnFile(url: string, prefix: string): boolean {
  let path: string
  try {
    path = decodeURIComponent(new URL(url).pathname)
  } catch {
    return false
  }
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|/)${escaped}-[0-9a-f]{32}\\.(png|jpg|webp|gif)$`).test(path)
}

/**
 * Stores the image, points the row at it with `record`, then removes the file it replaced. A failure
 * to record removes the new file again; a failure to remove an old one is reported, never returned.
 */
async function replaceImage(
  files: FileStore,
  prefix: string,
  image: string,
  record: (url: string) => Promise<{ previous: string | null }>,
): Promise<string> {
  const { bytes, contentType } = decodeImage(image)
  const url = await files.put(newFileKey(prefix, contentType), bytes, contentType)
  let previous: string | null
  try {
    ;({ previous } = await record(url))
  } catch (error) {
    await files.delete(url).catch((cleanup: unknown) => reportError(cleanup, { phase: "upload" }))
    throw error
  }
  if (previous && isOwnFile(previous, prefix)) await removeSafely(files, previous)
  return url
}

/** Removes a replaced file. Only the store's own files are touched (not a GitHub avatar). */
async function removeSafely(files: FileStore | undefined, url: string): Promise<void> {
  try {
    await files?.delete(url)
  } catch (error) {
    reportError(error, { phase: "upload" })
  }
}

export function uploadOperations({ db, files }: Pick<OperationDeps, "db" | "files">) {
  const get_upload_limits = defineOperation({
    name: "get_upload_limits",
    method: "GET",
    path: "/v1/uploads/limits",
    summary: "Show whether uploads are on, and what an upload may be",
    description:
      "Returns whether this server stores uploads (organization logos, avatars) and the size and " +
      "types an image may be. Check it before set_organization_logo when unsure.",
    permissions: {},
    input: z.object({}),
    output: z.object({
      enabled: z.boolean().describe("False when the server has no file store: uploads are refused"),
      maxBytes: z.number().int().describe("The largest image accepted, in bytes"),
      contentTypes: z.array(z.string()).describe("The image types accepted"),
    }),
    hints: { readOnly: true, idempotent: true },
    examples: [{ input: {} }],
    handler: async () => ({
      enabled: files !== undefined,
      maxBytes: MAX_IMAGE_BYTES,
      contentTypes: [...IMAGE_TYPES],
    }),
  })

  const logoOutput = z.object({
    logo: z
      .string()
      .nullable()
      .describe("The logo's public URL; null shows the name's first letter"),
  })

  const set_organization_logo = defineOperation({
    name: "set_organization_logo",
    method: "PUT",
    path: "/v1/organization/logo",
    summary: "Upload the organization's logo",
    description:
      "Stores the image and makes it the caller's organization's logo, replacing any earlier one. " +
      "Returns the logo's public URL. Send a square image. CONFLICT means uploads are off on this server.",
    permissions: { organization: ["update"] },
    hints: { readOnly: false, destructive: true },
    input: z.object({ image: imageInput }),
    output: logoOutput,
    examples: [{ input: { image: EXAMPLE_PNG } }],
    handler: ({ image }, { caller }) =>
      inCallerOrg(caller, async (org, proof) => {
        const store = storeOf(files)
        const logo = await replaceImage(store, logoPrefix(org.value), image, (url) =>
          setOrganizationLogo(db, org, proof, url),
        )
        return { logo }
      }),
  })

  const remove_organization_logo = defineOperation({
    name: "remove_organization_logo",
    method: "DELETE",
    path: "/v1/organization/logo",
    summary: "Remove the organization's logo",
    description:
      "Clears the caller's organization's logo, so the name's first letter shows instead, and " +
      "deletes the stored file. Ask the user first: the image is not kept.",
    permissions: { organization: ["update"] },
    input: z.object({}),
    output: logoOutput,
    hints: { readOnly: false, destructive: true, idempotent: true },
    examples: [{ input: {}, output: { logo: null } }],
    handler: (_input, { caller }) =>
      inCallerOrg(caller, async (org, proof) => {
        const { previous } = await setOrganizationLogo(db, org, proof, null)
        if (previous && isOwnFile(previous, logoPrefix(org.value))) {
          await removeSafely(files, previous)
        }
        return { logo: null }
      }),
  })

  const avatarOutput = z.object({
    image: z.string().nullable().describe("The avatar's public URL; null shows the initials"),
  })

  const set_my_avatar = defineOperation({
    name: "set_my_avatar",
    method: "PUT",
    path: "/v1/me/avatar",
    summary: "Upload your own avatar",
    description:
      "Stores the image as the signed-in person's avatar, in every organization they belong to. " +
      "Only a person in the web app can set it: API keys and AI clients get FORBIDDEN.",
    // Any person, about themselves: never a key or token (invoke checks; requirePerson gives the id).
    auth: "person",
    permissions: {},
    input: z.object({ image: imageInput }),
    output: avatarOutput,
    examples: [{ input: { image: EXAMPLE_PNG } }],
    handler: async ({ image }, { caller }) => {
      const userId = requirePerson(caller)
      const store = storeOf(files)
      const url = await replaceImage(store, avatarPrefix(userId), image, (stored) =>
        setOwnAvatar(db, userId, stored),
      )
      return { image: url }
    },
  })

  const remove_my_avatar = defineOperation({
    name: "remove_my_avatar",
    method: "DELETE",
    path: "/v1/me/avatar",
    summary: "Remove your own avatar",
    description:
      "Clears the signed-in person's avatar, so their initials show instead. Only a person in the " +
      "web app can: API keys and AI clients get FORBIDDEN.",
    auth: "person",
    permissions: {},
    input: z.object({}),
    output: avatarOutput,
    hints: { destructive: true, idempotent: true },
    examples: [{ input: {}, output: { image: null } }],
    handler: async (_input, { caller }) => {
      const userId = requirePerson(caller)
      const { previous } = await setOwnAvatar(db, userId, null)
      if (previous && isOwnFile(previous, avatarPrefix(userId))) await removeSafely(files, previous)
      return { image: null }
    },
  })

  return {
    get_upload_limits,
    set_organization_logo,
    remove_organization_logo,
    set_my_avatar,
    remove_my_avatar,
  }
}
