/**
 * Finds "contains" conditions on a collection's large text fields inside a
 * Directus filter, and swaps them for the primary keys that match.
 *
 * Only the two positive operators are handled. The negated ones differ on
 * NULL (`body NOT LIKE …` drops rows with no body, `id NOT IN (…)` keeps
 * them), so they are left for Directus to run as written.
 *
 * Only `_and` / `_or` are descended into: any other key is a field, and a
 * field whose value is not an operator object is a relation, which is a
 * different table and out of scope here.
 */

export type Filter = Record<string, unknown>

export type TextOperator = '_contains' | '_icontains'

export interface TextLeaf {
  field: string
  operator: TextOperator
  value: string
}

const OPERATORS: readonly string[] = ['_contains', '_icontains']

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** The leaf a `field: condition` pair stands for, or null when it is not one. */
function asLeaf(
  field: string,
  condition: unknown,
  textFields: ReadonlySet<string>,
): TextLeaf | null {
  if (!textFields.has(field) || !isObject(condition)) return null
  const keys = Object.keys(condition)
  if (keys.length !== 1) return null
  const operator = keys[0]!
  const value = condition[operator]
  if (!OPERATORS.includes(operator)) return null
  if (typeof value !== 'string' || value === '') return null
  return { field, operator: operator as TextOperator, value }
}

export function collectTextLeaves(
  filter: unknown,
  textFields: ReadonlySet<string>,
): TextLeaf[] {
  if (!isObject(filter)) return []
  const leaves: TextLeaf[] = []
  for (const [key, value] of Object.entries(filter)) {
    if (key === '_and' || key === '_or') {
      if (Array.isArray(value)) {
        for (const child of value) {
          leaves.push(...collectTextLeaves(child, textFields))
        }
      }
      continue
    }
    const leaf = asLeaf(key, value, textFields)
    if (leaf) leaves.push(leaf)
  }
  return leaves
}

/**
 * A copy of the filter with every text leaf replaced by
 * `pk IN (ids) AND field IS NOT NULL`.
 *
 * The field stays in the filter on purpose. The scan that produced the ids
 * ran outside Directus's permissions; with the field still named, Directus
 * applies whatever it applies to a filter on that field for this caller
 * (refusing it, or scoping it to the rows where they may read it), exactly
 * as it would have for the original condition. Every match has a value, so
 * the not-null test changes nothing else, and it does not read the text.
 *
 * `pk IS NULL` stands in for an empty id list: it is valid for any key type
 * and matches nothing.
 */
export function rewriteTextLeaves(
  filter: Filter,
  textFields: ReadonlySet<string>,
  primaryKey: string,
  idsFor: (leaf: TextLeaf) => Array<string | number>,
): Filter {
  const kept: Filter = {}
  const replaced: Filter[] = []
  for (const [key, value] of Object.entries(filter)) {
    if ((key === '_and' || key === '_or') && Array.isArray(value)) {
      kept[key] = value.map((child) =>
        isObject(child)
          ? rewriteTextLeaves(child, textFields, primaryKey, idsFor)
          : child,
      )
      continue
    }
    const leaf = asLeaf(key, value, textFields)
    if (!leaf) {
      kept[key] = value
      continue
    }
    const ids = idsFor(leaf)
    replaced.push({
      _and: [
        { [primaryKey]: ids.length ? { _in: ids } : { _null: true } },
        { [leaf.field]: { _nnull: true } },
      ],
    })
  }
  if (!replaced.length) return kept
  // The same object may already filter on the primary key or carry its own
  // _and, so siblings are joined with _and instead of merged.
  const siblings = Object.keys(kept).length ? [kept] : []
  const all = [...replaced, ...siblings]
  return all.length === 1 ? all[0]! : { _and: all }
}
