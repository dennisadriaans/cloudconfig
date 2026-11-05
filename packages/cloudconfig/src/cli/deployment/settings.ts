export function assertSettings(names: string[], values: Record<string, string>): void {
  const missing = names.filter((name) => !values[name])
  if (missing.length) {
    throw new Error(
      `Missing data service setting(s): ${missing.join(', ')}. Set them in the environment or .env.`,
    )
  }
}
