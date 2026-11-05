import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findConfigPath, loadConfig } from '../src/cli/config-load.js'
import { CONFIG_FILENAMES, resolveConfigExport } from '../src/shared/config-module.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudconfig-config-load-'))
  mkdirSync(join(dir, 'node_modules', '@cloudconfig'), { recursive: true })
  symlinkSync(
    join(import.meta.dirname, '..'),
    join(dir, 'node_modules', '@cloudconfig', 'core'),
    'dir',
  )
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const backend = `defineBackend({ models: { post: model({ title: t.text().required() }) } })`
const imports = `import { defineBackend, model, t } from '@cloudconfig/core'\n`

describe('config loading contract', () => {
  for (const filename of CONFIG_FILENAMES) {
    it.each(['export const config =', 'export default'])(
      'loads ' + filename + ' with %s',
      async (statement) => {
        writeFileSync(join(dir, filename), `${imports}${statement} ${backend}\n`)
        const loaded = await loadConfig(dir)
        expect(loaded.path).toBe(join(dir, filename))
        expect(Object.keys(loaded.config.models)).toEqual(['post'])
      },
    )
  }

  it('prefers cloud.config.ts consistently when both files exist', async () => {
    writeFileSync(join(dir, 'cloud.config.ts'), `${imports}export const config = ${backend}`)
    writeFileSync(join(dir, 'cloudconfig.config.ts'), 'throw new Error("unused legacy config")')
    expect(findConfigPath(dir)).toBe(join(dir, 'cloud.config.ts'))
    expect((await loadConfig(dir)).path).toBe(join(dir, 'cloud.config.ts'))
  })

  it('rejects missing exports with an actionable message', async () => {
    writeFileSync(join(dir, 'cloud.config.ts'), 'export const other = {}')
    await expect(loadConfig(dir)).rejects.toThrow(
      'must export a named "config" or a default built with defineBackend()',
    )
  })

  it('preserves named-export precedence without reading an absent export', () => {
    const config = { models: {} }
    const module = {
      config,
      get default(): never {
        throw new Error('default is not exported')
      },
    }
    expect(resolveConfigExport(module, 'cloud.config.ts')).toBe(config)
  })
})
