/**
 * Express middleware, mounted ahead of Directus's routes, that takes "text
 * contains" filters on a collection's large text fields off the pooled
 * connection (see side-scanner.ts) before the items controller runs.
 *
 * It works on the request, not in an `items.query` hook, because the admin's
 * count goes through MetaService, which never reaches that hook; rewriting
 * the request's query covers the list and its count alike. For GET that is
 * `req.sanitizedQuery`; for SEARCH Directus builds the query later from
 * `req.body.query`, so that is the one rewritten.
 *
 * Anything it does not recognise, may not do, or fails at is passed on
 * untouched, so the worst case is the behaviour from before it existed.
 */
import {
  collectTextLeaves,
  rewriteTextLeaves,
  type Filter,
  type TextLeaf,
} from './rewrite-filter'
import { ScanAborted, type ScanRequest, type ScanResult } from './side-scanner'

interface SchemaField {
  field: string
  type: string
}

interface SchemaCollection {
  primary: string
  singleton?: boolean
  fields: Record<string, SchemaField>
}

export interface OffloadRequest {
  method: string
  path: string
  sanitizedQuery?: { filter?: unknown; [key: string]: unknown }
  body?: {
    keys?: unknown
    query?: { filter?: unknown; [key: string]: unknown }
  }
  schema?: { collections: Record<string, SchemaCollection> }
  accountability?: unknown
}

export interface OffloadResponse {
  writableEnded: boolean
  locals?: Record<string, unknown>
  on(event: 'close', listener: () => void): unknown
  off(event: 'close', listener: () => void): unknown
}

export interface OffloadMiddlewareOptions {
  scan: (request: ScanRequest, signal: AbortSignal) => Promise<ScanResult>
  /**
   * Whether this caller may filter on these fields. The scan itself bypasses
   * Directus's permissions, so without this a field the caller cannot read
   * could be probed through the filter.
   */
  canFilter: (
    req: OffloadRequest,
    collection: string,
    fields: string[],
  ) => Promise<boolean>
  logger: { warn: (message: string) => void }
  /**
   * Most keys one request may hand to Directus, over all its conditions:
   * they end up as bound parameters of a single statement, and SQLite
   * accepts 32,766 of those.
   */
  maxIds: number
}

const ITEMS_LIST = /^\/items\/([^/]+)\/?$/

const leafKey = (leaf: TextLeaf) =>
  JSON.stringify([leaf.field, leaf.operator, leaf.value])

export function createOffloadMiddleware(options: OffloadMiddlewareOptions) {
  const { scan, canFilter, logger, maxIds } = options

  // Express does not catch a rejected async middleware, and an unhandled
  // rejection ends the process, so nothing may escape: whatever goes wrong,
  // the request is passed on as it came.
  return async function offloadTextFilters(
    req: OffloadRequest,
    res: OffloadResponse,
    next: (error?: unknown) => void,
  ): Promise<void> {
    let passedOn = false
    const pass = () => {
      passedOn = true
      next()
    }
    try {
      await handle(req, res, pass)
    } catch (error) {
      logger.warn(
        `[text-filter-offload] unexpected error, request left as it was: ${(error as Error)?.message ?? error}`,
      )
      if (!passedOn) next()
    }
  }

  async function handle(
    req: OffloadRequest,
    res: OffloadResponse,
    next: () => void,
  ): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'SEARCH') return next()
    const match = ITEMS_LIST.exec(req.path)
    if (!match) return next()

    // The query Directus will run: a SEARCH carries it in the body (and one
    // by keys is not a filtered read at all).
    const bodyQuery = req.method === 'SEARCH' ? req.body?.query : undefined
    if (req.method === 'SEARCH' && req.body?.keys) return next()
    const query = bodyQuery ?? req.sanitizedQuery
    const filter = query?.filter
    if (!query || !filter) return next()

    let collection: string
    try {
      collection = decodeURIComponent(match[1]!)
    } catch {
      return next()
    }
    // The items router refuses system collections anyway.
    if (collection.startsWith('directus_')) return next()
    const info = req.schema?.collections[collection]
    if (!info || info.singleton) return next()

    const textFields = new Set(
      Object.values(info.fields)
        .filter((field) => field.type === 'text')
        .map((field) => field.field),
    )
    const leaves = collectTextLeaves(filter, textFields)
    if (!leaves.length) return next()
    // A SEARCH body has not been through Directus's sanitizer yet, so a
    // dynamic variable ($CURRENT_USER, $NOW…) is still a placeholder here.
    if (bodyQuery && leaves.some((leaf) => leaf.value.startsWith('$'))) {
      return next()
    }

    const controller = new AbortController()
    const onClose = () => {
      if (!res.writableEnded) controller.abort()
    }
    res.on('close', onClose)

    try {
      const fields = [...new Set(leaves.map((leaf) => leaf.field))]
      if (!(await canFilter(req, collection, fields))) return next()

      const results = new Map<string, Array<string | number>>()
      let total = 0
      for (const leaf of leaves) {
        const key = leafKey(leaf)
        let ids = results.get(key)
        if (!ids) {
          const scanned = await scan(
            {
              table: collection,
              primaryKey: info.primary,
              field: leaf.field,
              operator: leaf.operator,
              value: leaf.value,
            },
            controller.signal,
          )
          // Too many matches to hand over as a key list.
          if (!scanned) return next()
          ids = scanned
          results.set(key, ids)
        }
        // Counted per use: a condition that appears twice in the filter is
        // bound twice in the statement.
        total += ids.length
        if (total > maxIds) return next()
      }
      // The client left while a cached result was being returned.
      if (controller.signal.aborted) return

      const rewritten = {
        ...query,
        filter: rewriteTextLeaves(
          filter as Filter,
          textFields,
          info.primary,
          (leaf) => results.get(leafKey(leaf))!,
        ),
      }
      if (bodyQuery) {
        req.body = { ...req.body, query: rewritten }
      } else {
        req.sanitizedQuery = rewritten
        // Directus keys its response cache on the query: it looked this
        // request up under the original and would store it under the
        // rewritten one, an entry nothing ever reads. Skip the store.
        if (res.locals) res.locals['cache'] = false
      }
      return next()
    } catch (error) {
      // Nobody is waiting for this response any more.
      if (error instanceof ScanAborted || controller.signal.aborted) return
      logger.warn(
        `[text-filter-offload] ${collection}: running the filter as written: ${(error as Error)?.message ?? error}`,
      )
      return next()
    } finally {
      res.off('close', onClose)
    }
  }
}
