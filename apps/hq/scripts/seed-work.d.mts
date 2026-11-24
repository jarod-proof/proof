export const MERGE_MINUTES_AGO: {
  deploying: number
  verifyingLate: number
  verifyingReopened: number
  done: number
}
export const SEED_ISSUES: {
  triage: number
  asking: number
  planned: number
  building: number
  exhausted: number
  pendingMerge: number
  deploying: number
  verifyingLate: number
  reopened: number
  done: number
}
export type SeedRole = keyof typeof SEED_ISSUES

export function cookieHeaderFrom(text: string): string

/** Whether a url names this machine: localhost, *.localhost, 127.0.0.0/8, ::1. */
export function isLoopback(url: string): boolean

export interface SeedResult {
  built: SeedRole[]
  found: SeedRole[]
  /** The display id of each item, by role. */
  ids: Partial<Record<SeedRole, string>>
  sweep: {
    advanced: string[]
    passed: string[]
    reopened: string[]
    retriaged: string[]
    abandoned: string[]
    errors: unknown[]
  } | null
  warnings: string[]
  /** Every `METHOD /path` the script sent. */
  touched: string[]
  now: string
}

export function seedWork(input: {
  baseUrl: string
  /** The Cookie header value of a founder's session. */
  cookie: string
  fetch?: typeof fetch
  repo?: string
  /** Seed a base url that is not this machine (work history can never be deleted). */
  allowRemote?: boolean
}): Promise<SeedResult>
