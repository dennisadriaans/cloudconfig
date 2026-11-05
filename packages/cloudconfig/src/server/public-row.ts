import type { CompiledBase, CompiledModel } from './compile/index.js'
import { omitKeys } from '../shared/omit-keys.js'

/** Project at the operations boundary so REST and agent transports share it. */
export function publicRow(
  base: CompiledBase,
  model: CompiledModel,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const isServerOnlyRelation = (relation: CompiledModel['relationships'][number]) =>
    model.fieldSpecs[relation.fieldName]?.spec.serverOnly === true
  const serverOnlyColumns = Object.values(model.fieldSpecs)
    .filter(({ spec }) => spec.serverOnly)
    .map(({ columnKey }) => columnKey)
  const serverOnlyRelations = model.relationships
    .filter(isServerOnlyRelation)
    .map((relation) => relation.relationKey)
  const result = omitKeys(row, [...serverOnlyColumns, ...serverOnlyRelations])
  for (const relation of model.relationships) {
    if (isServerOnlyRelation(relation)) continue
    const value = result[relation.relationKey]
    const target = base.models[relation.targetModel]
    if (target && value && typeof value === 'object' && !Array.isArray(value)) {
      result[relation.relationKey] = publicRow(base, target, value as Record<string, unknown>)
    }
  }
  return result
}
