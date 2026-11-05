/** The set of logical field kinds the DSL supports in v1. */
export type FieldKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'float'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'select'
  | 'multiselect'
  | 'relation'
  | 'email'
  | 'url'
  | 'json'

/** How a related field cascades on parent delete. */
export type OnDelete = 'restrict' | 'cascade' | 'set null'

/**
 * A field described as plain data. This is the ONLY thing the server-side
 * compiler consumes — it is fully serializable and carries no drizzle/zod
 * objects, keeping the DSL layer free of heavy dependencies.
 */
export interface FieldSpec {
  kind: FieldKind
  required: boolean
  unique: boolean
  /** Add a (non-unique) database index; unique fields already have one. */
  indexed?: boolean
  hasDefault: boolean
  defaultValue?: unknown
  label?: string
  hidden?: boolean
  /** Excluded from public writes, responses, and metadata. */
  serverOnly?: boolean
  /** Form-control widget id (DashboardStack `FormFieldType` vocabulary). */
  formField?: string
  /** Table-cell widget id. */
  tableCell?: string
  placeholder?: string
  description?: string
  options?: readonly string[]
  relation?: { target: string; onDelete: OnDelete }
  meta?: Record<string, string | number | boolean>
}
