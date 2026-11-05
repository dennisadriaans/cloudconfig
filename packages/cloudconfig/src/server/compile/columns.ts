/**
 * FieldSpec → drizzle column. Extracted from the compiler so the auth tables
 * can build their extra user columns (`auth.userFields`) with exactly the same
 * rules a model field gets — one mapping, not two that drift.
 */
import { integer, real, text, type SQLiteColumnBuilderBase } from 'drizzle-orm/sqlite-core'
import type { FieldSpec } from '../../index.js'
import { toSnakeCase } from '../../shared/pluralize.js'

export function buildColumn(fieldName: string, spec: FieldSpec): SQLiteColumnBuilderBase {
  const dbName = toSnakeCase(fieldName)
  let col: SQLiteColumnBuilderBase
  switch (spec.kind) {
    case 'number':
      col = integer(dbName)
      break
    case 'float':
      col = real(dbName)
      break
    case 'boolean':
      col = integer(dbName, { mode: 'boolean' })
      break
    case 'multiselect':
    case 'json':
      col = text(dbName, { mode: 'json' })
      break
    default:
      // text, textarea, date, datetime, select, email, url all store as text
      col = text(dbName)
      break
  }
  if (spec.hasDefault && spec.defaultValue !== undefined) {
    col = withDefault(col, spec)
  }
  if (spec.required) col = notNull(col)
  if (spec.unique) col = unique(col)
  return col
}

// drizzle's column-builder methods are chainable but not on the erased
// SQLiteColumnBuilderBase type; these tiny helpers keep the casts contained and
// avoid `as` at the call sites.
export function notNull(col: SQLiteColumnBuilderBase): SQLiteColumnBuilderBase {
  if ('notNull' in col && typeof col.notNull === 'function') return col.notNull()
  return col
}

export function unique(col: SQLiteColumnBuilderBase): SQLiteColumnBuilderBase {
  if ('unique' in col && typeof col.unique === 'function') return col.unique()
  return col
}

export function withDefault(
  col: SQLiteColumnBuilderBase,
  spec: FieldSpec,
): SQLiteColumnBuilderBase {
  if ('default' in col && typeof col.default === 'function') {
    return col.default(spec.defaultValue)
  }
  return col
}
