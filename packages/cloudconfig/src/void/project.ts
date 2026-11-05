import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { createJiti } from 'jiti'
import { compileTables } from '../server/index.js'
import {
  resolveAuth,
  resolveConnect,
  resolveProjectConfig,
  workerExports,
  type AnyConfig,
} from '../index.js'
import { GENERATED_VOID_HEADER, relativeImportPath, voidProjectPaths } from './paths.js'
import { renderVoidWorkerModule } from './worker.js'
import {
  mirrorVoidMigrations,
  parseVoidMigrationApprovals,
  readApprovedMigrationAnnotations,
  VOID_MIGRATION_MARKER,
} from './migrations.js'

export interface VoidProjectOptions {
  projectDir: string
  configPath: string
  config: AnyConfig
  /** Native Void gets a generated API mount; frameworks retain their existing mount. */
  mount?: 'void' | 'framework'
  /** External env.ts files can compose the generated environment schema themselves. */
  environment?: 'generate' | 'external'
  /** Exact source hashes approved for Void's destructive pragma in the generated mirror. */
  approvedDestructiveMigrations?: Readonly<Record<string, string>>
}

function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (cause) {
    if (isMissingFile(cause)) return undefined
    throw cause
  }
}

async function readVoidLayout(projectDir: string) {
  const typedPath = resolve(projectDir, 'void.config.ts')
  const legacy = await readOptionalFile(resolve(projectDir, 'void.json'))
  const typed = await readOptionalFile(typedPath)
  if (typed !== undefined && legacy !== undefined) {
    throw new Error('Keep one Void configuration: void.config.ts or void.json.')
  }
  let config: unknown = legacy === undefined ? {} : JSON.parse(legacy)
  let approvals: unknown
  if (typed !== undefined) {
    const jiti = createJiti(import.meta.url, { interopDefault: false })
    const loaded: unknown = await jiti.import(typedPath)
    config = isRecord(loaded) ? loaded.default : undefined
    approvals = isRecord(loaded) ? loaded.cloudconfigApprovedDestructiveMigrations : undefined
  }
  if (!isRecord(config)) throw new Error('Void configuration must export an object.')
  if (config.sourceDir !== undefined && typeof config.sourceDir !== 'string') {
    throw new Error('Void sourceDir must be a relative application directory.')
  }
  return {
    ...(typeof config.sourceDir === 'string' ? { sourceDir: config.sourceDir } : {}),
    isFramework: isRecord(config.inference) && config.inference.appType === 'framework',
    approvedDestructiveMigrations: parseVoidMigrationApprovals(approvals),
  }
}

async function assertGeneratedFile(path: string): Promise<void> {
  const content = await readOptionalFile(path)
  if (content !== undefined && !content.startsWith(GENERATED_VOID_HEADER)) {
    throw new Error(
      `Refusing to replace application-owned file ${path}. Keep it separate from CloudConfig's generated entry points.`,
    )
  }
}

async function writeGeneratedFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

/**
 * Export the schema, migrations, environment declarations and optional native API mount.
 * Reads Void's sourceDir without moving its routes/jobs into generated output. Authored
 * forwarding files and migration directories are never replaced. No database is opened.
 */
