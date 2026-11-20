import { ProofError } from "./errors"

/** A page of a cursor-paginated list, as the API returns them: `nextCursor` is null on the last page. */
export interface CursorPage {
  nextCursor: string | null
}

/**
 * Walks every page of a cursor-paginated list and yields its items in order.
 *
 * @example
 * for await (const project of paginate((cursor) => api.GET("/v1/projects", { params: { query: { cursor } } }).then((r) => r.data!), (page) => page.projects)) { ... }
 */
export async function* paginate<Page extends CursorPage, Item>(
  fetchPage: (cursor: string | undefined) => Promise<Page>,
  items: (page: Page) => readonly Item[],
): AsyncGenerator<Item, void, undefined> {
  const seen = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await fetchPage(cursor)
    yield* items(page)
    const next = page.nextCursor ?? undefined
    if (next !== undefined && seen.has(next)) {
      // A server that repeats a cursor would loop forever; fail loudly instead.
      throw new ProofError({
        status: 0,
        code: "PAGINATION_LOOP",
        message: "The server returned a cursor it had already returned",
      })
    }
    if (next !== undefined) seen.add(next)
    cursor = next
  } while (cursor !== undefined)
}
