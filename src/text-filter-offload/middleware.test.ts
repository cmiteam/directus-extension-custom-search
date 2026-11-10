import { EventEmitter } from 'node:events'
import { describe, expect, test, vi } from 'vitest'
import { createOffloadMiddleware } from './middleware'
import { ScanAborted, type ScanRequest, type ScanResult } from './side-scanner'

const schema = {
  collections: {
    article: {
      primary: 'id',
      singleton: false,
      fields: {
        id: { field: 'id', type: 'uuid' },
        title: { field: 'title', type: 'string' },
        body: { field: 'body', type: 'text' },
        abstract: { field: 'abstract', type: 'text' },
      },
    },
    directus_users: {
      primary: 'id',
      singleton: false,
      fields: { description: { field: 'description', type: 'text' } },
    },
    settings: {
      primary: 'id',
      singleton: true,
      fields: { notes: { field: 'notes', type: 'text' } },
    },
  },
}

function setup(
  options: {
    scan?: (request: ScanRequest, signal: AbortSignal) => Promise<ScanResult>
    canFilter?: () => Promise<boolean>
    maxIds?: number
  } = {},
) {
  const scan = vi.fn(options.scan ?? (async () => ['a1', 'a2']))
  const canFilter = vi.fn(options.canFilter ?? (async () => true))
  const logger = { warn: vi.fn(), debug: vi.fn() }
  const middleware = createOffloadMiddleware({
    scan,
    canFilter,
    logger,
    maxIds: options.maxIds ?? 100,
  })
  const run = async (request: Record<string, unknown>) => {
    const req: any = {
      method: 'GET',
      path: '/items/article',
      schema,
      accountability: { user: 'u1', admin: false },
      ...request,
    }
    const res: any = Object.assign(new EventEmitter(), {
      writableEnded: false,
      locals: {},
    })
    const next = vi.fn()
    const done = middleware(req, res, next)
    return { req, res, next, done }
  }
  return { run, scan, canFilter, logger }
}

const bodyFilter = { _and: [{ body: { _contains: 'First published' } }] }

