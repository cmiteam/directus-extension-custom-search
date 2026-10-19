import { describe, expect, test } from 'vitest'
import {
  applySearchConfig,
  MAX_PREFETCHED_IDS,
  pageRequest,
  type Filter,
} from './apply-search-config'

const config = {
  _and: [
    {
      _or: [
        { title: { _contains: '$SEARCH' } },
        { alias: { _contains: '$SEARCH' } },
        { reference: { _eq: '-1' } },
      ],
    },
  ],
}

describe('applySearchConfig', () => {
  test('replaces the search with a primary-key filter over the pre-resolved ids', async () => {
    // Regression: Directus's list query for an admin search selects whatever
    // columns the preset shows, and for those SQLite falls back to scanning
    // the whole article table (14 s on prod, 2026-10-19). Resolving the ids
    // first with a narrow query lets the list become primary-key lookups.
    let seenFilter: unknown
    const result = await applySearchConfig({
      query: { search: 'dna', filter: undefined },
      searchConfig: config,
      primaryKey: 'id',
      resolveIds: async (filter) => {
        seenFilter = filter
        return ['a', 'b']
      },
    })

    expect(seenFilter).toEqual({
      _and: [
        {
          _or: [
            { title: { _contains: 'dna' } },
            { alias: { _contains: 'dna' } },
            { reference: { _eq: '-1' } },
          ],
        },
      ],
    })
    expect(result.search).toBeUndefined()
    expect(result.filter).toEqual({ id: { _in: ['a', 'b'] } })
  })

  test('keeps the caller’s own filter alongside the id filter, and narrows the pre-query with it', async () => {
    // The cap is judged on the narrowed set: an admin filtering to drafts and
    // searching a common word must not be thrown back to the slow path.
    let seenFilter: Filter | undefined
    const result = await applySearchConfig({
      query: { search: 'dna', filter: { status: { _eq: 'published' } } },
      searchConfig: config,
      primaryKey: 'id',
      resolveIds: async (filter) => {
        seenFilter = filter
        return ['a']
      },
    })

    expect(seenFilter).toMatchObject({
      _and: [{ status: { _eq: 'published' } }, { _and: [{ _or: expect.any(Array) }] }],
    })
    expect(result.filter).toEqual({
      _and: [{ status: { _eq: 'published' } }, { id: { _in: ['a'] } }],
    })
  })

  test('a throwing resolver also falls back to the configured filter', async () => {
    const result = await applySearchConfig({
      query: { search: 'dna', filter: undefined },
      searchConfig: config,
      primaryKey: 'id',
      resolveIds: async () => {
        throw new Error('db gone')
      },
    })

    expect(result.filter).toMatchObject({ _and: [{ _or: expect.any(Array) }] })
  })

  test('no matches means an empty id list, not the slow filter', async () => {
    const result = await applySearchConfig({
      query: { search: 'zzqq', filter: undefined },
      searchConfig: config,
      primaryKey: 'id',
      resolveIds: async () => [],
    })

    expect(result.filter).toEqual({ id: { _in: [] } })
  })

  test('falls back to the configured filter when the resolver declines', async () => {
    // Too many matches (or a failure) — hand the original filter to Directus
    // rather than a giant IN list.
    const result = await applySearchConfig({
      query: { search: 'e', filter: undefined },
      searchConfig: config,
      primaryKey: 'id',
      resolveIds: async () => null,
    })

    expect(result.search).toBeUndefined()
    expect(result.filter).toEqual({
      _and: [
        {
          _or: [
            { title: { _contains: 'e' } },
            { alias: { _contains: 'e' } },
            { reference: { _eq: '-1' } },
          ],
        },
      ],
    })
  })

  test('a numeric search also matches the placeholder number fields', async () => {
    let seenFilter: Filter | undefined
    await applySearchConfig({
      query: { search: '17705', filter: undefined },
      searchConfig: config,
      primaryKey: 'id',
      resolveIds: async (filter) => {
        seenFilter = filter
        return []
      },
    })

    expect(seenFilter).toMatchObject({
      _and: [{ _or: [{}, {}, { reference: { _eq: 17705 } }] }],
    })
  })

  test('does not mutate the stored configuration between searches', async () => {
    const stored = JSON.parse(JSON.stringify(config))
    await applySearchConfig({
      query: { search: 'first', filter: undefined },
      searchConfig: stored,
      primaryKey: 'id',
      resolveIds: async () => [],
    })
    expect(stored).toEqual(config)
  })

  test('a list query pre-resolves only the requested page, then reads that page from offset 0', async () => {
    // "re" matches 6,526 articles; resolving them all would trip the cap and
    // fall back to the table scan. The page of ids is what the list needs,
    // and the covering index answers it with the sort applied (9 ms on prod).
    // Paging parameters are handed to Directus untouched, so it applies the
    // same defaults and page→offset rule to both queries.
    let seenPage: unknown
    const result = await applySearchConfig({
      query: {
        search: 're',
        filter: undefined,
        sort: ['-date_created'],
        limit: 25,
        page: 3,
      },
      searchConfig: config,
      primaryKey: 'id',
      resolveIds: async (_filter, page) => {
        seenPage = page
        return ['x', 'y']
      },
    })

    expect(seenPage).toEqual({
      sort: ['-date_created', 'id'],
      limit: 25,
      offset: undefined,
      page: 3,
      declineAbove: MAX_PREFETCHED_IDS,
    })
    expect(result.filter).toEqual({ id: { _in: ['x', 'y'] } })
    expect(result.sort).toEqual(['-date_created'])
    expect(result.limit).toBe(25)
    expect(result.offset).toBe(0)
    expect(result.page).toBeUndefined()
  })

  test('an aggregate query is not rewritten to ids — the configured filter is already index-friendly', async () => {
    let called = false
    const result = await applySearchConfig({
      query: { search: 're', filter: undefined, aggregate: { countDistinct: ['id'] } },
      searchConfig: config,
      primaryKey: 'id',
      resolveIds: async () => {
        called = true
        return []
      },
    })

    expect(called).toBe(false)
    expect(result.search).toBeUndefined()
    expect(result.filter).toMatchObject({ _and: [{ _or: expect.any(Array) }] })
  })

  test('a grouped query (Directus stores groupBy as `group`) is not rewritten either', async () => {
    let called = false
    const result = await applySearchConfig({
      query: { search: 're', filter: undefined, group: ['category'] },
      searchConfig: config,
      primaryKey: 'id',
      resolveIds: async () => {
        called = true
        return []
      },
    })

    expect(called).toBe(false)
    expect(result.group).toEqual(['category'])
  })

  test('when the resolver declines a page request the paging is left untouched', async () => {
    const result = await applySearchConfig({
      query: { search: 're', filter: undefined, limit: 25, page: 3 },
      searchConfig: config,
      primaryKey: 'id',
      resolveIds: async () => null,
    })

    expect(result.page).toBe(3)
    expect(result.offset).toBeUndefined()
  })

  test('an oversized request on a later page is not attempted at all', async () => {
    // Substituting the cap for the limit would move the page; use the filter.
    let called = false
    const result = await applySearchConfig({
      query: { search: 're', filter: undefined, limit: -1, page: 2 },
      searchConfig: config,
      primaryKey: 'id',
      resolveIds: async () => {
        called = true
        return []
      },
    })

    expect(called).toBe(false)
    expect(result.page).toBe(2)
    expect(result.filter).toMatchObject({ _and: [{ _or: expect.any(Array) }] })
  })
})

