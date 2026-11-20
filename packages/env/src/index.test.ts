import { describe, expect, it, vi } from "vitest"

/** Variables the tests below set themselves, and expect unset otherwise. */
const OPTIONAL_UNDER_TEST = [
  "WEB_ORIGINS",
  "HQ_SLACK_DAILY_GRANT_CAP_USD",
  "DEV_MAIL_SINK",
  "AUTH_RATE_LIMIT",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PLANS",
  "STORAGE_DRIVER",
  "STORAGE_BUCKET",
  "STORAGE_PUBLIC_URL",
  "STORAGE_LOCAL_DIR",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_SESSION_TOKEN",
  "S3_ENDPOINT",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "BLOB_READ_WRITE_TOKEN",
  "ANALYTICS_PROVIDER",
  "POSTHOG_API_KEY",
  "POSTHOG_HOST",
  "SUPPORT_REPLY_DOMAIN",
  "SUPPORT_EMAIL_FROM",
  "WRAPS_INBOUND_KEY",
  "WRAPS_INBOUND_BUCKET",
  "WRAPS_INBOUND_REGION",
  "SUPPORT_REPLY_DELAY_MS",
  "SUPPORT_SWEEP_INTERVAL_MS",
  "SUPPORT_INBOUND_SECRET",
]

/** A valid environment with every optional variable under test unset, and a fresh module. */
function base() {
  vi.unstubAllEnvs()
  vi.resetModules()
  vi.stubEnv("SKIP_ENV_VALIDATION", "")
  vi.stubEnv("DATABASE_URL", "postgres://u:p@localhost:5432/db")
  vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(32))
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000")
  vi.stubEnv("EMAIL_FROM", "App <auth@example.com>")
  for (const name of OPTIONAL_UNDER_TEST) vi.stubEnv(name, "")
}

