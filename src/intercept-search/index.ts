import { defineHook } from '@directus/extensions-sdk'
import {
  applySearchConfig,
  type Filter,
  type PageRequest,
  type SearchQuery,
} from './apply-search-config'

const SYSTEM_ACCOUNTABILITY = {
  admin: true,
  roles: [],
  role: null,
  user: null,
  app: false,
  ip: null,
}

// Overrides the search functionality with additional configuration from a _search_config field from a collection.
export default defineHook(({ filter }, { services, database, logger }) => {
  filter(
    'items.query',
    async (query: SearchQuery, meta, context): Promise<SearchQuery> => {
      if (!query.search) return query
      const collection: string = meta['collection']
      // Without a schema the fields lookup below can't work anyway.
      const schema = context?.schema
      if (!schema) return query
      // Load _search_config field metadata from Directus.
      // Unfortunately, we can't filter by interface, so the field name is hardcoded for all collections.
      const fieldsService = new services.FieldsService({
        schema,
        accountability: SYSTEM_ACCOUNTABILITY,
      })

      // Bail out early if we don't find any search configuration information.
      let searchConfig: Filter | null = null
      try {
        searchConfig = (
          await fieldsService.readOne(collection, '_search_config')
        )?.meta?.options?.search_config
        if (!searchConfig) return query
      } catch (e) {
        return query
      }

      const primaryKey: string | undefined =
        schema.collections[collection]?.primary
      if (!primaryKey) return query

      // Narrow pre-query for the requested page of keys (see
      // apply-search-config.ts). It runs as the caller, so field and item
      // permissions apply to it exactly as they did to the single query
      // before, and with events off so it neither re-enters this hook nor
      // fires read hooks for an internal lookup.
      const resolveIds = async (searchFilter: Filter, page: PageRequest) => {
        const items = new services.ItemsService(collection, {
          schema,
          accountability: context.accountability,
          knex: database,
        })
        type ItemsQuery = Parameters<typeof items.readByQuery>[0]
        try {
          const rows: Record<string, string | number>[] =
            await items.readByQuery(
              {
                fields: [primaryKey],
                filter: searchFilter as ItemsQuery['filter'],
                sort: page.sort,
                limit: page.limit,
                offset: page.offset,
                page: page.page,
              },
              { emitEvents: false },
            )
          if (rows.length > page.declineAbove) {
            logger.debug(
              `[custom-search] ${collection}: more than ${page.declineAbove} matches for "${query.search}" (limit ${query.limit ?? 'default'}), using the configured filter directly`,
            )
            return null
          }
          return rows.map((row) => row[primaryKey]!)
        } catch (error) {
          logger.warn(
            `[custom-search] ${collection}: id pre-query failed, using the configured filter directly: ${(error as Error)?.message ?? error}`,
          )
          return null
        }
      }

      return applySearchConfig({ query, searchConfig, primaryKey, resolveIds })
    },
  )
})
