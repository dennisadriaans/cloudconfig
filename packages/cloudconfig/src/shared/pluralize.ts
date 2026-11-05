/**
 * Deterministic pluralizer, shared by the server route table and the typed
 * client so the URL segment for a model is computed identically on both sides.
 * Load-bearing: if this drifts, client and server disagree on endpoints.
 *
 * Intentionally small and rule-based (no irregular-word dictionary in v1);
 * `person` → `persons`, not `people`. See risk #3 in the plan.
 */
export function pluralize(name: string): string {
  if (name.endsWith('s')) return name
  if (/[^aeiou]y$/.test(name)) return `${name.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/.test(name)) return `${name}es`
  return `${name}s`
}

/** Convert a camelCase identifier to snake_case for a DB column/table name. */
export function toSnakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/^_/, '')
}

/**
 * The FK column key for a relation field. Field `author` → `authorId`; a field
 * already ending in `Id` is left unchanged. This reproduces DashboardStack's
 * relationKey inference so a compiled table joins under the same key.
 */
export function relationColumnKey(fieldName: string): string {
  return fieldName.endsWith('Id') ? fieldName : `${fieldName}Id`
}

/**
 * The nested-object key a relation column resolves to. `authorId` → `author`.
 * Mirrors DashboardStack's `relationshipRecordKey`.
 */
export function relationRecordKey(fieldName: string): string {
  const col = relationColumnKey(fieldName)
  return col.endsWith('Id') ? col.slice(0, -2) : `${col}Relation`
}