describe("env", () => {
  it("hq's sign-up is closed unless HQ_ALLOW_SIGNUP says true", async () => {
    base()
    vi.stubEnv("HQ_ALLOW_SIGNUP", "")
    expect((await import("./index")).env.HQ_ALLOW_SIGNUP).toBe(false)
    for (const [raw, want] of [
      ["true", true],
      ["false", false],
      ["1", true],
      ["0", false],
    ] as const) {
      base()
      vi.stubEnv("HQ_ALLOW_SIGNUP", raw)
      expect((await import("./index")).env.HQ_ALLOW_SIGNUP, raw).toBe(want)
    }
  })

  it("hq's daily cap on Slack grants is unset by default, and a positive number up to $1000", async () => {
    base()
    vi.stubEnv("HQ_SLACK_DAILY_GRANT_CAP_USD", "")
    expect((await import("./index")).env.HQ_SLACK_DAILY_GRANT_CAP_USD).toBeUndefined()
    base()
    vi.stubEnv("HQ_SLACK_DAILY_GRANT_CAP_USD", "12.5")
    expect((await import("./index")).env.HQ_SLACK_DAILY_GRANT_CAP_USD).toBe(12.5)
    for (const bad of ["0", "-5", "abc", "1001"]) {
      base()
      vi.stubEnv("HQ_SLACK_DAILY_GRANT_CAP_USD", bad)
      await expect(import("./index"), bad).rejects.toThrow(/Invalid environment variables/)
    }
    vi.unstubAllEnvs()
  })

  it("fails fast on missing variables", async () => {
    vi.resetModules()
    vi.stubEnv("SKIP_ENV_VALIDATION", "")
    vi.stubEnv("DATABASE_URL", "")
    await expect(import("./index")).rejects.toThrow(/Invalid environment variables/)
  })

  it("still validates when SKIP_ENV_VALIDATION is set to false or 0", async () => {
    for (const value of ["false", "0"]) {
      vi.resetModules()
      vi.stubEnv("SKIP_ENV_VALIDATION", value)
      vi.stubEnv("DATABASE_URL", "")
      await expect(import("./index")).rejects.toThrow(/Invalid environment variables/)
    }
  })

  it("skips validation when SKIP_ENV_VALIDATION is 1 or true", async () => {
    for (const value of ["1", "true"]) {
      vi.resetModules()
      vi.stubEnv("SKIP_ENV_VALIDATION", value)
      vi.stubEnv("DATABASE_URL", "")
      await expect(import("./index")).resolves.toHaveProperty("env")
    }
  })

  it("parses a valid environment", async () => {
    vi.resetModules()
    vi.stubEnv("SKIP_ENV_VALIDATION", "")
    vi.stubEnv("DATABASE_URL", "postgres://u:p@localhost:5432/db")
    vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(32))
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000")
    vi.stubEnv("EMAIL_FROM", "App <auth@example.com>")
    const { env } = await import("./index")
    expect(env.BETTER_AUTH_URL).toBe("http://localhost:3000")
  })

  it("defaults the metering limits and proxy trust, and reads the web build directory", async () => {
    vi.resetModules()
    vi.stubEnv("SKIP_ENV_VALIDATION", "")
    vi.stubEnv("DATABASE_URL", "postgres://u:p@localhost:5432/db")
    vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(32))
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000")
    vi.stubEnv("EMAIL_FROM", "App <auth@example.com>")
    vi.stubEnv("UNCLAIMED_ORG_DAILY_REQUEST_LIMIT", "")
    vi.stubEnv("TRUST_PROXY", "")
    vi.stubEnv("WEB_DIST_DIR", "/srv/web")
    const { env } = await import("./index")
    expect(env.UNCLAIMED_ORG_DAILY_REQUEST_LIMIT).toBe(500)
    expect(env.TRUST_PROXY).toBe(false)
    expect(env.WEB_DIST_DIR).toBe("/srv/web")
  })

  it("parses explicit limits and TRUST_PROXY=true", async () => {
    vi.resetModules()
    vi.stubEnv("SKIP_ENV_VALIDATION", "")
    vi.stubEnv("DATABASE_URL", "postgres://u:p@localhost:5432/db")
    vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(32))
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000")
    vi.stubEnv("EMAIL_FROM", "App <auth@example.com>")
    vi.stubEnv("UNCLAIMED_ORG_DAILY_REQUEST_LIMIT", "50")
    vi.stubEnv("TRUST_PROXY", "true")
    const { env } = await import("./index")
    expect(env).toMatchObject({
      UNCLAIMED_ORG_DAILY_REQUEST_LIMIT: 50,
      TRUST_PROXY: true,
    })
  })

  describe("dev mail sink and Stripe (both optional)", () => {
    const base = () => {
      vi.unstubAllEnvs()
      vi.resetModules()
      vi.stubEnv("SKIP_ENV_VALIDATION", "")
      vi.stubEnv("DATABASE_URL", "postgres://u:p@localhost:5432/db")
      vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(32))
      vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000")
      vi.stubEnv("EMAIL_FROM", "App <auth@example.com>")
      // Unset whatever the developer's .env (loaded by mise) sets for these.
      for (const name of OPTIONAL_UNDER_TEST) vi.stubEnv(name, "")
    }

    it("leaves the dev mail sink and billing off when unset", async () => {
      base()
      const { env } = await import("./index")
      expect(env.DEV_MAIL_SINK).toBeUndefined()
      expect(env.STRIPE_SECRET_KEY).toBeUndefined()
    })

    it("allows the dev mail sink outside production", async () => {
      base()
      vi.stubEnv("NODE_ENV", "development")
      vi.stubEnv("DEV_MAIL_SINK", "true")
      const { env } = await import("./index")
      expect(env.DEV_MAIL_SINK).toBe(true)
    })

    it("refuses the dev mail sink when NODE_ENV is production", async () => {
      base()
      vi.stubEnv("NODE_ENV", "production")
      vi.stubEnv("DEV_MAIL_SINK", "true")
      await expect(import("./index")).rejects.toThrow(
        /DEV_MAIL_SINK is for development and e2e only/,
      )
    })

    it("refuses the dev mail sink when NODE_ENV is unset (fails closed)", async () => {
      base()
      vi.stubEnv("NODE_ENV", undefined)
      vi.stubEnv("DEV_MAIL_SINK", "true")
      await expect(import("./index")).rejects.toThrow(
        /DEV_MAIL_SINK is for development and e2e only/,
      )
    })

    it("keeps the auth rate limits on by default", async () => {
      base()
      const { env } = await import("./index")
      expect(env.AUTH_RATE_LIMIT).toBe("on")
    })

    it("allows the auth rate limits to be off in development and test", async () => {
      for (const nodeEnv of ["development", "test"]) {
        base()
        vi.stubEnv("NODE_ENV", nodeEnv)
        vi.stubEnv("AUTH_RATE_LIMIT", "off")
        const { env } = await import("./index")
        expect(env.AUTH_RATE_LIMIT).toBe("off")
      }
    })

    it("refuses the auth rate limits off when NODE_ENV is production or unset", async () => {
      for (const nodeEnv of ["production", undefined]) {
        base()
        vi.stubEnv("NODE_ENV", nodeEnv)
        vi.stubEnv("AUTH_RATE_LIMIT", "off")
        await expect(import("./index")).rejects.toThrow(
          /AUTH_RATE_LIMIT=off is for development and e2e only/,
        )
      }
    })

    it("refuses an AUTH_RATE_LIMIT that is neither on nor off", async () => {
      base()
      vi.stubEnv("NODE_ENV", "development")
      vi.stubEnv("AUTH_RATE_LIMIT", "false")
      await expect(import("./index")).rejects.toThrow(/Invalid environment variables/)
    })

    it("accepts a Stripe test-mode key", async () => {
      base()
      vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder") // gitleaks:allow
      const { env } = await import("./index")
      expect(env.STRIPE_SECRET_KEY).toBe("sk_test_placeholder") // gitleaks:allow
    })

    it("refuses a Stripe live-mode key at startup, with the reason", async () => {
      base()
      vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_placeholder") // gitleaks:allow
      await expect(import("./index")).rejects.toThrow(/must be a Stripe test-mode key \(sk_test_/)
    })
  })

  describe("WEB_ORIGINS", () => {
    const base = () => {
      vi.unstubAllEnvs()
      vi.resetModules()
      vi.stubEnv("SKIP_ENV_VALIDATION", "")
      vi.stubEnv("DATABASE_URL", "postgres://u:p@localhost:5432/db")
      vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(32))
      vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000")
      vi.stubEnv("EMAIL_FROM", "App <auth@example.com>")
      // Unset whatever the developer's .env (loaded by mise) sets for these.
      for (const name of OPTIONAL_UNDER_TEST) vi.stubEnv(name, "")
    }

    it("defaults to no extra origins", async () => {
      base()
      const { env } = await import("./index")
      expect(env.WEB_ORIGINS).toEqual([])
    })

    it("parses a comma-separated list of bare origins", async () => {
      base()
      vi.stubEnv("WEB_ORIGINS", "https://web.localhost, http://127.0.0.1:33195")
      const { env } = await import("./index")
      expect(env.WEB_ORIGINS).toEqual(["https://web.localhost", "http://127.0.0.1:33195"])
    })

    it("refuses anything that is not a bare http(s) origin", async () => {
      for (const value of [
        "web.localhost",
        "ftp://web.localhost",
        "https://web.localhost/sign-in",
        "https://web.localhost/",
        "https://web.localhost,",
      ]) {
        base()
        vi.stubEnv("WEB_ORIGINS", value)
        await expect(import("./index")).rejects.toThrow(/Invalid environment variables/)
      }
    })
  })

  describe("file store", () => {
    it("is off when unset, and local needs nothing more", async () => {
      base()
      expect((await import("./index")).env.STORAGE_DRIVER).toBeUndefined()
      base()
      vi.stubEnv("STORAGE_DRIVER", "local")
      const { env } = await import("./index")
      expect(env.STORAGE_DRIVER).toBe("local")
      expect(env.STORAGE_LOCAL_DIR).toBe(".storage")
    })

    it("names what each driver is missing", async () => {
      const cases = [
        ["s3", /needs STORAGE_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY\./],
        ["r2", /needs STORAGE_BUCKET, STORAGE_PUBLIC_URL, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID/],
        ["vercel-blob", /needs BLOB_READ_WRITE_TOKEN\./],
      ] as const
      for (const [driver, message] of cases) {
        base()
        vi.stubEnv("STORAGE_DRIVER", driver)
        await expect(import("./index")).rejects.toThrow(message)
      }
    })

    it("accepts a complete r2 setup", async () => {
      base()
      vi.stubEnv("STORAGE_DRIVER", "r2")
      vi.stubEnv("STORAGE_BUCKET", "uploads")
      vi.stubEnv("STORAGE_PUBLIC_URL", "https://pub-xyz.r2.dev")
      vi.stubEnv("R2_ACCOUNT_ID", "acc")
      vi.stubEnv("R2_ACCESS_KEY_ID", "id")
      vi.stubEnv("R2_SECRET_ACCESS_KEY", "secret") // gitleaks:allow
      expect((await import("./index")).env.STORAGE_DRIVER).toBe("r2")
    })

    it("refuses an unknown driver", async () => {
      base()
      vi.stubEnv("STORAGE_DRIVER", "gcs")
      await expect(import("./index")).rejects.toThrow(/Invalid environment variables/)
    })
  })

  describe("analytics", () => {
    it("is unset by default, and none and log need nothing more", async () => {
      base()
      expect((await import("./index")).env.ANALYTICS_PROVIDER).toBeUndefined()
      for (const provider of ["none", "log"]) {
        base()
        vi.stubEnv("ANALYTICS_PROVIDER", provider)
        expect((await import("./index")).env.ANALYTICS_PROVIDER).toBe(provider)
      }
    })

    it("refuses posthog without its key", async () => {
      base()
      vi.stubEnv("ANALYTICS_PROVIDER", "posthog")
      await expect(import("./index")).rejects.toThrow(/needs POSTHOG_API_KEY/)
      base()
      vi.stubEnv("ANALYTICS_PROVIDER", "posthog")
      vi.stubEnv("POSTHOG_API_KEY", "phc_test")
      expect((await import("./index")).env.POSTHOG_API_KEY).toBe("phc_test")
    })

    it("refuses an unknown provider", async () => {
      base()
      vi.stubEnv("ANALYTICS_PROVIDER", "segment")
      await expect(import("./index")).rejects.toThrow(/Invalid environment variables/)
    })
  })

  describe("support mail", () => {
    it("is off when unset; the inbound region defaults to us-east-1", async () => {
      base()
      const { env } = await import("./index")
      expect(env.SUPPORT_REPLY_DOMAIN).toBeUndefined()
      expect(env.WRAPS_INBOUND_KEY).toBeUndefined()
      expect(env.WRAPS_INBOUND_REGION).toBe("us-east-1")
    })

    it("refuses an address as the reply domain", async () => {
      base()
      vi.stubEnv("SUPPORT_REPLY_DOMAIN", "support@example.com")
      await expect(import("./index")).rejects.toThrow(/Invalid environment variables/)
    })

    it("names what inbound mail is missing, and accepts a complete setup", async () => {
      base()
      vi.stubEnv("WRAPS_INBOUND_KEY", "key")
      await expect(import("./index")).rejects.toThrow(
        /needs WRAPS_INBOUND_BUCKET, SUPPORT_REPLY_DOMAIN/,
      )
      base()
      vi.stubEnv("WRAPS_INBOUND_KEY", "key")
      vi.stubEnv("WRAPS_INBOUND_BUCKET", "bucket")
      vi.stubEnv("SUPPORT_REPLY_DOMAIN", "support.example.com")
      expect((await import("./index")).env.WRAPS_INBOUND_BUCKET).toBe("bucket")
    })

    it("sweeps every minute and leaves the reply delay to support unless set", async () => {
      base()
      const { env } = await import("./index")
      expect(env.SUPPORT_SWEEP_INTERVAL_MS).toBe(60_000)
      expect(env.SUPPORT_REPLY_DELAY_MS).toBeUndefined()
      base()
      vi.stubEnv("SUPPORT_REPLY_DELAY_MS", "0")
      vi.stubEnv("SUPPORT_SWEEP_INTERVAL_MS", "1000")
      const set = (await import("./index")).env
      expect(set.SUPPORT_REPLY_DELAY_MS).toBe(0)
      expect(set.SUPPORT_SWEEP_INTERVAL_MS).toBe(1000)
      base()
      vi.stubEnv("SUPPORT_SWEEP_INTERVAL_MS", "10")
      await expect(import("./index")).rejects.toThrow(/Invalid environment variables/)
    })

    it("takes a relay's secret as the inbound source, with a reply domain and not beside Wraps", async () => {
      base()
      vi.stubEnv("SUPPORT_INBOUND_SECRET", "s".repeat(32))
      await expect(import("./index")).rejects.toThrow(/needs SUPPORT_REPLY_DOMAIN/)
      base()
      vi.stubEnv("SUPPORT_INBOUND_SECRET", "s".repeat(32))
      vi.stubEnv("SUPPORT_REPLY_DOMAIN", "support.example.com")
      vi.stubEnv("WRAPS_INBOUND_KEY", "key")
      await expect(import("./index")).rejects.toThrow(/takes one source/)
      base()
      vi.stubEnv("SUPPORT_INBOUND_SECRET", "a relay secret with spaces")
      vi.stubEnv("SUPPORT_REPLY_DOMAIN", "support.example.com")
      await expect(import("./index")).rejects.toThrow(/Invalid environment variables/)
      base()
      vi.stubEnv("SUPPORT_INBOUND_SECRET", "s".repeat(32))
      vi.stubEnv("SUPPORT_REPLY_DOMAIN", "support.example.com")
      expect((await import("./index")).env.SUPPORT_INBOUND_SECRET).toBe("s".repeat(32))
    })
  })
})
