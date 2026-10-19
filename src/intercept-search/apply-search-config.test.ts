import { describe, expect, test } from 'vitest'
import {
  applySearchConfig,
  MAX_PREFETCHED_IDS,
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

  test('exposes the id cap the hook uses to decide when to fall back', () => {
    expect(MAX_PREFETCHED_IDS).toBeGreaterThan(1000)
  })
})
