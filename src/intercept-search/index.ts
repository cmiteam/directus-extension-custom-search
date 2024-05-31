import type { SandboxHookRegisterContext } from 'directus:api'

// Recursively run a replace operation on any string object values.
function recursivelyReplaceString(
  value: any,
  // User-defined string replacement function.
  replaceFunc: (string: string) => string,
) {
  if (!value) return value

  if (Array.isArray(value)) {
    // Iterate through arrays and recursively replace any strings in them.
    for (let i = 0; i < value.length; i++) {
      value[i] = recursivelyReplaceString(value[i], replaceFunc)
    }
  } else if (typeof value === 'object') {
    // Iterate through object and recursively replace any strings in them.
    for (let key in value) {
      value[key] = recursivelyReplaceString(value[key], replaceFunc)
    }
  } else if (typeof value === 'string') {
    // Replace strings with user defined function.
    value = replaceFunc(value)
  }

  return value
}

// Overrides the search functionality with additional configuration from a _search_config field from a collection.
export default ({ filter }: SandboxHookRegisterContext, { services }) => {
  filter(
    'items.query',
    //@ts-ignore
    async (
      query: { search?: string; filter: any },
      { collection }: { collection: string },
      context: { schema: any },
    ) => {
      if (!query.search) return query
      // Load _search_config field metadata from Directus.
      // Unfortunately, we can't filter by interface, so the field name is hardcoded for all collections.
      const fieldsService = new services.FieldsService({
        schema: context?.schema,
        accountability: { admin: true },
      })

      // Bail out early if we don't find any search configuration information.
      let searchConfig = null
      try {
        searchConfig = (
          await fieldsService.readOne(collection, '_search_config')
        )?.meta?.options?.search_config
        if (!searchConfig) return query
      } catch (e) {
        return query
      }

      const searchFilter = recursivelyReplaceString(searchConfig, (entry) =>
        entry.replace('$SEARCH', query.search || ''),
      )

      // Take search out of the query.
      const modifiedQuery = { ...query, search: undefined }
      if (!modifiedQuery.filter) modifiedQuery.filter = searchFilter
      else modifiedQuery.filter = { _and: [modifiedQuery.filter, searchFilter] }
      return modifiedQuery
    },
  )
}
