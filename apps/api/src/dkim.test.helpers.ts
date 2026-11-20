// Inbound support mail threads onto a ticket only when it carries a DKIM signature aligned with its
// From domain (support checks it against DNS). These sign a test message with a key of our own and
// publish it in a resolver handed to support (`inbound.resolver`), so the real check runs without
// the network.
import { generateKeyPairSync, randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import type { SupportConfig } from "@proof/auth"

type DkimResolver = NonNullable<NonNullable<SupportConfig["inbound"]>["resolver"]>

interface DkimSign {
  dkimSign(
    input: string,
    options: {
      canonicalization: string
      signatureData: { signingDomain: string; selector: string; privateKey: string }[]
    },
  ): Promise<{ signatures: string; errors: unknown[] }>
}

// mailauth is support's own dependency (its DKIM check), not this app's: load it from there.
const require = createRequire(import.meta.url)
const supportEntry = createRequire(require.resolve("@proof/auth")).resolve("@byo-oss/support")
const { dkimSign } = createRequire(supportEntry)("mailauth") as DkimSign

export interface TestMail {
  from: string
  to: string
  subject: string
  text: string
}

/** A plain-text RFC 822 message with a unique Message-ID, CRLF line ends. */
export function rawMessage({ from, to, subject, text }: TestMail): string {
  const domain = from.slice(from.indexOf("@") + 1)
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    text,
    "",
  ].join("\r\n")
}

/**
 * A test DNS for support's DKIM check: pass `resolver` as `support.inbound.resolver`, then
 * `key(domain)` publishes a fresh key for that domain and returns `sign(raw)`, which puts an aligned
 * signature in front of the message. Any other lookup finds nothing, as DNS would.
 */
export function testDkim() {
  const records = new Map<string, string>()
  const resolver: DkimResolver = async (name, rrtype) => {
    const record = rrtype === "TXT" ? records.get(name.toLowerCase()) : undefined
    if (record === undefined) {
      throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: "ENOTFOUND" })
    }
    return [[record]]
  }
  const key = (domain: string, selector = "test") => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const p = publicKey.export({ type: "spki", format: "der" }).toString("base64")
    records.set(`${selector}._domainkey.${domain}`.toLowerCase(), `v=DKIM1; k=rsa; p=${p}`)
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    return {
      async sign(raw: string): Promise<string> {
        const result = await dkimSign(raw, {
          canonicalization: "relaxed/relaxed",
          signatureData: [{ signingDomain: domain, selector, privateKey: pem }],
        })
        if (result.errors.length > 0) {
          throw new Error(`DKIM signing failed: ${String(result.errors)}`)
        }
        return result.signatures + raw
      },
    }
  }
  return { resolver, key }
}
