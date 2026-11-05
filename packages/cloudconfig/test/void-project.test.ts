import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defineBackend, model, t } from '../src/index.js'
import { createVoidBackendConfig } from '../src/void/config.js'
import { prepareVoidProject } from '../src/void/project.js'
import { cloudconfigVoid } from '../src/void/vite.js'

const config = defineBackend({
  models: { note: model({ title: t.text().required() }) },
  auth: { providers: { github: true }, organizations: true },
  connect: { providers: { github: true }, mcp: true },
})

async function withProject(run: (projectDir: string) => Promise<void>) {
  const projectDir = await mkdtemp(resolve(tmpdir(), 'cloudconfig-void-'))
  try {
    await mkdir(resolve(projectDir, 'migrations/meta'), { recursive: true })
    await writeFile(resolve(projectDir, 'migrations/meta/_journal.json'), '{"entries":[]}\n')
    await writeFile(
      resolve(projectDir, 'migrations/0000_initial.sql'),
      'CREATE TABLE notes (id INTEGER);\n',
    )
    await run(projectDir)
  } finally {
    await rm(projectDir, { recursive: true, force: true })
  }
}

describe('Void schema extension', () => {
  it('annotates only hash-approved destructive history and leaves original SQL unchanged', async () => {
    await withProject(async (projectDir) => {
      const approvedSql = 'DROP TABLE retired;\n'
      const unapprovedSql = 'DROP TABLE another;\n'
      await writeFile(resolve(projectDir, 'migrations/0001_retired.sql'), approvedSql)
      await writeFile(resolve(projectDir, 'migrations/0002_another.sql'), unapprovedSql)
      const hash = createHash('sha256').update(approvedSql).digest('hex')
      await writeFile(
        resolve(projectDir, 'void.config.ts'),
        `export default {}\nexport const cloudconfigApprovedDestructiveMigrations = ${JSON.stringify({ '0001_retired.sql': hash })}\n`,
      )
      const options = { projectDir, configPath: 'cloud.config.ts', config }
      const prepared = await prepareVoidProject(options)
      const mirror = resolve(prepared.migrationsPath, '0001_retired.sql')
      expect(await readFile(mirror, 'utf8')).toBe(`-- void:allow-destructive\n${approvedSql}`)
      expect(await readFile(resolve(projectDir, 'migrations/0001_retired.sql'), 'utf8')).toBe(
        approvedSql,
      )
      expect(await readFile(resolve(prepared.migrationsPath, '0002_another.sql'), 'utf8')).toBe(
        unapprovedSql,
      )
      await writeFile(
        resolve(projectDir, 'migrations/0001_retired.sql'),
        `${approvedSql}-- changed\n`,
      )
      await expect(prepareVoidProject(options)).rejects.toThrow(/changed since its Void approval/)
      expect(await readFile(mirror, 'utf8')).toBe(`-- void:allow-destructive\n${approvedSql}`)
    })
  })

  it('rejects invalid approval paths and never annotates shared authoritative SQL', async () => {
    await withProject(async (projectDir) => {
      const options = { projectDir, configPath: 'cloud.config.ts', config }
      await expect(
        prepareVoidProject({
          ...options,
          approvedDestructiveMigrations: { '../outside.sql': 'f'.repeat(64) },
        }),
      ).rejects.toThrow(/Invalid Void migration approval/)
      const hash = createHash('sha256')
        .update(await readFile(resolve(projectDir, 'migrations/0000_initial.sql')))
        .digest('hex')
      await writeFile(
        resolve(projectDir, 'void.json'),
        JSON.stringify({ sourceDir: 'application' }),
      )
      await mkdir(resolve(projectDir, 'application/db/migrations/meta'), { recursive: true })
      await writeFile(
        resolve(projectDir, 'application/db/migrations/meta/_journal.json'),
        '{"entries":[]}\n',
      )
      const sql = 'CREATE TABLE notes (id INTEGER);\n'
      await writeFile(resolve(projectDir, 'application/db/migrations/0000_initial.sql'), sql)
      await expect(
        prepareVoidProject({
          ...options,
          config: { ...config, db: { migrationsDir: 'application/db/migrations' } },
          approvedDestructiveMigrations: { '0000_initial.sql': hash },
        }),
      ).rejects.toThrow(/authoritative SQL is never annotated/)
      expect(
        await readFile(resolve(projectDir, 'application/db/migrations/0000_initial.sql'), 'utf8'),
      ).toBe(sql)
    })
  })

  it('keeps application conventions at the root and supports an explicit sourceDir', () => {
    const options = { name: 'void-example', compatibilityDate: '2026-10-14' }
    const root = createVoidBackendConfig(config, options)
    expect(root).not.toHaveProperty('sourceDir')
    expect(root.inference.appType).toBe('void')
    expect(root.inference).not.toHaveProperty('build')
    expect(root.cloudflare.d1_databases[0]?.migrations_dir).toBe('db/migrations')
    const nested = createVoidBackendConfig(config, { ...options, sourceDir: 'src' })
    expect(nested.sourceDir).toBe('src')
    expect(nested.cloudflare.d1_databases[0]?.migrations_dir).toBe('src/db/migrations')
    expect(() => createVoidBackendConfig(config, { ...options, sourceDir: '../outside' })).toThrow(
      /relative application/,
    )
    expect(() =>
      createVoidBackendConfig(config, { ...options, sourceDir: '.cloudconfig/void' }),
    ).toThrow(/generated/)
  })

  it('generates the API and auth/Connect schema without moving or replacing native jobs', async () => {
    await withProject(async (projectDir) => {
      await mkdir(resolve(projectDir, 'crons'), { recursive: true })
      await writeFile(resolve(projectDir, 'crons/maintenance.ts'), 'application-owned cron')
      const prepared = await prepareVoidProject({
        projectDir,
        configPath: 'cloud.config.ts',
        config,
      })
      expect(prepared.schemaPath).toBe(resolve(projectDir, 'db/schema.ts'))
      expect(prepared.tableNames).toEqual(
        expect.arrayContaining(['note', 'user', 'session', 'account', 'connectConnection']),
      )
      expect(await readFile(prepared.schemaPath, 'utf8')).toContain('export * from')
      expect(await readFile(prepared.environmentFilePath, 'utf8')).toContain(
        'from "./.cloudconfig/void/env.ts"',
      )
      expect(await readFile(prepared.envPath, 'utf8')).toContain('"BETTER_AUTH_SECRET": string()')
      expect(
        await readFile(resolve(projectDir, 'routes/api/[...cloudconfig].ts'), 'utf8'),
      ).toContain('@cloudconfig/core/void/server')
      expect(await readFile(resolve(projectDir, 'crons/maintenance.ts'), 'utf8')).toBe(
        'application-owned cron',
      )
      expect(await readFile(resolve(prepared.migrationsPath, '0000_initial.sql'), 'utf8')).toBe(
        await readFile(resolve(projectDir, 'migrations/0000_initial.sql'), 'utf8'),
      )
    })
  })

  it('follows sourceDir while preserving a framework-owned API mount', async () => {
    await withProject(async (projectDir) => {
      await writeFile(
        resolve(projectDir, 'void.json'),
        JSON.stringify({ sourceDir: 'src', inference: { appType: 'framework' } }),
      )
      const prepared = await prepareVoidProject({
        projectDir,
        configPath: 'cloud.config.ts',
        config,
      })
      expect(prepared.schemaPath).toBe(resolve(projectDir, 'src/db/schema.ts'))
      expect(prepared.environmentFilePath).toBe(resolve(projectDir, 'src/env.ts'))
      expect(prepared).not.toHaveProperty('apiPath')
      await expect(
        readFile(resolve(projectDir, 'src/routes/api/[...cloudconfig].ts')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('refuses authored files and migration directories before writing generated artifacts', async () => {
    await withProject(async (projectDir) => {
      const environment = 'export default { APPLICATION_KEY: "keep me" }\n'
      await writeFile(resolve(projectDir, 'env.ts'), environment)
      await expect(
        prepareVoidProject({ projectDir, configPath: 'cloud.config.ts', config }),
      ).rejects.toThrow(/application-owned file/)
      expect(await readFile(resolve(projectDir, 'env.ts'), 'utf8')).toBe(environment)
      await expect(
        readFile(resolve(projectDir, '.cloudconfig/void/db/schema.ts')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await mkdir(resolve(projectDir, 'db/migrations'), { recursive: true })
      await writeFile(resolve(projectDir, 'db/migrations/customer.sql'), 'keep this history')
      await expect(
        prepareVoidProject({
          projectDir,
          configPath: 'cloud.config.ts',
          config,
          environment: 'external',
        }),
      ).rejects.toThrow(/application-owned migrations/)
      expect(await readFile(resolve(projectDir, 'db/migrations/customer.sql'), 'utf8')).toBe(
        'keep this history',
      )
    })
  })

  it('refreshes only its own mirror and supports explicit environment composition', async () => {
    await withProject(async (projectDir) => {
      const environment = 'export default { APPLICATION_KEY: "keep me" }\n'
      await writeFile(resolve(projectDir, 'env.ts'), environment)
      const options = {
        projectDir,
        configPath: 'cloud.config.ts',
        config,
        environment: 'external' as const,
      }
      const prepared = await prepareVoidProject(options)
      await writeFile(resolve(prepared.migrationsPath, 'stale.sql'), 'remove this generated file')
      await prepareVoidProject(options)
      await expect(readFile(resolve(prepared.migrationsPath, 'stale.sql'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(await readFile(resolve(projectDir, 'env.ts'), 'utf8')).toBe(environment)
      expect(await readFile(prepared.envPath, 'utf8')).toContain(
        '"CLOUDCONFIG_CONNECT_KEY": string()',
      )
      expect(await readFile(prepared.envPath, 'utf8')).toContain(
        'export const environmentSchema = {',
      )
    })
  })

  it('shares an authoritative migration directory without replacing it', async () => {
    await withProject(async (projectDir) => {
      await mkdir(resolve(projectDir, 'db/migrations/meta'), { recursive: true })
      await writeFile(resolve(projectDir, 'db/migrations/meta/_journal.json'), '{"entries":[]}\n')
      await writeFile(resolve(projectDir, 'db/migrations/customer.sql'), 'authoritative history')
      const prepared = await prepareVoidProject({
        projectDir,
        configPath: 'cloud.config.ts',
        config: { ...config, db: { migrationsDir: 'db/migrations' } },
      })
      expect(await readFile(resolve(prepared.migrationsPath, 'customer.sql'), 'utf8')).toBe(
        'authoritative history',
      )
      await expect(
        readFile(resolve(prepared.migrationsPath, '.cloudconfig-generated')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('prepares files before the Vite helper resolves and rejects a different Vite root', async () => {
    await withProject(async (projectDir) => {
      await writeFile(
        resolve(projectDir, 'cloud.config.ts'),
        'export default { models: {}, auth: { providers: { github: true } } }\n',
      )
      const plugin = await cloudconfigVoid({ projectDir })
      expect(plugin.name).toBe('cloudconfig:void')
      expect(await readFile(resolve(projectDir, 'db/schema.ts'), 'utf8')).toContain('export * from')
      expect(
        await readFile(resolve(projectDir, 'routes/api/[...cloudconfig].ts'), 'utf8'),
      ).toContain('backend.fetch(context.req.raw, env)')
      expect(
        await readFile(resolve(projectDir, 'routes/api/[...cloudconfig].ts'), 'utf8'),
      ).toContain('import.meta.env.CLOUDCONFIG_VOID_DEV === true')
      expect(
        plugin.config({}, { command: 'serve' }).define['import.meta.env.CLOUDCONFIG_VOID_DEV'],
      ).toBe('true')
      expect(
        plugin.config({}, { command: 'build' }).define['import.meta.env.CLOUDCONFIG_VOID_DEV'],
      ).toBe('false')
      expect(
        plugin.config({}, { command: 'serve', isPreview: true }).define[
          'import.meta.env.CLOUDCONFIG_VOID_DEV'
        ],
      ).toBe('false')
      expect(() => plugin.configResolved({ root: projectDir })).not.toThrow()
      expect(() => plugin.configResolved({ root: resolve(projectDir, 'other') })).toThrow(
        /same root/,
      )
      expect(plugin.transform('original', resolve(projectDir, '.void/entry.ts'))).toBeUndefined()
    })
  })

  it('attaches native agent, automation and Workflow exports only to the Void Worker entry', async () => {
    await withProject(async (projectDir) => {
      const deployment = {
        agent: { entry: 'server/agent.ts' },
        automations: { entry: 'server/jobs.ts' },
        workflows: [
          {
            entry: 'server/legacy.ts',
            binding: 'LEGACY',
            className: 'LegacyWorkflow',
            name: 'legacy',
          },
        ],
      }
      await mkdir(resolve(projectDir, 'server'))
      for (const entry of ['agent.ts', 'jobs.ts', 'legacy.ts']) {
        await writeFile(resolve(projectDir, 'server', entry), 'export default {}\n')
      }
      await writeFile(
        resolve(projectDir, 'cloud.config.ts'),
        `export default ${JSON.stringify({ models: {}, auth: { providers: { github: true } }, deploy: deployment })}\n`,
      )
      const plugin = await cloudconfigVoid({ projectDir })
      const workerModulePath = resolve(projectDir, '.cloudconfig/void/worker.ts')
      const source = await readFile(workerModulePath, 'utf8')
      expect(source).toContain('export const CloudconfigAgent = createCloudflareAgent(agentHost)')
      expect(source).toContain('cloudflareAgentPlatform(env?.["CLOUDCONFIG_AGENTS"])')
      expect(source).toContain('export const CloudconfigAutomations = createCloudflareAutomations(')
      expect(source).toContain('withConnectAutomations(automationHost, automationConfig)')
      expect(source).toContain('export { LegacyWorkflow } from "../../server/legacy.ts"')
      const transformed = plugin.transform(
        'export default { fetch() {} }',
        `${resolve(projectDir, '.void/entry.ts')}?worker`,
      )
      expect(transformed?.code).toContain('export default { fetch() {} }')
      expect(transformed?.code).toContain(
        `export * from ${JSON.stringify(workerModulePath.replaceAll('\\', '/'))}`,
      )
      expect(plugin.transform('original', resolve(projectDir, 'routes/index.ts'))).toBeUndefined()
    })
  })

  it('rejects a missing native Worker host before writing generated output', async () => {
    await withProject(async (projectDir) => {
      await expect(
        prepareVoidProject({
          projectDir,
          configPath: 'cloud.config.ts',
          config: { ...config, deploy: { agent: { entry: 'server/missing.ts' } } },
        }),
      ).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(
        readFile(resolve(projectDir, '.cloudconfig/void/db/schema.ts')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('leaves Worker export ownership with frameworks', async () => {
    await withProject(async (projectDir) => {
      await writeFile(
        resolve(projectDir, 'cloud.config.ts'),
        'export default { models: {}, auth: { providers: { github: true } }, deploy: { agent: { entry: "server/framework-host.ts" } } }\n',
      )
      const plugin = await cloudconfigVoid({ projectDir, mount: 'framework' })
      expect(plugin.transform('original', resolve(projectDir, '.void/entry.ts'))).toBeUndefined()
      await expect(
        readFile(resolve(projectDir, '.cloudconfig/void/worker.ts')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })
})