describe('text filter offload middleware', () => {
  test('scans off the main connection and hands Directus the keys', async () => {
    const { run, scan } = setup()
    const sanitizedQuery = {
      filter: bodyFilter,
      limit: 25,
      sort: ['-date_created'],
    }
    const { req, next, done } = await run({ sanitizedQuery })
    await done

    expect(scan).toHaveBeenCalledWith(
      {
        table: 'article',
        primaryKey: 'id',
        field: 'body',
        operator: '_contains',
        value: 'First published',
      },
      expect.any(AbortSignal),
    )
    expect(req.sanitizedQuery).toEqual({
      filter: {
        _and: [
          { _and: [{ id: { _in: ['a1', 'a2'] } }, { body: { _nnull: true } }] },
        ],
      },
      limit: 25,
      sort: ['-date_created'],
    })
    expect(next).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledWith()
  })

  test('for SEARCH, rewrites the query in the body, which is the one Directus reads', async () => {
    const { run, scan } = setup()
    const { req, next, done } = await run({
      method: 'SEARCH',
      sanitizedQuery: {},
      body: { query: { filter: bodyFilter, limit: 25 } },
    })
    await done
    expect(scan).toHaveBeenCalledTimes(1)
    expect(req.body).toEqual({
      query: {
        filter: {
          _and: [
            {
              _and: [{ id: { _in: ['a1', 'a2'] } }, { body: { _nnull: true } }],
            },
          ],
        },
        limit: 25,
      },
    })
    expect(req.sanitizedQuery).toEqual({})
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('leaves a SEARCH by keys alone', async () => {
    const { run, scan } = setup()
    const body = { keys: ['a1'], query: { filter: bodyFilter } }
    const { req, next, done } = await run({
      method: 'SEARCH',
      sanitizedQuery: {},
      body,
    })
    await done
    expect(scan).not.toHaveBeenCalled()
    expect(req.body).toEqual({ keys: ['a1'], query: { filter: bodyFilter } })
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('counts a repeated condition once per use against the key budget', async () => {
    // Each use becomes its own bound key list in the final statement.
    const { run } = setup({ maxIds: 3 })
    const filter = {
      _or: [
        { _and: [{ body: { _contains: 'dna' } }, { title: { _eq: 'a' } }] },
        { _and: [{ body: { _contains: 'dna' } }, { title: { _eq: 'b' } }] },
      ],
    }
    const { req, next, done } = await run({ sanitizedQuery: { filter } })
    await done
    expect(req.sanitizedQuery).toEqual({ filter })
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('keeps a rewritten response out of the Directus response cache', async () => {
    // The cache key is the query, which now differs between lookup and store.
    const { run } = setup()
    const { res, done } = await run({ sanitizedQuery: { filter: bodyFilter } })
    await done
    expect(res.locals.cache).toBe(false)
  })

  test('does not touch response caching for a request it leaves alone', async () => {
    const { run } = setup()
    const { res, done } = await run({
      sanitizedQuery: { filter: { title: { _contains: 'dna' } } },
    })
    await done
    expect(res.locals).toEqual({})
  })

  test('leaves a SEARCH alone when a value is a dynamic variable Directus has yet to resolve', async () => {
    const { run, scan } = setup()
    const body = { query: { filter: { body: { _contains: '$CURRENT_USER' } } } }
    const { req, next, done } = await run({
      method: 'SEARCH',
      sanitizedQuery: {},
      body,
    })
    await done
    expect(scan).not.toHaveBeenCalled()
    expect(req.body).toEqual({
      query: { filter: { body: { _contains: '$CURRENT_USER' } } },
    })
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('leaves system collections alone', async () => {
    const { run, scan } = setup()
    const { next, done } = await run({
      path: '/items/directus_users',
      sanitizedQuery: { filter: { description: { _contains: 'x' } } },
    })
    await done
    expect(scan).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('leaves the request alone when the conditions together exceed the key budget', async () => {
    const { run } = setup({ maxIds: 3 })
    const filter = {
      _and: [
        { body: { _contains: 'dna' } },
        { abstract: { _contains: 'rna' } },
      ],
    }
    const { req, next, done } = await run({ sanitizedQuery: { filter } })
    await done
    expect(req.sanitizedQuery).toEqual({ filter })
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('scans each text condition in the filter', async () => {
    const { run, scan } = setup()
    const { done } = await run({
      sanitizedQuery: {
        filter: {
          _or: [
            { body: { _contains: 'dna' } },
            { abstract: { _icontains: 'rna' } },
          ],
        },
      },
    })
    await done
    expect(scan).toHaveBeenCalledTimes(2)
  })

  test.each([
    [
      'a single item',
      { path: '/items/article/a1', sanitizedQuery: { filter: bodyFilter } },
    ],
    [
      'another route',
      { path: '/files', sanitizedQuery: { filter: bodyFilter } },
    ],
    ['a write', { method: 'PATCH', sanitizedQuery: { filter: bodyFilter } }],
    ['no filter', { sanitizedQuery: { limit: 25 } }],
    ['no query at all', {}],
    [
      'a filter on an ordinary field',
      { sanitizedQuery: { filter: { title: { _contains: 'dna' } } } },
    ],
    [
      'an unknown collection',
      { path: '/items/nope', sanitizedQuery: { filter: bodyFilter } },
    ],
    [
      'a singleton',
      {
        path: '/items/settings',
        sanitizedQuery: { filter: { notes: { _contains: 'x' } } },
      },
    ],
  ])('leaves %s alone', async (_label, request) => {
    const { run, scan, canFilter } = setup()
    const before = structuredClone((request as any).sanitizedQuery)
    const { req, next, done } = await run(request)
    await done
    expect(scan).not.toHaveBeenCalled()
    expect(canFilter).not.toHaveBeenCalled()
    expect(req.sanitizedQuery).toEqual(before)
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('leaves the request alone when the caller may not filter on the field', async () => {
    const { run, scan, canFilter } = setup({ canFilter: async () => false })
    const { req, next, done } = await run({
      sanitizedQuery: { filter: bodyFilter },
    })
    await done
    expect(canFilter).toHaveBeenCalledWith(req, 'article', ['body'])
    expect(scan).not.toHaveBeenCalled()
    expect(req.sanitizedQuery).toEqual({ filter: bodyFilter })
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('leaves the request alone when too many rows match', async () => {
    const { run } = setup({ scan: async () => null })
    const { req, next, done } = await run({
      sanitizedQuery: { filter: bodyFilter },
    })
    await done
    expect(req.sanitizedQuery).toEqual({ filter: bodyFilter })
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('leaves the request alone, with a warning, when the scan fails', async () => {
    const { run, logger } = setup({
      scan: async () => {
        throw new Error('SQLITE_CORRUPT')
      },
    })
    const { req, next, done } = await run({
      sanitizedQuery: { filter: bodyFilter },
    })
    await done
    expect(req.sanitizedQuery).toEqual({ filter: bodyFilter })
    expect(next).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledWith()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('SQLITE_CORRUPT'),
    )
  })

  test('leaves the request alone when the permission check itself throws', async () => {
    const { run, scan } = setup({
      canFilter: async () => {
        throw new Error('boom')
      },
    })
    const { next, done } = await run({ sanitizedQuery: { filter: bodyFilter } })
    await done
    expect(scan).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('an unexpected error anywhere passes the request on instead of escaping', async () => {
    // Express does not catch a rejected async middleware; an escaped error
    // would be an unhandled rejection, which ends the process.
    const { run, logger } = setup()
    const { next, done } = await run({
      sanitizedQuery: { filter: bodyFilter },
      schema: new Proxy(
        {},
        {
          get() {
            throw new Error('schema unavailable')
          },
        },
      ),
    })
    await expect(done).resolves.toBeUndefined()
    expect(next).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledWith()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('schema unavailable'),
    )
  })

  test('when the client disconnects, the scan is told and nothing more runs', async () => {
    let seen: AbortSignal | undefined
    const { run } = setup({
      scan: (_request, signal) =>
        new Promise((_resolve, reject) => {
          seen = signal
          signal.addEventListener('abort', () => reject(new ScanAborted()))
        }),
    })
    const { res, next, done } = await run({
      sanitizedQuery: { filter: bodyFilter },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    res.emit('close')
    await done
    expect(seen?.aborted).toBe(true)
    expect(next).not.toHaveBeenCalled()
  })

  test('a response that finished normally does not abort anything', async () => {
    let seen: AbortSignal | undefined
    const { run } = setup({
      scan: async (_request, signal) => {
        seen = signal
        return ['a1']
      },
    })
    const { res, done } = await run({ sanitizedQuery: { filter: bodyFilter } })
    await done
    res.writableEnded = true
    res.emit('close')
    expect(seen?.aborted).toBe(false)
  })
})
