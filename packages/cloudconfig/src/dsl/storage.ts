export interface StorageFields {
  name?: string
  mimeType?: string
  size?: string
  key?: string
  owner?: string
  text?: string
}

/** Maps byte storage to the model's existing metadata fields. */
export interface ModelStorage {
  binding?: string
  local?: string
  /** Path relative to the API base; defaults to /<plural>/content. */
  path?: string
  fields?: StorageFields
  maxSize?: number
  mimeTypes?: readonly string[]
  /** Optional server-side extraction; storage itself needs no AI provider. */
  extractText?: (file: File) => string | Promise<string>
}
