/**
 * `cloudconfig mcp` — run the Model Context Protocol server over stdio so an agent
 * (Claude Code, Claude Desktop, …) can manage the backend through tool calls.
 *
 * This is the MCP counterpart to `cloudconfig dev`: it boot-applies pending local
 * migrations, then serves the *same* backend — via the MCP transport adapter
 * instead of HTTP — against the local sqlite database. Every diagnostic goes to
 * stderr; stdout is reserved for the JSON-RPC stream the agent speaks.
 */
import { join } from 'node:path'
import pc from 'picocolors'
import { loadConfig } from '../config-load.js'
import { packageNameFor } from '../package-name.js'
import { applyLocalMigrations, NO_MIGRATIONS_HINT } from '../migrate-local.js'
import { detectPackageManager, installDevDepCommand } from '../package-manager.js'
import { resolveProjectConfig } from '../../shared/project-config.js'

export async function mcpCommand(projectDir: string): Promise<void> {
  const { config } = await loadConfig(projectDir)
  const resolved = resolveProjectConfig(config)
  const migrationsDir = join(projectDir, resolved.migrationsDir)
  const dbPath = join(projectDir, resolved.localDbPath)
  const serverName = packageNameFor(projectDir)
  const installCommand = installDevDepCommand(detectPackageManager(projectDir), 'better-sqlite3')

  const migrate = applyLocalMigrations(dbPath, migrationsDir, { installCommand })
  if (migrate.onDisk === 0) {
    console.error(pc.yellow(`${NO_MIGRATIONS_HINT} (then restart)`))
  } else if (migrate.applied.length > 0) {
    console.error(pc.green(`Applied ${migrate.applied.length} pending migration(s).`))
  }

  const { createMcpServer } = await import('../../server/mcp.js')
  const { sqliteFile } = await import('../../drivers/better-sqlite3.js')
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')

  // Stdio is process-local: the OS process boundary is the security boundary.
  // Anonymous is therefore an explicit opt-in here, not the library default.
  const server = createMcpServer(config, {
    db: sqliteFile(dbPath),
    allowAnonymous: true,
    serverInfo: { name: serverName, version: '0.0.0' },
  })

  await server.connect(new StdioServerTransport())
  console.error(pc.dim(`CloudConfig MCP server ready (stdio) — ${serverName}.`))
}
