import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { upsertEnvValues } from '../src/cli/auth-env.js'
import {
  readLocalSecrets,
  resolveSecretValues,
  missingSecretsMessage,
} from '../src/cli/cloudflare/secrets.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'cloudconfig-auth-env-'))
  dirs.push(dir)
  return dir
}

it('updates credentials in .env while preserving other local settings', () => {
  const dir = project()
  writeFileSync(
    join(dir, '.env'),
    'BETTER_AUTH_URL=http://localhost:3001\nexport TEST_SECRET=old\n',
  )

  upsertEnvValues(dir, '.env', { TEST_SECRET: 'new', ANOTHER_SECRET: 'added' })

  expect(readLocalSecrets(dir)).toEqual({
    BETTER_AUTH_URL: 'http://localhost:3001',
    TEST_SECRET: 'new',
    ANOTHER_SECRET: 'added',
  })
})

it('does not mistake *.local for a rule ignoring .env', () => {
  const dir = project()
  writeFileSync(join(dir, '.gitignore'), '*.local\n')
  upsertEnvValues(dir, '.env', { TEST_SECRET: 'test-value' })
  expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('\n.env\n')
  expect(existsSync(join(dir, '.dev.vars'))).toBe(false)
})

it('refuses to put credentials into a tracked env file', () => {
  const dir = project()
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  writeFileSync(join(dir, '.env'), 'PUBLIC=value\n')
  execFileSync('git', ['add', '.env'], { cwd: dir })
  expect(() => upsertEnvValues(dir, '.env', { TEST_SECRET: 'test-value' })).toThrow('tracked file')
  expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('PUBLIC=value\n')
})

it.each(['.env\n.env.*\n', '!.env.example\n.env.*\n', '.env\n!.env\n.env.*\n'])(
  'keeps credentials ignored and the example committable with existing rules: %j',
  (ignoreRules) => {
    const dir = project()
    execFileSync('git', ['init', '--quiet'], { cwd: dir })
    writeFileSync(join(dir, '.gitignore'), ignoreRules)
    writeFileSync(join(dir, '.env.example'), 'TEST_SECRET=\n')

    upsertEnvValues(dir, '.env', { TEST_SECRET: 'private-value' })

    expect(
      execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd: dir,
        encoding: 'utf8',
      }).split('\n'),
    ).toContain('.env.example')
    expect(readFileSync(join(dir, '.env.example'), 'utf8')).toBe('TEST_SECRET=\n')
    expect(execFileSync('git', ['check-ignore', '.env'], { cwd: dir, encoding: 'utf8' })).toBe(
      '.env\n',
    )
  },
)

it('reads only .env even when legacy files and an example define the same key', () => {
  const dir = project()
  writeFileSync(join(dir, '.env'), 'TEST_SECRET=current\n')
  writeFileSync(join(dir, '.dev.vars'), 'TEST_SECRET=legacy-worker\nLEGACY_ONLY=unused\n')
  writeFileSync(join(dir, '.env.local'), 'TEST_SECRET=legacy-local\nLOCAL_ONLY=unused\n')
  writeFileSync(join(dir, '.env.example'), 'TEST_SECRET=placeholder\nEXAMPLE_ONLY=unused\n')

  expect(readLocalSecrets(dir)).toEqual({ TEST_SECRET: 'current' })
})

it('requires real values when only an example or a legacy file exists', () => {
  const dir = project()
  writeFileSync(join(dir, '.env.example'), 'TEST_SECRET=placeholder\n')
  writeFileSync(join(dir, '.dev.vars'), 'TEST_SECRET=legacy\n')
  writeFileSync(join(dir, '.env.local'), 'TEST_SECRET=legacy-local\n')

  expect(resolveSecretValues(['TEST_SECRET'], dir, {})).toEqual({ values: {}, sources: {} })
  expect(missingSecretsMessage(['TEST_SECRET'])).toContain('Set them in .env (git-ignored)')
})

it('lets CI override .env and includes only declared, nonempty secrets', () => {
  const dir = project()
  writeFileSync(join(dir, '.env'), 'TEST_SECRET=local\nFILE_SECRET=file-value\nEMPTY_SECRET=\n')

  expect(
    resolveSecretValues(['TEST_SECRET', 'FILE_SECRET', 'EMPTY_SECRET'], dir, {
      TEST_SECRET: 'ci-value',
      UNDECLARED_SECRET: 'unused',
    }),
  ).toEqual({
    values: { TEST_SECRET: 'ci-value', FILE_SECRET: 'file-value' },
    sources: { TEST_SECRET: 'env', FILE_SECRET: 'file' },
  })
})
