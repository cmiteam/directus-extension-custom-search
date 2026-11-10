/**
 * Runs "text contains" scans on a connection of their own.
 *
 * Directus has a single pooled SQLite connection, so a scan over every row's
 * body there makes every other request wait, and waits over 10 s fail. In WAL
 * mode a second, read-only connection reads alongside it, so the scan runs
 * here and only the resulting keys go back to the pooled connection.
 *
 * One scan runs at a time: they are disk- and CPU-bound, and the point is to
 * keep them from crowding the box. The admin app fires a request per
 * keystroke and abandons the superseded ones, so a scan nobody is waiting for
 * any more is dropped from the queue, or interrupted if it already started.
 */
import type { TextOperator } from './rewrite-filter'

export interface SideDb {
  all(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>
  /** Fails the statement that is running, if any. */
  interrupt(): void
  close(): Promise<void>
}

export interface ScanRequest {
  table: string
  primaryKey: string
  field: string
  operator: TextOperator
  value: string
}

export type ScanResult = Array<string | number> | null

/** The caller stopped waiting (its HTTP client went away). */
export class ScanAborted extends Error {
  constructor() {
    super('scan aborted')
    this.name = 'ScanAborted'
  }
}

/** The database uses a rollback journal, where a side read blocks writers. */
export class NotWalModeError extends Error {
  constructor(mode: string) {
    super(`database is in "${mode}" journal mode, not WAL`)
    this.name = 'NotWalModeError'
  }
}

export interface SideScannerOptions {
  open: () => Promise<SideDb>
  /** More matches than this and the scan declines (resolves null). */
  maxIds: number
  /**
   * How long a result is reused. The admin sends the list and its count as
   * separate requests moments apart; this lets them share one scan. Kept to
   * a second: a read within that of a write can still see the old matches.
   */
  cacheMs?: number
  now?: () => number
}

interface Waiter {
  resolve: (result: ScanResult) => void
  reject: (error: unknown) => void
}

interface Job {
  key: string
  request: ScanRequest
  waiters: Set<Waiter>
  running: boolean
}

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`

/** The same comparison Directus builds for these operators on SQLite. */
function buildSql(request: ScanRequest, limit: number) {
  const column = quote(request.field)
  const insensitive = request.operator === '_icontains'
  const where = insensitive ? `LOWER(${column}) LIKE ?` : `${column} LIKE ?`
  const term = insensitive ? request.value.toLowerCase() : request.value
  return {
    sql: `SELECT ${quote(request.primaryKey)} AS k FROM ${quote(request.table)} WHERE ${where} LIMIT ?`,
    params: [`%${term}%`, limit],
  }
}

export function createSideScanner(options: SideScannerOptions) {
  const { maxIds, cacheMs = 1000, now = Date.now } = options
  const jobs = new Map<string, Job>()
  const queue: Job[] = []
  const cache = new Map<string, { at: number; result: ScanResult }>()
  let current: Job | null = null
  let dbPromise: Promise<SideDb> | null = null

  const openDb = () => {
    dbPromise ??= options.open().catch((error) => {
      dbPromise = null
      throw error
    })
    return dbPromise
  }

  /** Stops tracking a job, so an identical request starts a fresh one. */
  const forget = (job: Job) => {
    if (jobs.get(job.key) === job) jobs.delete(job.key)
  }

  async function run(job: Job) {
    let db: SideDb | undefined
    try {
      db = await openDb()
      // Everyone left while the connection was opening.
      if (!job.waiters.size) return
      const { sql, params } = buildSql(job.request, maxIds + 1)
      const rows = await db.all(sql, params)
      const result: ScanResult =
        rows.length > maxIds
          ? null
          : rows.map((row) => row['k'] as string | number)
      if (cacheMs > 0) {
        cache.set(job.key, { at: now(), result })
        for (const [key, entry] of cache) {
          if (now() - entry.at >= cacheMs) cache.delete(key)
        }
      }
      for (const waiter of job.waiters) waiter.resolve(result)
    } catch (error) {
      // An interrupt is this scanner's own doing; anything else may mean the
      // connection is no longer usable, so the next scan opens a new one.
      if (db && (error as { code?: string })?.code !== 'SQLITE_INTERRUPT') {
        dbPromise = null
        void db.close().catch(() => {})
      }
      for (const waiter of job.waiters) waiter.reject(error)
    } finally {
      job.waiters.clear()
      forget(job)
      current = null
      pump()
    }
  }

  function pump() {
    if (current) return
    const next = queue.shift()
    if (!next) return
    current = next
    next.running = true
    void run(next)
  }

  function abandon(job: Job) {
    forget(job)
    if (job.running) {
      // A query still opening its connection has nothing to interrupt; run()
      // sees the empty waiter list and skips it.
      // A failed open is reported to the job by run(); here it only means
      // there is nothing to interrupt.
      void dbPromise?.then(
        (db) => {
          if (current === job) db.interrupt()
        },
        () => {},
      )
      return
    }
    const index = queue.indexOf(job)
    if (index !== -1) queue.splice(index, 1)
  }

  function scan(
    request: ScanRequest,
    signal?: AbortSignal,
  ): Promise<ScanResult> {
    const key = JSON.stringify([
      request.table,
      request.primaryKey,
      request.field,
      request.operator,
      request.value,
    ])
    const cached = cache.get(key)
    if (cached && now() - cached.at < cacheMs) {
      return Promise.resolve(cached.result)
    }
    if (signal?.aborted) return Promise.reject(new ScanAborted())

    let job = jobs.get(key)
    if (!job) {
      job = { key, request, waiters: new Set(), running: false }
      jobs.set(key, job)
      queue.push(job)
    }
    const joined = job

    return new Promise<ScanResult>((resolve, reject) => {
      const onAbort = () => {
        if (!joined.waiters.delete(waiter)) return
        reject(new ScanAborted())
        if (!joined.waiters.size) abandon(joined)
      }
      const waiter: Waiter = {
        resolve: (result) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(result)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      }
      joined.waiters.add(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
      pump()
    })
  }

  return { scan }
}

/** The parts of the sqlite3 driver this needs (knex's `client.driver`). */
export interface Sqlite3Driver {
  OPEN_READONLY: number
  Database: new (
    filename: string,
    mode: number,
    callback: (error: Error | null) => void,
  ) => {
    all(
      sql: string,
      params: unknown[],
      callback: (error: Error | null, rows: Record<string, unknown>[]) => void,
    ): void
    interrupt(): void
    configure(option: 'busyTimeout', value: number): void
    close(callback: (error: Error | null) => void): void
  }
}

/**
 * Opens the database file read-only on a connection separate from knex's.
 *
 * Refuses a database that is not in WAL mode: with a rollback journal a
 * long read here would lock the pooled connection's writes out for as long
 * as it runs, which is worse than the scan it replaces.
 */
export async function openSideDb(
  driver: Sqlite3Driver,
  filename: string,
): Promise<SideDb> {
  const side = await new Promise<SideDb>((resolve, reject) => {
    const db = new driver.Database(filename, driver.OPEN_READONLY, (error) => {
      if (error) return reject(error)
      // A reader in WAL mode only waits during a checkpoint restart.
      db.configure('busyTimeout', 5000)
      resolve({
        all: (sql, params) =>
          new Promise((done, fail) =>
            db.all(sql, params, (queryError, rows) =>
              queryError ? fail(queryError) : done(rows),
            ),
          ),
        interrupt: () => db.interrupt(),
        close: () =>
          new Promise((done, fail) =>
            db.close((closeError) => (closeError ? fail(closeError) : done())),
          ),
      })
    })
  })
  try {
    const rows = await side.all('PRAGMA journal_mode', [])
    const mode = String(rows[0]?.['journal_mode'] ?? '').toLowerCase()
    if (mode !== 'wal') throw new NotWalModeError(mode)
    return side
  } catch (error) {
    await side.close().catch(() => {})
    throw error
  }
}
