/**
 * DashboardStack replacement bridge. Maps a compiled model's field meta into
 * the `FieldOverride` shape that DashboardStack's `defineResource({ fields })`
 * consumes. The DSL vocabulary was chosen from DashboardStack's, so this is
 * nearly 1:1.
 */
import { capitalize } from '../shared/capitalize.js'
import type { CompiledModel } from './compile/index.js'

/** A subset of DashboardStack's FieldOverride — the fields the DSL can populate. */
export interface FieldOverride {
  label?: string
  formField?: string
  tableCell?: string
  hidden?: boolean
  placeholder?: string
  description?: string
  options?: readonly string[]
  relationship?: {
    model: string
    resource: string
    endpoint: string
  }
}

/** Produce a `{ columnKey → FieldOverride }` map for a compiled model. */
export function toFieldOverrides(model: CompiledModel): Record<string, FieldOverride> {
  const out: Record<string, FieldOverride> = {}
  for (const [columnKey, { spec }] of Object.entries(model.fieldSpecs)) {
    if (spec.serverOnly) continue
    const override: FieldOverride = {}
    if (spec.label !== undefined) override.label = spec.label
    if (spec.formField !== undefined) override.formField = spec.formField
    if (spec.tableCell !== undefined) override.tableCell = spec.tableCell
    if (spec.hidden !== undefined) override.hidden = spec.hidden
    if (spec.placeholder !== undefined) override.placeholder = spec.placeholder
    if (spec.description !== undefined) override.description = spec.description
    if (spec.options !== undefined) override.options = spec.options
    if (spec.relation) {
      const rel = model.relationships.find((relation) => relation.fieldName === columnKey)
      if (rel) {
        override.relationship = {
          model: capitalize(rel.targetModel),
          resource: rel.target,
          endpoint: `/api/${rel.target}`,
        }
      }
    }
    out[columnKey] = override
  }
  return out
}
