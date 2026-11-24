import type { ProposalStatus } from "./schemas"

/** Every TanStack Query key the app uses. Screens invalidate by prefix. */
export const hqKeys = {
  session: () => ["session"] as const,
  status: () => ["status"] as const,
  proposals: (status?: ProposalStatus) => ["proposals", status ?? "all"] as const,
  factoryStatus: () => ["factory-status"] as const,
  digest: (since?: string) => ["digest", since ?? "default"] as const,
  policy: () => ["policy"] as const,
}
