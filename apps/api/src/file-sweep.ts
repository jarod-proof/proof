// Deleting an organization or a person removes their files (docs/storage.md, "When an organization
// or person is deleted"). Auth reports each deletion once its row is gone (createAuth's onDeleted);
// this sweeps everything under the matching prefix, orphans included. Auth reports a throw from
// here and never fails the deletion for it.
import type { DeletedEvent } from "@proof/auth"
import type { Logger } from "@proof/logger"
import { type FileStore, organizationFilesPrefix, personFilesPrefix } from "@proof/storage"

/** The onDeleted callback: sweeps the deleted organization's or person's files from `files`. */
export function fileSweep(
  files: FileStore | undefined,
  logger: Logger,
): (event: DeletedEvent) => Promise<void> {
  return async (event) => {
    if (!files) return
    const prefix =
      "userId" in event
        ? personFilesPrefix(event.userId)
        : organizationFilesPrefix(event.organizationId)
    // Looked up at call time, not destructured above, so a test can wrap the store's method.
    const { deleted, skipped } = await files.deletePrefix(prefix)
    logger.info({ prefix, deleted, skipped }, "swept a deleted owner's files")
    // A listed key the store refused to delete: outside the prefix, or not a plain file key.
    if (skipped > 0) logger.warn({ prefix, skipped }, "the file store listed keys it may not sweep")
  }
}
