/** Copies a record without the given keys. */
export function omitKeys<Value>(
  record: Record<string, Value>,
  keys: Iterable<string>,
): Record<string, Value> {
  const excluded = new Set(keys)
  return Object.fromEntries(Object.entries(record).filter(([key]) => !excluded.has(key)))
}
