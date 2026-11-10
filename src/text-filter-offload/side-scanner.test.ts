import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sqlite3 from 'sqlite3'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import {
  createSideScanner,
  openSideDb,
  ScanAborted,
  type ScanRequest,
  type SideDb,
} from './side-scanner'

const scanOf = (
  value: string,
  extra: Partial<ScanRequest> = {},
): ScanRequest => ({
  table: 'article',
  primaryKey: 'id',
  field: 'body',
  operator: '_contains',
  value,
  ...extra,
})

/** A database whose queries finish only when the test says so. */
function fakeDb() {
  const calls: Array<{
    sql: string
    params: unknown[]
    finish: (rows: Record<string, unknown>[]) => void
    fail: (error: Error) => void
  }> = []
  let interrupts = 0
  const db: SideDb = {
    all: (sql, params) =>
      new Promise((finish, fail) => calls.push({ sql, params, finish, fail })),
    interrupt: () => {
      interrupts++
      // SQLite fails the running statement when it is interrupted.
      calls[calls.length - 1]?.fail(
        Object.assign(new Error('SQLITE_INTERRUPT: interrupted'), {
          code: 'SQLITE_INTERRUPT',
        }),
      )
    },
    close: async () => {},
  }
  return { db, calls, interrupts: () => interrupts }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('createSideScanner', () => {
  test('returns the matching keys', async () => {
    const { db, calls } = fakeDb()
    const scanner = createSideScanner({ open: async () => db, maxIds: 10 })
    const result = scanner.scan(scanOf('dna'))
    await tick()
    calls[0]!.finish([{ k: 'a1' }, { k: 'a2' }])
    expect(await result).toEqual(['a1', 'a2'])
  })

  test('declines with null when more keys match than the cap', async () => {
    const { db, calls } = fakeDb()
    const scanner = createSideScanner({ open: async () => db, maxIds: 2 })
    const result = scanner.scan(scanOf('the'))
    await tick()
    expect(calls[0]!.params).toEqual(['%the%', 3])
    calls[0]!.finish([{ k: 1 }, { k: 2 }, { k: 3 }])
    expect(await result).toBeNull()
  })

  test('runs one scan at a time, in arrival order', async () => {
    const { db, calls } = fakeDb()
    const scanner = createSideScanner({ open: async () => db, maxIds: 10 })
    const first = scanner.scan(scanOf('one'))
    const second = scanner.scan(scanOf('two'))
    await tick()
    expect(calls).toHaveLength(1)
    calls[0]!.finish([{ k: 'a' }])
    await first
    await tick()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.params[0]).toBe('%two%')
    calls[1]!.finish([])
    expect(await second).toEqual([])
  })

  test('identical scans in flight share one query', async () => {
    const { db, calls } = fakeDb()
    const scanner = createSideScanner({ open: async () => db, maxIds: 10 })
    const list = scanner.scan(scanOf('dna'))
    const count = scanner.scan(scanOf('dna'))
    await tick()
    calls[0]!.finish([{ k: 'a1' }])
    expect(await list).toEqual(['a1'])
    expect(await count).toEqual(['a1'])
    expect(calls).toHaveLength(1)
  })

  test('a repeat within the cache window does not query again', async () => {
    const { db, calls } = fakeDb()
    let now = 1000
    const scanner = createSideScanner({
      open: async () => db,
      maxIds: 10,
      cacheMs: 5000,
      now: () => now,
    })
    const first = scanner.scan(scanOf('dna'))
    await tick()
    calls[0]!.finish([{ k: 'a1' }])
    await first
    now += 4000
    expect(await scanner.scan(scanOf('dna'))).toEqual(['a1'])
    expect(calls).toHaveLength(1)

    now += 2000
    const later = scanner.scan(scanOf('dna'))
    await tick()
    expect(calls).toHaveLength(2)
    calls[1]!.finish([])
    await later
  })

  test('a scan whose caller left before it started is never run', async () => {
    const { db, calls } = fakeDb()
    const scanner = createSideScanner({ open: async () => db, maxIds: 10 })
    const running = scanner.scan(scanOf('one'))
    const gone = new AbortController()
    const skipped = scanner.scan(scanOf('tw'), gone.signal)
    const wanted = scanner.scan(scanOf('two'))
    gone.abort()
    await expect(skipped).rejects.toBeInstanceOf(ScanAborted)
    await tick()
    calls[0]!.finish([])
    await running
    await tick()
    expect(calls).toHaveLength(2)
    expect(calls[1]!.params[0]).toBe('%two%')
    calls[1]!.finish([])
    await wanted
  })

  test('a running scan is interrupted once every caller has left', async () => {
    const { db, calls, interrupts } = fakeDb()
    const scanner = createSideScanner({ open: async () => db, maxIds: 10 })
    const a = new AbortController()
    const b = new AbortController()
    const first = scanner.scan(scanOf('dna'), a.signal)
    const second = scanner.scan(scanOf('dna'), b.signal)
    const next = scanner.scan(scanOf('after'))
    await tick()

    a.abort()
    await expect(first).rejects.toBeInstanceOf(ScanAborted)
    expect(interrupts()).toBe(0)

    b.abort()
    await expect(second).rejects.toBeInstanceOf(ScanAborted)
    expect(interrupts()).toBe(1)

    // The interrupted scan frees the connection for the next one.
    await tick()
    expect(calls).toHaveLength(2)
    calls[1]!.finish([{ k: 'z' }])
    expect(await next).toEqual(['z'])
  })

  test('a failed query rejects its callers and the scanner carries on', async () => {
    const { db, calls } = fakeDb()
    const scanner = createSideScanner({ open: async () => db, maxIds: 10 })
    const broken = scanner.scan(scanOf('one'))
    const next = scanner.scan(scanOf('two'))
    await tick()
    calls[0]!.fail(new Error('SQLITE_CORRUPT'))
    await expect(broken).rejects.toThrow('SQLITE_CORRUPT')
    await tick()
    calls[1]!.finish([])
    expect(await next).toEqual([])
  })

  test('a failed open rejects the scan and is retried on the next one', async () => {
    const { db, calls } = fakeDb()
    let attempts = 0
    const scanner = createSideScanner({
      open: async () => {
        if (++attempts === 1) throw new Error('cannot open')
        return db
      },
      maxIds: 10,
    })
    await expect(scanner.scan(scanOf('one'))).rejects.toThrow('cannot open')
    const retry = scanner.scan(scanOf('two'))
    await tick()
    calls[0]!.finish([])
    expect(await retry).toEqual([])
  })

  test('reopens the connection after a query fails on it', async () => {
    const first = fakeDb()
    const second = fakeDb()
    const closed = vi.fn(async () => {})
    first.db.close = closed
    const dbs = [first.db, second.db]
    const scanner = createSideScanner({
      open: async () => dbs.shift()!,
      maxIds: 10,
    })
    const broken = scanner.scan(scanOf('one'))
    await tick()
    first.calls[0]!.fail(new Error('SQLITE_IOERR'))
    await expect(broken).rejects.toThrow('SQLITE_IOERR')
    expect(closed).toHaveBeenCalledTimes(1)

    const next = scanner.scan(scanOf('two'))
    await tick()
    second.calls[0]!.finish([{ k: 'b' }])
    expect(await next).toEqual(['b'])
  })

  test('keeps the connection after an interrupt', async () => {
    const { db, calls } = fakeDb()
    let opens = 0
    const scanner = createSideScanner({
      open: async () => (opens++, db),
      maxIds: 10,
    })
    const gone = new AbortController()
    const dropped = scanner.scan(scanOf('one'), gone.signal)
    await tick()
    gone.abort()
    await expect(dropped).rejects.toBeInstanceOf(ScanAborted)
    const next = scanner.scan(scanOf('two'))
    await tick()
    calls[1]!.finish([])
    await next
    expect(opens).toBe(1)
  })

  test('a caller leaving while the connection fails to open does not leave a stray rejection', async () => {
    const stray = vi.fn()
    process.on('unhandledRejection', stray)
    try {
      let failOpen!: (error: Error) => void
      const scanner = createSideScanner({
        open: () => new Promise((_resolve, reject) => (failOpen = reject)),
        maxIds: 10,
      })
      const gone = new AbortController()
      const dropped = scanner.scan(scanOf('one'), gone.signal)
      await tick()
      gone.abort()
      await expect(dropped).rejects.toBeInstanceOf(ScanAborted)
      failOpen(new Error('SQLITE_CANTOPEN'))
      await tick()
      await tick()
      expect(stray).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', stray)
    }
  })
})

