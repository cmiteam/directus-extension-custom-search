import { defineHook } from '@directus/extensions-sdk'
import { createOffloadMiddleware, type OffloadRequest } from './middleware'
import {
  createSideScanner,
  NotWalModeError,
  openSideDb,
  type ScanRequest,
  type ScanResult,
  type Sqlite3Driver,
} from './side-scanner'

/**
 * A key list this long is still cheap for SQLite (its bound-parameter limit
 * is 32,766) and covers every article, so a broad term like "the" is handed
 * over as keys too, instead of falling back to the scan on the pooled
 * connection.
 */
const DEFAULT_MAX_IDS = 20000
/** Leaves room under that limit for the rest of the statement's parameters. */
const MAX_IDS_CEILING = 30000

export function resolveMaxIds(configured: unknown): number {
  const value = Math.floor(Number(configured))
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_IDS
  return Math.min(value, MAX_IDS_CEILING)
}

interface ItemsServiceLike {
  readByQuery(query: unknown, options: unknown): Promise<unknown>
}

type ItemsServiceCtor = new (
  collection: string,
  options: unknown,
) => ItemsServiceLike

/**
 * Whether the caller may filter on the fields, asked of Directus itself: a
 * read with the fields in its filter is validated against the caller's
 * permissions before any SQL runs, and `limit: 0` keeps that SQL trivial.
 */
export function createCanFilter(
  services: { ItemsService: ItemsServiceCtor },
  database: unknown,
  logger: { warn: (message: string) => void },
) {
  return async (
    req: OffloadRequest,
    collection: string,
    fields: string[],
  ): Promise<boolean> => {
    const accountability = req.accountability as { admin?: boolean } | undefined
    if (!accountability) return false
    if (accountability.admin === true) return true
    const primaryKey = req.schema?.collections[collection]?.primary
    if (!primaryKey) return false
    const items = new services.ItemsService(collection, {
      schema: req.schema,
      accountability,
      knex: database,
    })
    try {
      await items.readByQuery(
        {
          fields: [primaryKey],
          filter: {
            _and: fields.map((field) => ({ [field]: { _nnull: true } })),
          },
          limit: 0,
        },
        { emitEvents: false },
      )
      return true
    } catch (error) {
      // A refusal is the expected answer; anything else would otherwise
      // switch the offload off for this caller without a trace.
      if ((error as { code?: string })?.code !== 'FORBIDDEN') {
        logger.warn(
          `[text-filter-offload] ${collection}: permission check failed: ${(error as Error)?.message ?? error}`,
        )
      }
      return false
    }
  }
}

type Scan = (request: ScanRequest, signal: AbortSignal) => Promise<ScanResult>

/**
 * The journal mode does not change while Directus runs, so a database that
 * is not in WAL mode is refused once: after that every scan declines at
 * once (the filter runs as written) instead of reopening the file and
 * warning on each request.
 */
export function quietWhenNotWal(
  scan: Scan,
  logger: { warn: (message: string) => void },
): Scan {
  let refused = false
  return async (request, signal) => {
    if (refused) return null
    try {
      return await scan(request, signal)
    } catch (error) {
      if (!(error instanceof NotWalModeError)) throw error
      refused = true
      logger.warn(
        `[text-filter-offload] switched off: ${error.message}. Text filters run on the main connection.`,
      )
      return null
    }
  }
}

// Runs "contains" filters on large text fields on a separate read-only
// connection, so they stop holding up the single pooled one. SQLite only.
export default defineHook(({ init }, { database, services, logger, env }) => {
  const enabled = env['TEXT_FILTER_OFFLOAD_ENABLED']
  if (enabled === false || enabled === 'false') return

  const config = database.client.config as {
    client?: string
    connection?: { filename?: string }
  }
  if (config.client !== 'sqlite3') return
  const filename = config.connection?.filename
  if (!filename || filename === ':memory:') return

  const maxIds = resolveMaxIds(env['TEXT_FILTER_OFFLOAD_MAX_IDS'])
  const scanner = createSideScanner({
    // knex already loaded the sqlite3 driver, so no second native module.
    open: () =>
      openSideDb(
        (database.client as unknown as { driver: Sqlite3Driver }).driver,
        filename,
      ),
    maxIds,
  })

  const middleware = createOffloadMiddleware({
    scan: quietWhenNotWal(scanner.scan, logger),
    canFilter: createCanFilter(
      services as unknown as { ItemsService: ItemsServiceCtor },
      database,
      logger,
    ),
    logger,
    maxIds,
  })

  // After authenticate and sanitize-query, before the items router.
  init('routes.before', ({ app }) => {
    app.use(middleware as unknown as Parameters<typeof app.use>[0])
  })
})