describe('pageRequest', () => {
  test('passes limit, offset and page through untouched, with the cap as the decline threshold', () => {
    expect(pageRequest({ limit: 10, offset: 40 }, 'id')).toEqual({
      sort: undefined,
      limit: 10,
      offset: 40,
      page: undefined,
      declineAbove: MAX_PREFETCHED_IDS,
    })
  })

  test('no limit stays no limit: Directus applies its own default to both queries', () => {
    expect(pageRequest({ page: 3 }, 'id')!).toMatchObject({ limit: undefined, page: 3 })
  })

  test('no sort stays no sort: Directus’s default sort then applies to both queries', () => {
    expect(pageRequest({ limit: 5 }, 'id')!.sort).toBeUndefined()
  })

  test('a given sort gains the primary key as tiebreaker so page boundaries are stable', () => {
    expect(pageRequest({ sort: ['-date_created'], limit: 5 }, 'id')!.sort).toEqual(['-date_created', 'id'])
    expect(pageRequest({ sort: ['-date_created', '-id'], limit: 5 }, 'id')!.sort).toEqual(['-date_created', '-id'])
  })

  test('an unbounded request fetches one past the cap so the overflow can be detected', () => {
    expect(pageRequest({ limit: -1 }, 'id')!.limit).toBe(MAX_PREFETCHED_IDS + 1)
  })

  test('a bounded limit above the cap is treated like unbounded rather than silently truncated', () => {
    // Regression: `limit=10000` was clamped to 5000 ids and returned 5000 rows.
    expect(pageRequest({ limit: 10000 }, 'id')!.limit).toBe(MAX_PREFETCHED_IDS + 1)
  })

  test('an oversized request beyond page 1 is declined up front', () => {
    expect(pageRequest({ limit: 10000, page: 2 }, 'id')).toBeNull()
    expect(pageRequest({ limit: -1, offset: 10 }, 'id')).toBeNull()
  })
})