describe('openSideDb against a real SQLite file', () => {
  let dir: string
  let file: string
  let db: SideDb

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'side-scanner-'))
    file = join(dir, 'test.db')
    await new Promise<void>((resolve, reject) => {
      const setup = new sqlite3.Database(file, (error) => {
        if (error) return reject(error)
        setup.exec(
          `PRAGMA journal_mode = WAL;
           CREATE TABLE article (id TEXT PRIMARY KEY, body TEXT);
           INSERT INTO article VALUES
             ('a1', '<p>First published online in 2019</p>'),
             ('a2', '<p>first PUBLISHED online, lower case</p>'),
             ('a3', '<p>Nothing relevant</p>'),
             ('a4', NULL),
             ('a5', '<p>100% certain</p>');`,
          (execError) => {
            if (execError) return reject(execError)
            setup.close((closeError) =>
              closeError ? reject(closeError) : resolve(),
            )
          },
        )
      })
    })
    db = await openSideDb(sqlite3, file)
  })

  afterAll(async () => {
    await db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const scanner = () =>
    createSideScanner({ open: async () => db, maxIds: 10, cacheMs: 0 })

  test('_contains matches the way Directus runs it: LIKE, ASCII case-insensitive', async () => {
    expect(await scanner().scan(scanOf('First published online'))).toEqual([
      'a1',
      'a2',
    ])
  })

  test('_icontains matches on the lower-cased text', async () => {
    expect(
      await scanner().scan(
        scanOf('PUBLISHED Online', { operator: '_icontains' }),
      ),
    ).toEqual(['a1', 'a2'])
  })

  test('wildcards in the term behave as they do in Directus (unescaped)', async () => {
    expect(await scanner().scan(scanOf('First%2019'))).toEqual(['a1'])
  })

  test('no match gives an empty list', async () => {
    expect(await scanner().scan(scanOf('zebra'))).toEqual([])
  })

  test('the connection cannot write', async () => {
    await expect(db.all(`DELETE FROM article`, [])).rejects.toThrow(/readonly/i)
  })

  test('interrupt stops a running statement and the connection stays usable', async () => {
    const slow = db.all(
      `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000000000)
       SELECT count(*) AS n FROM c`,
      [],
    )
    setTimeout(() => db.interrupt(), 50)
    await expect(slow).rejects.toThrow(/interrupt/i)
    expect(await db.all(`SELECT count(*) AS n FROM article`, [])).toEqual([
      { n: 5 },
    ])
  })

  test('refuses a database that is not in WAL mode', async () => {
    const plain = join(dir, 'plain.db')
    await new Promise<void>((resolve, reject) => {
      const setup = new sqlite3.Database(plain, (error) => {
        if (error) return reject(error)
        setup.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY);`, (execError) => {
          if (execError) return reject(execError)
          setup.close((closeError) =>
            closeError ? reject(closeError) : resolve(),
          )
        })
      })
    })
    await expect(openSideDb(sqlite3, plain)).rejects.toThrow(/WAL/)
  })
})
