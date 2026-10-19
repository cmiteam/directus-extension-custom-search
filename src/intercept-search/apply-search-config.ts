/**
 * Turns a Directus `search` into the collection's configured filter.
 *
 * Two steps, because of how SQLite plans the admin's list query: the search
 * filter alone (title/alias LIKE …) can be answered from a small covering
 * index, but the list query also selects whatever columns the preset shows,
 * and for that the planner abandons the index and scans the whole table —
 * on `article` that is reading past every row's body, 14 s on prod
 * (2026-10-19). So the matching primary keys are resolved first with a
 * narrow query (`resolveIds`), and Directus is handed `pk IN (…)`, which is
 * primary-key lookups no matter which columns or sort the caller asked for.
 * When there are too many matches — or the resolver fails — the configured
 * filter is used directly, as before.
 */

export type Filter = Record<string, unknown>

/** Above this, `IN (…)` stops being cheaper than the original filter. */
export const MAX_PREFETCHED_IDS = 5000

export interface SearchQuery {
  search?: string
  filter?: unknown
  [key: string]: unknown
}

export interface ApplySearchConfigOptions {
  query: SearchQuery
  searchConfig: Filter
  primaryKey: string
  /**
   * Matching primary keys for the given filter (the search filter, combined
   * with the caller's own filter when there is one), or null to fall back to
   * the filter itself.
   */
  resolveIds: (filter: Filter) => Promise<Array<string | number> | null>
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

export async function applySearchConfig({
  query,
  searchConfig,
  primaryKey,
  resolveIds,
}: ApplySearchConfigOptions): Promise<SearchQuery> {
  const searchFilter = buildSearchFilter(searchConfig, query.search ?? '')
  const withCallersFilter: Filter = query.filter
    ? { _and: [query.filter, searchFilter] }
    : searchFilter

  // The resolver is expected to report its own failures; this is the last line
  // of defence so a search never breaks because the shortcut did.
  let ids: Array<string | number> | null = null
  try {
    ids = await resolveIds(withCallersFilter)
  } catch {
    ids = null
  }

  const effective: Filter = ids ? { [primaryKey]: { _in: ids } } : searchFilter

  const { search: _search, ...rest } = query
  return {
    ...rest,
    filter: query.filter ? { _and: [query.filter, effective] } : effective,
  }
}
