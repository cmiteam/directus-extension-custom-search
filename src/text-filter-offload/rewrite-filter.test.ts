import { describe, expect, test } from 'vitest'
import { collectTextLeaves, rewriteTextLeaves } from './rewrite-filter'

const TEXT = new Set(['body', 'abstract'])

describe('collectTextLeaves', () => {
  test('finds a contains filter on a text field at the top level', () => {
    expect(
      collectTextLeaves({ body: { _contains: 'First published' } }, TEXT),
    ).toEqual([
      { field: 'body', operator: '_contains', value: 'First published' },
    ])
  })

  test('finds leaves nested under _and and _or, as the admin sends them', () => {
    const filter = {
      _and: [
        { body: { _contains: 'dna' } },
        {
          _or: [{ abstract: { _icontains: 'Flood' } }, { title: { _eq: 'x' } }],
        },
      ],
    }
    expect(collectTextLeaves(filter, TEXT)).toEqual([
      { field: 'body', operator: '_contains', value: 'dna' },
      { field: 'abstract', operator: '_icontains', value: 'Flood' },
    ])
  })

  test('ignores fields that are not large text', () => {
    expect(collectTextLeaves({ title: { _contains: 'dna' } }, TEXT)).toEqual([])
  })

  test('ignores other operators, including the negated ones', () => {
    const filter = {
      _and: [
        { body: { _ncontains: 'dna' } },
        { body: { _starts_with: 'dna' } },
        { body: { _null: true } },
      ],
    }
    expect(collectTextLeaves(filter, TEXT)).toEqual([])
  })

  test('ignores a field carrying more than one operator', () => {
    expect(
      collectTextLeaves({ body: { _contains: 'a', _ncontains: 'b' } }, TEXT),
    ).toEqual([])
  })

  test('ignores empty and non-string values', () => {
    const filter = {
      _and: [{ body: { _contains: '' } }, { abstract: { _contains: 5 } }],
    }
    expect(collectTextLeaves(filter, TEXT)).toEqual([])
  })

  test('does not descend into relations', () => {
    expect(
      collectTextLeaves({ content: { body: { _contains: 'dna' } } }, TEXT),
    ).toEqual([])
  })

  test('copes with a missing filter', () => {
    expect(collectTextLeaves(undefined, TEXT)).toEqual([])
    expect(collectTextLeaves(null, TEXT)).toEqual([])
  })
})

describe('rewriteTextLeaves', () => {
  const idsFor = (leaf: { field: string; value: string }) =>
    leaf.field === 'body' ? ['a1', 'a2'] : []

  // The field stays in the filter (as a not-null test, which every match
  // passes) so Directus still applies its own permission handling for a
  // filter on that field, exactly as it would for the original condition.
  test('swaps the leaf for the matching keys, keeping the field in the filter', () => {
    const filter = {
      _and: [{ body: { _contains: 'dna' } }, { status: { _eq: 'published' } }],
    }
    expect(rewriteTextLeaves(filter, TEXT, 'id', idsFor)).toEqual({
      _and: [
        { _and: [{ id: { _in: ['a1', 'a2'] } }, { body: { _nnull: true } }] },
        { status: { _eq: 'published' } },
      ],
    })
  })

  test('a leaf with no matches becomes a condition nothing satisfies', () => {
    expect(
      rewriteTextLeaves({ abstract: { _contains: 'zzz' } }, TEXT, 'id', idsFor),
    ).toEqual({
      _and: [{ id: { _null: true } }, { abstract: { _nnull: true } }],
    })
  })

  test('keeps sibling conditions that share an object with the leaf', () => {
    const filter = { body: { _contains: 'dna' }, status: { _eq: 'published' } }
    expect(rewriteTextLeaves(filter, TEXT, 'id', idsFor)).toEqual({
      _and: [
        { _and: [{ id: { _in: ['a1', 'a2'] } }, { body: { _nnull: true } }] },
        { status: { _eq: 'published' } },
      ],
    })
  })

  test('does not mutate the filter it was given', () => {
    const filter = { _or: [{ body: { _contains: 'dna' } }] }
    const copy = structuredClone(filter)
    rewriteTextLeaves(filter, TEXT, 'id', idsFor)
    expect(filter).toEqual(copy)
  })
})
