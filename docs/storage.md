# File storage

Uploads are a person's **avatar** (`user.image`) and an organization's **logo**
(`organization.logo`). They go to the **file store** (GLOSSARY) that `STORAGE_DRIVER` picks:

| `STORAGE_DRIVER` | Where files live | Served from |
|---|---|---|
| unset | nowhere: uploads are off, and the buttons say so | — |
| `local` | a directory on the API's disk (`STORAGE_LOCAL_DIR`, default `.storage`) | the API, `GET /files/*` |
| `s3` | an S3 bucket, or anything S3-compatible (MinIO) | the bucket URL, or `STORAGE_PUBLIC_URL` (CloudFront) |
| `r2` | a Cloudflare R2 bucket | `STORAGE_PUBLIC_URL` (r2.dev or a custom domain) |
| `vercel-blob` | a Vercel Blob store | `https://<store>.public.blob.vercel-storage.com` |

Change the store by changing the env. No code changes. `@proof/env` refuses to start when a
chosen driver is missing a variable, and the error names the variable. `.env.example` lists them
all.

## How an upload works

1. The browser reads the file and sends it base64-encoded to an operation:
   - `set_organization_logo` and `remove_organization_logo` (`organization:update`, so owners and
     admins). An agent with the `admin` scope can call them too.
   - `set_my_avatar` and `remove_my_avatar` (`auth: "person"`: the web app's session only, never an
     API key or OAuth token, and not MCP tools).
2. The API decodes it and reads its type from its bytes, not from the name or the claimed type. It
   accepts only PNG, JPEG, WebP and GIF, up to 1 MB (`MAX_IMAGE_BYTES` in `@proof/storage`). SVG
   is refused because it can carry script and the files are public. A request body over 2 MB is
   refused before it is read (`MAX_BODY_BYTES` in `apps/api/src/app.ts`).
3. It stores the file under a new random key, such as `org/<id>/logo-<32 hex>.png`. Files never
   change, so they are cached for a year.
4. It records the public URL on the row, then deletes the file it replaced. It only deletes files
   from its own store: a GitHub or Google avatar from social sign-in is left alone.

`get_upload_limits` tells the web app (and agents) whether uploads are on and what they accept. When
uploads are off, the upload operations answer CONFLICT with a hint.

The bytes always pass through the API, so every driver works the same way, the server can check
every file, and no bucket needs CORS. Avatars and logos are small, so the extra hop is cheap. Send
big files (attachments, exports) to the bucket directly with presigned URLs instead. See the
roadmap.

## Setting up each store

### local

For development and single-server setups. Set `STORAGE_DRIVER=local`. Files go in `.storage/`
(git-ignored) and the API serves them at `<API URL>/files/...` with `nosniff` and a `default-src
'none'` CSP. A container's disk is usually thrown away on redeploy, so use a volume, or another
driver, in production. The API logs a warning when `local` runs with `NODE_ENV=production`.

### s3

1. Create a bucket, with no dots in its name: the virtual-hosted URL
   (`https://<bucket>.s3.<region>.amazonaws.com`) has no TLS certificate for a dotted name. Make its
   objects publicly readable: either a bucket policy allowing `s3:GetObject` on
   `arn:aws:s3:::<bucket>/*` (with Block Public Access turned off for it), or a CloudFront
   distribution in front of it with origin access control. With CloudFront, set
   `STORAGE_PUBLIC_URL` to its domain.
2. Create an IAM user (or role) with `s3:PutObject` and `s3:DeleteObject` on
   `arn:aws:s3:::<bucket>/*`, and `s3:ListBucket` on `arn:aws:s3:::<bucket>` (the bucket ARN, not
   `/*`). The sweep on deletion lists a prefix before deleting it.
3. Set `STORAGE_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`.
   `S3_SESSION_TOKEN` is for temporary credentials. The driver signs requests itself (aws4fetch), so
   it does not read the AWS credential chain. Pass the keys explicitly.

For MinIO or LocalStack, set `S3_ENDPOINT` (for example `http://localhost:9000`). Requests and
default URLs are then path-style: `<endpoint>/<bucket>/<key>`.

