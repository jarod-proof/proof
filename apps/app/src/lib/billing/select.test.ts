import { describe, expect, it, vi } from "vitest"

import type { createClient } from "@proof/auth/client"

import { billingAdapterOnce, chooseBillingAdapter } from "./select"

type Client = ReturnType<typeof createClient>

function fakeClient(signInMethods: () => Promise<unknown>): Client {
  return { signInMethods, subscription: {} } as unknown as Client
}

describe("chooseBillingAdapter", () => {
  it("uses the stripe adapter when the server reports stripe mounted", async () => {
    const adapter = await chooseBillingAdapter(
      fakeClient(async () => ({ data: { stripe: true }, error: null })),
    )
    expect(adapter.mode).toBe("stripe")
  })

  it("uses the fixture when the server reports stripe off", async () => {
    const adapter = await chooseBillingAdapter(
      fakeClient(async () => ({ data: { stripe: false }, error: null })),
    )
    expect(adapter.mode).toBe("fixture")
  })

  it("falls back to the fixture when the call fails or the body has no flag", async () => {
    const failed = await chooseBillingAdapter(
      fakeClient(async () => ({ data: null, error: { message: "down" } })),
    )
    expect(failed.mode).toBe("fixture")
    const noFlag = await chooseBillingAdapter(fakeClient(async () => ({ data: {}, error: null })))
    expect(noFlag.mode).toBe("fixture")
    const threw = await chooseBillingAdapter(
      fakeClient(
        vi.fn(async () => {
          throw new Error("network")
        }),
      ),
    )
    expect(threw.mode).toBe("fixture")
  })
})

describe("billingAdapterOnce", () => {
  it("does not keep a failed check: the next call asks the server again", async () => {
    const signInMethods = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue({ data: { stripe: true }, error: null })
    const getBillingAdapter = billingAdapterOnce(() => fakeClient(signInMethods))
    await expect(getBillingAdapter()).rejects.toThrow()
    expect((await getBillingAdapter()).mode).toBe("stripe")
    expect((await getBillingAdapter()).mode).toBe("stripe")
    // The successful answer is kept: the third call never asked.
    expect(signInMethods).toHaveBeenCalledTimes(2)
  })

  it("keeps the fixture the server chose, since that answer is not a failure", async () => {
    const signInMethods = vi.fn(async () => ({ data: { stripe: false }, error: null }))
    const getBillingAdapter = billingAdapterOnce(() => fakeClient(signInMethods))
    expect((await getBillingAdapter()).mode).toBe("fixture")
    expect((await getBillingAdapter()).mode).toBe("fixture")
    expect(signInMethods).toHaveBeenCalledTimes(1)
  })
})
