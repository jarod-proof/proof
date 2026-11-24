import type { ProposalStatus } from "./schemas"

/** Every TanStack Query key the app uses. Screens invalidate by prefix. */
export const hqKeys = {
  session: () => ["session"] as const,
  status: () => ["status"] as const,
  proposals: (status?: ProposalStatus) => ["proposals", status ?? "all"] as const,
  factoryStatus: () => ["factory-status"] as const,
  digest: (since?: string) => ["digest", since ?? "default"] as const,
  policy: () => ["policy"] as const,
  // Every work key sits under ["work"], so one invalidation refreshes the board and every item.
  work: () => ["work"] as const,
  workBoard: () => ["work", "board"] as const,
  workItems: (query?: string) => ["work", "items", query ?? ""] as const,
  workItem: (ref: string) => ["work", "item", ref] as const,
}
