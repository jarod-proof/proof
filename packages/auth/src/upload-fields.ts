// better-auth takes any string for an organization's `logo` and a user's `image`, on its own
// endpoints. Uploads own those columns (apps/api uploads.ts): the file is stored, the row points at
// it, and the file it replaces is removed. Left open, a client could point its row at another
// tenant's file or at any URL. So an HTTP request that sets one is refused and sent to the upload
// operation. Clearing (null) stays allowed. Server-side calls have no request and pass: social
// sign-in creates its user through the internal adapter, and `auth.api.*` from server code runs
// without one.
import type { BetterAuthPlugin } from "better-auth"
import { APIError, createAuthMiddleware } from "better-auth/api"

/** The endpoints that write `logo` or `image`: org create and update, update-user, sign-up. */
export const UPLOAD_FIELD_PATHS = [
  "/organization/create",
  "/organization/update",
  "/update-user",
  "/sign-up/email",
] as const

export const USE_UPLOAD_CODE = "USE_UPLOAD_OPERATION"

// Clearing is allowed, so the messages say how to clear as well as how to set.
const ORGANIZATION_LOGO =
  "Set a logo with set_organization_logo (PUT /v1/organization/logo), not with logo. " +
  "To clear it, send null."
const USER_IMAGE =
  "Set a profile image with the set_my_avatar operation (PUT /v1/me/avatar), not image here. " +
  "To clear it, send null."

const isSet = (value: unknown) => value !== undefined && value !== null

/**
 * Why a body that reaches one of UPLOAD_FIELD_PATHS is refused, or undefined when it may pass.
 * `/organization/create` takes `logo` at the top level, `/organization/update` under `data`.
 */
export function uploadFieldRefusal(path: string | undefined, body: unknown): string | undefined {
  const fields = (body && typeof body === "object" ? body : {}) as Record<string, unknown>
  const data = (fields.data && typeof fields.data === "object" ? fields.data : {}) as Record<
    string,
    unknown
  >
  switch (path) {
    case "/organization/create":
      return isSet(fields.logo) ? ORGANIZATION_LOGO : undefined
    case "/organization/update":
      return isSet(data.logo) ? ORGANIZATION_LOGO : undefined
    case "/update-user":
    case "/sign-up/email":
      return isSet(fields.image) ? USER_IMAGE : undefined
    default:
      return undefined
  }
}

/**
 * Refuses the write over HTTP only: a request carries `request`, a server-side call does not. The
 * matcher reads `request` (set by the router) so `auth.api.*` from server code is never refused.
 */
export const uploadFieldGuard = {
  id: "proof-upload-fields",
  hooks: {
    before: [
      {
        matcher: (ctx: { path?: string; request?: unknown }) =>
          ctx.request !== undefined &&
          UPLOAD_FIELD_PATHS.includes(ctx.path as (typeof UPLOAD_FIELD_PATHS)[number]),
        handler: createAuthMiddleware(async (ctx) => {
          const message = uploadFieldRefusal(ctx.path, ctx.body)
          if (message) throw APIError.from("BAD_REQUEST", { message, code: USE_UPLOAD_CODE })
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin
