import { describe, expect, test, vi } from 'vitest'
import hook from './index'
import { MAX_PREFETCHED_IDS } from './apply-search-config'

/**
 * Drives the registered `items.query` filter with stubbed Directus services
 * and asserts the pre-query ItemsService actually receives.
 */
function setup(options: { ids?: Array<string | number>; config?: unknown } = {}) {
  const ids = options.ids ?? ['a1', 'a2']
  const readByQuery = vi.fn(async () => ids.map((id) => ({ id })))
  const itemsCtor = vi.fn()
  class ItemsService {
    constructor(collection: string, opts: unknown) {
      itemsCtor(collection, opts)
    }
    readByQuery = readByQuery
  }
  class FieldsService {
    async readOne() {
      return {
        meta: {
          options: {
            search_config:
              options.config ?? { _or: [{ title: { _contains: '$SEARCH' } }] },
          },
        },
      }
    }
  }
  let handler: any
  const register = { filter: (_name: string, fn: unknown) => (handler = fn) }
  const logger = { debug: vi.fn(), warn: vi.fn() }
  ;(hook as any)(register, {
    services: { ItemsService, FieldsService },
    database: 'knex',
    logger,
    env: {},
  })
  const schema = { collections: { article: { primary: 'id' } } }
  const accountability = { user: 'u1', role: 'r1', admin: false }
  const run = (query: Record<string, unknown>) =>
    handler(query, { collection: 'article' }, { schema, accountability })
  return { run, readByQuery, itemsCtor, logger, accountability }
}

describe('intercept-search hook', () => {
  test('pre-queries the page of keys as the caller, events off, and rewrites to pk IN', async () => {
    const { run, readByQuery, itemsCtor, accountability } = setup()
    const out = await run({ search: 'dna', sort: ['-date_created'], limit: 25, page: 2 })

    expect(itemsCtor).toHaveBeenCalledWith('article', {
      schema: expect.anything(),
      accountability,
      knex: 'knex',
    })
    expect(readByQuery).toHaveBeenCalledWith(
      {
        fields: ['id'],
        filter: { _or: [{ title: { _contains: 'dna' } }] },
        sort: ['-date_created', 'id'],
        limit: 25,
        offset: undefined,
        page: 2,
      },
      { emitEvents: false },
    )
    expect(out).toEqual({
      sort: ['-date_created'],
      limit: 25,
      offset: 0,
      filter: { id: { _in: ['a1', 'a2'] } },
    })
  })

  test('an unbounded request that overflows the cap falls back to the configured filter', async () => {
    const many = Array.from({ length: MAX_PREFETCHED_IDS + 1 }, (_, i) => i)
    const { run, readByQuery, logger } = setup({ ids: many })
    const out = await run({ search: 're', limit: -1 })

    expect(readByQuery).toHaveBeenCalledWith(
      expect.objectContaining({ limit: MAX_PREFETCHED_IDS + 1 }),
      { emitEvents: false },
    )
    expect(out.filter).toEqual({ _or: [{ title: { _contains: 're' } }] })
    expect(out.limit).toBe(-1)
    expect(logger.debug).toHaveBeenCalled()
  })

  test('a failing pre-query is logged and falls back', async () => {
    const { run, readByQuery, logger } = setup()
    readByQuery.mockRejectedValueOnce(new Error('db gone'))
    const out = await run({ search: 'dna', limit: 5 })

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('db gone'))
    expect(out.filter).toEqual({ _or: [{ title: { _contains: 'dna' } }] })
  })

  test('queries without a search are left alone', async () => {
    const { run, readByQuery } = setup()
    const q = { filter: { x: 1 } }
    expect(await run(q)).toBe(q)
    expect(readByQuery).not.toHaveBeenCalled()
  })
})
