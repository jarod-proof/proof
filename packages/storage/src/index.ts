// Uploaded files (avatars, organization logos), in the store the deployment chooses: S3, Cloudflare
// R2, Vercel Blob, or a local directory. Reads no env itself: apps/api builds the config from
// @proof/env (STORAGE_DRIVER and friends, docs/storage.md).
import { createLocalStore, createMemoryStore, type LocalConfig, type MemoryConfig } from "./local"
import { createS3Store, type R2Config, type S3Config } from "./s3"
import type { FileStore } from "./store"
import { createVercelBlobStore, type VercelBlobConfig } from "./vercel-blob"

export { decodeImage, IMAGE_TYPES, type ImageType, imageTypeOf, MAX_IMAGE_BYTES } from "./image"
export { createLocalStore, createMemoryStore, type LocalConfig, type MemoryConfig } from "./local"
export { createS3Store, type R2Config, type S3Config } from "./s3"
export {
  contentTypeOfKey,
  type FileStore,
  IMMUTABLE,
  isFileKey,
  newFileKey,
  organizationFilesPrefix,
  type PrefixDeletion,
  personFilesPrefix,
  type StorageDriver,
  type StoredFile,
} from "./store"
export { createVercelBlobStore, type VercelBlobConfig } from "./vercel-blob"

export type FileStoreConfig = S3Config | R2Config | VercelBlobConfig | LocalConfig | MemoryConfig

/** The store a config names. */
export function createFileStore(config: FileStoreConfig): FileStore {
  switch (config.driver) {
    case "s3":
    case "r2":
      return createS3Store(config)
    case "vercel-blob":
      return createVercelBlobStore(config)
    case "local":
      return createLocalStore(config)
    case "memory":
      return createMemoryStore(config)
  }
}
