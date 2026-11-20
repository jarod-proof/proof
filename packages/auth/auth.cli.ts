// Used only by `pnpm --filter @proof/auth generate` to emit the Drizzle auth schema.
import { createAuth } from "./src/index"

const placeholder = (prefix: string) => `${prefix}_generate_only`

// `db` is a stand-in: schema generation never touches the database.
export const auth = createAuth({
  db: {} as never,
  secret: "x".repeat(32),
  baseURL: "https://localhost:3000",
  emailFrom: "Proof <auth@example.com>",
  // Placeholders so the stripe tables are generated. Nothing here reaches Stripe: generation makes no calls.
  stripe: {
    secretKey: placeholder("sk_test"),
    webhookSecret: placeholder("whsec"),
    // A catalog plan (stripePlans refuses any other name).
    plans: [{ name: "pro", priceId: placeholder("price") }],
  },
  // The `rateLimit` table exists only with the database limiter on (server.ts turns it on).
  rateLimit: {},
  // Support's `supportDelivery` table exists only with thread mail on (SUPPORT_REPLY_DOMAIN), so
  // placeholders turn it on here. Nothing is mailed: generation sends nothing.
  support: {
    email: {
      from: "Support <support@example.com>",
      replyDomain: "support.example.com",
      appUrl: "https://localhost:3000",
    },
  },
})
