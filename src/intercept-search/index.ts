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
      const searchConfigField = context.schema.collections[collection].fields['_search_config'];

      if (!searchConfigField.meta?.options?.search_config) return query;

      const searchFilter = recursivelyReplaceString(searchConfigField.meta.options.search_config, (entry) =>
        entry.replace('$SEARCH', query.search || ''),
      )

      // Take search out of the query.
      delete(query.search);
      
      if (!query.filter) query.filter = searchFilter
      else query.filter = { _and: [query.filter, searchFilter] }
      return query
    },
  )
}
