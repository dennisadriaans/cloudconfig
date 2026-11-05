/**
 * Editing `cloud.config.ts` in place for `cloudconfig auth add`.
 *
 * The config is a TypeScript module, not data, so this is text surgery and it
 * can be wrong. The command that calls it re-loads the config afterwards and
 * restores the original file if the provider did not actually appear — the
 * patch is a convenience, and a printed snippet is the fallback.
 */
export type ConfigPatch =
  { status: 'patched'; text: string } | { status: 'unchanged' } | { status: 'manual' }

/** Index of the `}` closing the block whose `{` is at `openIndex`. */
function blockEnd(text: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/** The indentation of the line `index` falls on. */
function indentAt(text: string, index: number): string {
  const lineStart = text.lastIndexOf('\n', index) + 1
  const match = /^[ \t]*/.exec(text.slice(lineStart, index))
  return match?.[0] ?? ''
}

/** Enable `provider` under `<block>.providers` (`auth` or `connect`). */
export function addProviderToConfig(
  text: string,
  provider: string,
  section: 'auth' | 'connect' = 'auth',
): ConfigPatch {
  const authMatch = new RegExp(`^([ \\t]*)${section}\\s*:\\s*\\{`, 'm').exec(text)

  if (!authMatch) {
    // No block yet: add one just before the end of the config object.
    const close = text.lastIndexOf('\n})')
    if (close === -1) return { status: 'manual' }
    const block = `\n  ${section}: {\n    providers: { ${provider}: true },\n  },`
    return { status: 'patched', text: text.slice(0, close) + block + text.slice(close) }
  }

  const authOpen = authMatch.index + authMatch[0].length - 1
  const authClose = blockEnd(text, authOpen)
  if (authClose === -1) return { status: 'manual' }
  const authBody = text.slice(authOpen, authClose)
  const authIndent = authMatch[1] ?? '  '

  const providersMatch = /providers\s*:\s*\{/.exec(authBody)
  if (!providersMatch) {
    const insertAt = authOpen + 1
    const block = `\n${authIndent}  providers: { ${provider}: true },`
    return { status: 'patched', text: text.slice(0, insertAt) + block + text.slice(insertAt) }
  }

  const providersOpen = authOpen + providersMatch.index + providersMatch[0].length - 1
  const providersClose = blockEnd(text, providersOpen)
  if (providersClose === -1) return { status: 'manual' }
  const providersBody = text.slice(providersOpen + 1, providersClose)
  if (new RegExp(`(^|[^A-Za-z0-9_'"])${provider}\\s*:`).test(providersBody)) {
    return { status: 'unchanged' }
  }

  // Keep the one-line form one line; expand only a block that was already one.
  const insertAt = providersOpen + 1
  const inline = !providersBody.includes('\n')
  const block = inline
    ? ` ${provider}: true,`
    : `\n${indentAt(text, providersOpen)}  ${provider}: true,`
  return { status: 'patched', text: text.slice(0, insertAt) + block + text.slice(insertAt) }
}

/** What to print when the file could not be edited safely. */
export function manualSnippet(provider: string, section: 'auth' | 'connect' = 'auth'): string {
  return [`  ${section}: {`, `    providers: { ${provider}: true },`, '  },'].join('\n')
}
