import { createClient } from "@proof/auth/client"

import type { BillingAdapter } from "./adapter"
import { fixtureBillingAdapter } from "./fixture"
import { createStripeBillingAdapter } from "./stripe"

type Client = ReturnType<typeof createClient>

/**
 * The adapter the server's `GET /api/auth/sign-in-methods` answer selects: Stripe only when the server
 * reports `stripe: true`, the fixture for any other successful answer. Null when the call failed (an
 * error, a throw or no body), which is not an answer at all.
 */
async function adapterFromServer(
  client: Client,
  options: { returnUrl?: () => string },
): Promise<BillingAdapter | null> {
  try {
    const result = await client.signInMethods()
    if (result.error || !result.data) return null
    if (result.data.stripe !== true) return fixtureBillingAdapter
    return createStripeBillingAdapter(client, options)
  } catch {
    return null
  }
}

/**
 * Chooses the billing adapter from the server's `GET /api/auth/sign-in-methods` answer: the Stripe
 * adapter only when the server reports `stripe: true`. A failed call, a missing flag or an
 * unexpected body all fall back to the fixture, so the page always has something honest to show.
 */
export async function chooseBillingAdapter(
  client: Client,
  options: { returnUrl?: () => string } = {},
): Promise<BillingAdapter> {
  return (await adapterFromServer(client, options)) ?? fixtureBillingAdapter
}

/**
 * The adapter, chosen once per browser session through the client `makeClient` returns. A failed
 * check is not kept as the fixture: the call rejects, and the next call asks the server again.
 */
export function billingAdapterOnce(makeClient: () => Client): () => Promise<BillingAdapter> {
  let shared: Promise<BillingAdapter> | undefined
  return () => {
    shared ??= adapterFromServer(makeClient(), {}).then((adapter) => {
      if (adapter) return adapter
      shared = undefined
      throw new Error("Could not check how billing is set up. Try again.")
    })
    return shared
  }
}

/** The page's adapter, asked of the page's own origin. */
export const getBillingAdapter = billingAdapterOnce(() =>
  createClient(typeof window === "undefined" ? undefined : window.location.origin),
)