export async function prepareVoidProject(options: VoidProjectOptions) {
  const { projectDir, configPath, config } = options
  const layout = await readVoidLayout(projectDir)
  const paths = voidProjectPaths(projectDir, layout.sourceDir)
  const migrationsSource = resolve(projectDir, resolveProjectConfig(config).migrationsDir)
  if (
    migrationsSource === paths.generatedRoot ||
    migrationsSource.startsWith(`${paths.generatedRoot}${sep}`) ||
    (migrationsSource !== paths.migrationsPath &&
      (migrationsSource.startsWith(`${paths.migrationsPath}${sep}`) ||
        paths.migrationsPath.startsWith(`${migrationsSource}${sep}`)))
  ) {
    throw new Error(
      'Keep authoritative migrations outside generated output and separate from their mirror.',
    )
  }
  // Validate the source before changing any previously usable generated artifacts.
  await readFile(resolve(migrationsSource, 'meta/_journal.json'), 'utf8')
  const annotations = await readApprovedMigrationAnnotations(
    migrationsSource,
    paths.migrationsPath,
    parseVoidMigrationApprovals(
      options.approvedDestructiveMigrations ?? layout.approvedDestructiveMigrations,
    ),
  )
  await assertGeneratedFile(paths.schemaPath)
  if (options.environment !== 'external') await assertGeneratedFile(paths.environmentFilePath)
  if (migrationsSource !== paths.migrationsPath) {
    const marker = await readOptionalFile(resolve(paths.migrationsPath, VOID_MIGRATION_MARKER))
    if (marker !== GENERATED_VOID_HEADER) {
      try {
        if ((await readdir(paths.migrationsPath)).length) {
          throw new Error(
            `Refusing to replace application-owned migrations at ${paths.migrationsPath}. Set db.migrationsDir to this path to share the authoritative history.`,
          )
        }
      } catch (cause) {
        if (!isMissingFile(cause)) throw cause
      }
    }
  }
  const tableNames = Object.keys(compileTables(config)).sort()
  const auth = resolveAuth(config)
  const connect = resolveConnect(config)
  const requiredSecrets = new Set([
    ...(auth?.requiredSecrets ?? []),
    ...(auth ? [auth.baseUrlEnv, auth.productionUrlEnv] : []),
    ...(connect?.requiredSecrets ?? []),
    ...(config.deploy?.secrets ?? []),
  ])
  const optionalSecrets = new Set([
    ...(connect?.optionalSecrets ?? []),
    ...(config.deploy?.optionalSecrets ?? []),
  ])
  const mount = options.mount ?? (layout.isFramework ? 'framework' : 'void')
  const declarations = mount === 'void' ? workerExports(config.deploy) : []
  for (const declaration of declarations) {
    const entryPath = resolve(projectDir, declaration.entry)
    if (!(await stat(entryPath)).isFile()) {
      throw new Error(`Worker entry must be a file: ${declaration.entry}`)
    }
  }
  const routesRoot = resolve(paths.sourceRoot, 'routes')
  const basePath = resolveProjectConfig(config).basePath
  if (
    mount === 'void' &&
    basePath
      .split('/')
      .some((segment) => segment === '.' || segment === '..' || /[\\*:[\]?%#]/.test(segment))
  ) {
    throw new Error('Use static URL path segments for the native Void API mount.')
  }
  const apiPath = resolve(routesRoot, `.${basePath}`, '[...cloudconfig].ts')
  if (mount === 'void' && !apiPath.startsWith(`${routesRoot}${sep}`)) {
    throw new Error('The generated Void API mount must stay inside routes/.')
  }
  if (mount === 'void') await assertGeneratedFile(apiPath)

  const schema = [
    GENERATED_VOID_HEADER,
    `import * as configModule from ${JSON.stringify(relativeImportPath(paths.generatedSchemaPath, resolve(projectDir, configPath)))}`,
    `import { resolveConfigExport } from '@cloudconfig/core'`,
    `import { compileTables } from '@cloudconfig/core/server'`,
    '',
    `const tables = compileTables(resolveConfigExport(configModule, ${JSON.stringify(configPath)}))`,
    ...tableNames.map(
      (name, index) =>
        `const table${index} = tables[${JSON.stringify(name)}]!\nexport { table${index} as ${JSON.stringify(name)} }`,
    ),
    '',
  ].join('\n')
  const environment = [
    GENERATED_VOID_HEADER,
    `import { defineEnv, string } from 'void/env'`,
    '',
    'export const environmentSchema = {',
    ...[...new Set([...requiredSecrets, ...optionalSecrets])]
      .sort()
      .map(
        (name) =>
          `  ${JSON.stringify(name)}: string()${requiredSecrets.has(name) ? '' : '.optional()'},`,
      ),
    '}',
    '',
    'export default defineEnv(environmentSchema)',
    '',
  ].join('\n')
  await mirrorVoidMigrations(migrationsSource, paths.migrationsPath, annotations)
  await writeGeneratedFile(paths.generatedSchemaPath, schema)
  await writeGeneratedFile(paths.envPath, environment)
  await writeGeneratedFile(
    paths.schemaPath,
    `${GENERATED_VOID_HEADER}\nexport * from ${JSON.stringify(relativeImportPath(paths.schemaPath, paths.generatedSchemaPath))}\n`,
  )
  if (options.environment !== 'external') {
    await writeGeneratedFile(
      paths.environmentFilePath,
      `${GENERATED_VOID_HEADER}\nexport { default } from ${JSON.stringify(relativeImportPath(paths.environmentFilePath, paths.envPath))}\n`,
    )
  }
  if (mount === 'void') {
    const api = [
      GENERATED_VOID_HEADER,
      `import { defineHandler } from 'void'`,
      `import { createVoidBackend } from '@cloudconfig/core/void/server'`,
      `import { resolveConfigExport } from '@cloudconfig/core'`,
      `import * as configModule from ${JSON.stringify(relativeImportPath(apiPath, resolve(projectDir, configPath)))}`,
      '',
      `const backend = createVoidBackend(resolveConfigExport(configModule, ${JSON.stringify(configPath)}))`,
      'export const GET = defineHandler((context) => {',
      '  const env = import.meta.env.CLOUDCONFIG_VOID_DEV === true',
      '    ? { ...context.env, NODE_ENV: "development" } : context.env',
      '  return backend.fetch(context.req.raw, env)',
      '})',
      // Hono handles HEAD through GET. Void 1.1.11 compiles an explicit HEAD
      // export to app.head(), which Hono does not implement.
      ...['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map(
        (method) => `export const ${method} = GET`,
      ),
      '',
    ].join('\n')
    await writeGeneratedFile(apiPath, api)
  }
  if (declarations.length) {
    await writeGeneratedFile(
      paths.generatedWorkerPath,
      renderVoidWorkerModule({
        config,
        projectDir,
        configPath,
        modulePath: paths.generatedWorkerPath,
      }),
    )
  }
  return {
    ...paths,
    tableNames,
    ...(declarations.length ? { workerModulePath: paths.generatedWorkerPath } : {}),
    requiredSecrets: [...requiredSecrets],
    ...(mount === 'void' ? { apiPath } : {}),
  }
}
