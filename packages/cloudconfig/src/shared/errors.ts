/**
 * Shared error shapes. Kept in `shared/` (dependency-firewalled) so both the
 * compiler and the server routes emit the same structure.
 */

/** A field error shared by model validators and API transports. */
export interface ValidationIssue {
  path: string
  message: string
}

/** The single JSON error shape returned by every API route. */
export interface ApiError {
  /** Machine-ish summary; key retained for DashboardStack wire compatibility. */
  error: string
  /** Human-readable message. */
  message: string
  /** Field issues, present on 400 validation failures. */
  issues?: ValidationIssue[]
}

/** Thrown by the compiler when a config is structurally invalid. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}
