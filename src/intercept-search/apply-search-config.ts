/**
 * Turns a Directus `search` into the collection's configured filter.
 *
 * Two steps, because of how SQLite plans the admin's list query: the search
 * filter alone (title/alias LIKE …) can be answered from a small covering
 * index, but the list query also selects whatever columns the preset shows,
 * and for that the planner abandons the index and scans the whole table —
 * on `article` that is reading past every row's body, 14 s on prod
 * (2026-10-19). So for a list query the primary keys of the requested page
 * are resolved first with a narrow query (`resolveIds`), and Directus is
 * handed `pk IN (…)` for that page, which is key lookups no matter which
 * columns the caller asked for. Resolving only the page matters: the first
 * keystrokes of a search ("a", "re") match most of the table.
 *
 * The caller's `sort`, `limit`, `offset` and `page` are passed to the
 * pre-query untouched, so Directus applies its own defaults (default limit,
 * default sort, page→offset) identically to both queries; the only
 * substitutions are the cap for unbounded or oversized limits and the primary
 * key as a tiebreaker behind an explicit sort.
 *
 * Aggregate and grouped queries (the admin's counts) are left on the
 * configured filter: selecting nothing but a count is already served from the
 * index. When the resolver declines (too many ids, or an error), the
 * configured filter is used directly, as before.
 */

export type Filter = Record<string, unknown>

/** Above this, `IN (…)` stops being cheaper than the original filter. */
export const MAX_PREFETCHED_IDS = 5000

export interface SearchQuery {
  search?: string
  filter?: unknown
  sort?: unknown
  limit?: number
  offset?: number
  page?: number
  aggregate?: unknown
  /** `groupBy` in the URL; sanitizeQuery stores it as `group`. */
  group?: unknown
  [key: string]: unknown
}

/** What to ask the narrow pre-query for. */
export interface PageRequest {
  sort: string[] | undefined
  limit: number | undefined
  offset: number | undefined
  page: number | undefined
  /** Give up (use the filter directly) when more than this many keys come back. */
  declineAbove: number
}

export interface ApplySearchConfigOptions {
  query: SearchQuery
  searchConfig: Filter
  primaryKey: string
  /**
   * Primary keys of the requested page for the given filter (the search
   * filter, combined with the caller's own filter when there is one), or
   * null to fall back to the filter itself.
   */
  resolveIds: (
    filter: Filter,
    page: PageRequest,
  ) => Promise<Array<string | number> | null>
}

/**
 * Deep copy with every `$SEARCH` replaced by the term. A literal `"-1"` is the
 * config's placeholder for numeric fields: it becomes the term when the term
 * is a number, and stays `-1` (matching nothing) otherwise.
 */
export function buildSearchFilter(searchConfig: Filter, term: string): Filter {
  const numeric = Number(term)
  const replace = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(replace)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          replace(v),
        ]),
      )
    }
    if (value === '$SEARCH') return term
    if (value === '-1' && term !== '' && !Number.isNaN(numeric)) return numeric
    return value
  }
  return replace(searchConfig) as Filter
}

/**
 * The pre-query's paging, or null when the request cannot be served by ids:
 * an unbounded or oversized limit fetches one past the cap so an overflow can
 * be detected, which is only meaningful from the start of the result set.
 */
export function pageRequest(
  query: Pick<SearchQuery, 'sort' | 'limit' | 'offset' | 'page'>,
  primaryKey: string,
): PageRequest | null {
  const oversized =
    query.limit !== undefined &&
    (query.limit === -1 || query.limit > MAX_PREFETCHED_IDS)
  if (oversized && ((query.page ?? 1) > 1 || query.offset)) return null

  const given = Array.isArray(query.sort) ? query.sort.map(String) : []
  const last = given[given.length - 1]?.replace(/^-/, '')
  const sort = !given.length
    ? undefined
    : last === primaryKey
      ? given
      : [...given, primaryKey]

  return {
    sort,
    limit: oversized ? MAX_PREFETCHED_IDS + 1 : query.limit,
    offset: query.offset,
    page: query.page,
    declineAbove: MAX_PREFETCHED_IDS,
  }
}

export async function applySearchConfig({
  query,
  searchConfig,
  primaryKey,
  resolveIds,
}: ApplySearchConfigOptions): Promise<SearchQuery> {
  const searchFilter = buildSearchFilter(searchConfig, query.search ?? '')
  const { search: _search, ...rest } = query
  const withFilter = (effective: Filter): SearchQuery => ({
    ...rest,
    filter: query.filter ? { _and: [query.filter, effective] } : effective,
  })
  const fallback = withFilter(searchFilter)

  if (query.aggregate || query.group) return fallback

  const page = pageRequest(query, primaryKey)
  if (!page) return fallback

  // The resolver is expected to report its own failures; this is the last line
  // of defence so a search never breaks because the shortcut did.
  let ids: Array<string | number> | null = null
  try {
    ids = await resolveIds(fallback.filter as Filter, page)
  } catch {
    ids = null
  }
  if (!ids) return fallback

  // The ids are exactly the requested page, so the real query reads them from
  // the start; its own sort and limit still apply and give the same order.
  const { page: _page, ...paged } = withFilter({ [primaryKey]: { _in: ids } })
  return { ...paged, offset: 0 }
}
