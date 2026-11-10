import { describe, expect, test, vi } from 'vitest'
import hook, { createCanFilter, quietWhenNotWal, resolveMaxIds } from './index'
import { NotWalModeError } from './side-scanner'

function register(database: unknown, env: Record<string, unknown> = {}) {
  const inits: Record<string, (context: any) => unknown> = {}
  const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
  ;(hook as any)(
    {
      init: (event: string, handler: (context: any) => unknown) =>
        (inits[event] = handler),
    },
    { database, services: {}, logger, env },
  )
  return { inits, logger }
}

const sqlite = (filename: string | undefined) => ({
  client: {
    config: { client: 'sqlite3', connection: { filename } },
    driver: {},
  },
})

describe('text-filter-offload hook', () => {
  test('mounts its middleware ahead of the Directus routes on SQLite', () => {
    const { inits } = register(sqlite('/persist/database/content.db'))
    expect(Object.keys(inits)).toEqual(['routes.before'])
    const app = { use: vi.fn() }
    inits['routes.before']!({ app })
    expect(app.use).toHaveBeenCalledTimes(1)
    expect(app.use.mock.calls[0]![0]).toBeTypeOf('function')
  })

  test('does nothing on another database', () => {
    const { inits } = register({
      client: { config: { client: 'pg', connection: {} }, driver: {} },
    })
    expect(inits).toEqual({})
  })

  test('does nothing for an in-memory or unnamed database', () => {
    expect(register(sqlite(undefined)).inits).toEqual({})
    expect(register(sqlite(':memory:')).inits).toEqual({})
  })

  test('can be switched off', () => {
    const { inits } = register(sqlite('/persist/database/content.db'), {
      TEXT_FILTER_OFFLOAD_ENABLED: false,
    })
    expect(inits).toEqual({})
  })
})

describe('createCanFilter', () => {
  const schema = { collections: { article: { primary: 'id' } } }

  function setup(readByQuery: () => Promise<unknown>) {
    const read = vi.fn(readByQuery)
    const ctor = vi.fn()
    class ItemsService {
      constructor(collection: string, options: unknown) {
        ctor(collection, options)
      }
      readByQuery = read
    }
    const logger = { warn: vi.fn() }
    return {
      canFilter: createCanFilter({ ItemsService }, 'knex', logger),
      read,
      ctor,
      logger,
    }
  }

  test('an admin may filter on anything, without a query', async () => {
    const { canFilter, read } = setup(async () => [])
    const req: any = { schema, accountability: { admin: true } }
    expect(await canFilter(req, 'article', ['body'])).toBe(true)
    expect(read).not.toHaveBeenCalled()
  })

  test('asks Directus, as the caller, with a query that reads no rows', async () => {
    const { canFilter, read, ctor } = setup(async () => [])
    const accountability = { user: 'u1', admin: false }
    const req: any = { schema, accountability }
    expect(await canFilter(req, 'article', ['body', 'abstract'])).toBe(true)
    expect(ctor).toHaveBeenCalledWith('article', {
      schema,
      accountability,
      knex: 'knex',
    })
    expect(read).toHaveBeenCalledWith(
      {
        fields: ['id'],
        filter: {
          _and: [{ body: { _nnull: true } }, { abstract: { _nnull: true } }],
        },
        limit: 0,
      },
      { emitEvents: false },
    )
  })

  test('is false, quietly, when Directus refuses the filter', async () => {
    const { canFilter, logger } = setup(async () => {
      throw Object.assign(
        new Error("You don't have permission to access this."),
        {
          code: 'FORBIDDEN',
        },
      )
    })
    const req: any = { schema, accountability: { user: 'u1', admin: false } }
    expect(await canFilter(req, 'article', ['body'])).toBe(false)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  test('is false, with a warning, when the check fails for another reason', async () => {
    const { canFilter, logger } = setup(async () => {
      throw new Error('Timeout acquiring a connection')
    })
    const req: any = { schema, accountability: { user: 'u1', admin: false } }
    expect(await canFilter(req, 'article', ['body'])).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Timeout acquiring a connection'),
    )
  })

  test('is false without an authenticated context', async () => {
    const { canFilter, read } = setup(async () => [])
    expect(await canFilter({ schema } as any, 'article', ['body'])).toBe(false)
    expect(read).not.toHaveBeenCalled()
  })
})

describe('resolveMaxIds', () => {
  test('defaults to 20,000', () => {
    expect(resolveMaxIds(undefined)).toBe(20000)
    expect(resolveMaxIds('abc')).toBe(20000)
    expect(resolveMaxIds(0)).toBe(20000)
  })

  test('takes a configured value', () => {
    expect(resolveMaxIds('5000')).toBe(5000)
    expect(resolveMaxIds(12000)).toBe(12000)
  })

  test('stays under what SQLite accepts as bound parameters', () => {
    expect(resolveMaxIds(50000)).toBe(30000)
  })
})

describe('quietWhenNotWal', () => {
  const request: any = {
    table: 'article',
    primaryKey: 'id',
    field: 'body',
    operator: '_contains',
    value: 'x',
  }
  const signal = new AbortController().signal

  test('passes results through', async () => {
    const scan = quietWhenNotWal(async () => ['a1'], { warn: vi.fn() })
    expect(await scan(request, signal)).toEqual(['a1'])
  })

  test('after one refusal, declines every scan without trying again, and says so once', async () => {
    const inner = vi.fn(async () => {
      throw new NotWalModeError('delete')
    })
    const logger = { warn: vi.fn() }
    const scan = quietWhenNotWal(inner, logger)
    expect(await scan(request, signal)).toBeNull()
    expect(await scan(request, signal)).toBeNull()
    expect(await scan(request, signal)).toBeNull()
    expect(inner).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('WAL'))
  })

  test('lets other failures through', async () => {
    const scan = quietWhenNotWal(
      async () => {
        throw new Error('SQLITE_IOERR')
      },
      { warn: vi.fn() },
    )
    await expect(scan(request, signal)).rejects.toThrow('SQLITE_IOERR')
  })
})