### r2

1. Create an R2 bucket in no jurisdiction (the default). Turn on public access: under the bucket's
   Settings, either the r2.dev subdomain (rate-limited, for development only) or a custom domain
   (for production).
2. Create an R2 API token with Object Read & Write on that bucket. Its S3 credentials are the
   access key id and secret access key. That permission includes listing, which the sweep on
   deletion needs.
3. Set `STORAGE_BUCKET`, `STORAGE_PUBLIC_URL` (the r2.dev URL or your domain), `R2_ACCOUNT_ID`,
   `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.

R2 speaks the S3 API, so this is the `s3` driver pointed at
`https://<account>.r2.cloudflarestorage.com` with region `auto`. A bucket made in an EU or US
jurisdiction needs its own endpoint (`<account>.eu.r2.cloudflarestorage.com`), which this driver
does not use, so keep the bucket out of a jurisdiction.

### vercel-blob

1. Create a Blob store in the Vercel dashboard (Storage) and connect it to the project. Vercel sets
   `BLOB_READ_WRITE_TOKEN` for you. Locally, `vercel env pull` fetches it.
2. Set `STORAGE_DRIVER=vercel-blob`.

The store's public host comes from the token. `@vercel/blob` is only imported when this driver is
picked. The driver needs the token itself: OIDC variables alone (`BLOB_STORE_ID`) are not enough.
The read-write token also covers `list`, which the sweep on deletion uses.

## When an organization or person is deleted

Their files go too. Every key for an organization starts `org/<id>/` and every key for a person
`user/<id>/` (`organizationFilesPrefix` and `personFilesPrefix` in `@proof/storage`; uploads
build their keys on them). When one is deleted, the API removes everything under that prefix with
`FileStore.deletePrefix`, including files no row points at any more (`apps/api/src/file-sweep.ts`).

- It runs only after the row is deleted: auth reports the deletion through `onDeleted`
  (`databaseHooks.user.delete.after`, and `afterDeleteOrganization`). Self-delete also sweeps the
  personal organization it removes. Admin removal of a person sweeps only their own files: it
  leaves the personal organization behind (see the roadmap).
- It is best effort. A failure is reported (`reportError`) and logged, and the deletion still
  succeeds. The files of a failed sweep stay, as orphans.
- Each sweep logs the prefix and how many files it removed at info level.
- `deletePrefix` accepts only `org/<id>/` or `user/<id>/`. The S3 and Vercel Blob drivers delete
  only listed keys that are plain file keys under the prefix and count the rest as skipped; the API
  logs a warning with that count. A listing that repeats its cursor, or runs past 1,000 pages
  (`MAX_LIST_PAGES`), stops the sweep with an error.
- On S3 it lists the prefix first, so the credentials need `s3:ListBucket` (see "s3" above). Without
  it, the first sweep fails with a 403 that is logged.

## The web app's CSP

Pages are served with a CSP whose `img-src` lists `'self'`, the file store's origin, and the GitHub
or Google avatar host when that sign-in is configured (`imageOrigins` in `apps/api/src/server.ts`).
If you put a CDN in front of the store, set `STORAGE_PUBLIC_URL` to it. That way the URLs and the
CSP use the same origin.

## Adding another kind of upload

- Add an operation beside the others in `apps/api/src/operations/uploads.ts`. Use `replaceImage`
  with a key prefix of its own, and record the URL through a data function in
  `apps/api/src/data/uploads.ts` (one that takes a proof when the row is tenant data).
- For another file type, add its magic bytes beside `imageTypeOf` in `@proof/storage`. Never
  trust the type the client claims.
- Build the key prefix on `organizationFilesPrefix` or `personFilesPrefix`, or the sweep on
  deletion misses the files.
- A new store is a `FileStore` (`packages/storage/src/store.ts`): `put`, `delete` (ignoring URLs the
  store did not issue), `deletePrefix` (guarded by `assertFilesPrefix`) and `origin`, plus a case in
  `createFileStore` and `apps/api/src/server.ts`, and its variables in `packages/env`.
