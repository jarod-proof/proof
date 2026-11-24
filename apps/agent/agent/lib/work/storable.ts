/**
 * Text hq can store, kept apart from the recorder and the logger so a workflow body may import it:
 * the attempt steps' pure functions (`attempts.ts`) and the signal mappers (`signals.ts`) share it.
 */

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/**
 * Text hq can store, at most `max` UTF-16 units: a cut never leaves half a surrogate pair, and a
 * NUL byte or a lone surrogate (which hq refuses, dropping the whole record) becomes U+FFFD.
 */
export function storable(value: string, max: number): string {
  let cut = value.slice(0, max)
  if (cut.length > 0 && isHighSurrogate(cut.charCodeAt(cut.length - 1))) {
    cut = cut.slice(0, -1)
  }
  return cut.replaceAll("\u0000", "�").replace(LONE_SURROGATE, "�")
}
