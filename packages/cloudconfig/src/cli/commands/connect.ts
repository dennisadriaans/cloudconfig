/**
 * `cloudconfig connect` — set up CloudConfig Connect providers.
 *
 * The OAuth apps are always the developer's own: a shared app would put
 * someone else's name on the consent screen and every user's tokens in someone
 * else's hands. What is automatable is everything around it: naming the
 * console page, printing the exact callback and webhook URLs, enabling the
 * provider in the config, writing secrets into the env file the deploy reads,
 * and generating the sealing key.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { cancel, intro, isCancel, outro, password, select, text } from '@clack/prompts'
import type { Command } from 'commander'
import pc from 'picocolors'
import {
  CONNECT_PROVIDER_IDS,
  CONNECT_PROVIDERS,
  connectCallbackUrl,
  connectWebhookUrl,
  resolveConnect,
  type ConnectProviderId,
} from '../../index.js'
import { findConfigPath, loadConfig } from '../config-load.js'
import { addProviderToConfig, manualSnippet } from '../auth-config-patch.js'
import { ensureGitignored, upsertEnvValues } from '../auth-env.js'
import { ENV_FILE, readLocalSecrets } from '../cloudflare/secrets.js'
import { randomBytes } from 'node:crypto'

const DEFAULT_DEV_URL = 'http://localhost:3000'
const PRODUCTION_PLACEHOLDER = 'https://<your-domain>'
const HEX_KEY = /^[0-9a-f]{64}$/i

/** Registers the Connect commands, including provider discovery without a project config. */
export function registerConnectCommands(program: Command): void {
  const connect = program
    .command('connect')
    .description('third-party connections: OAuth providers, MCP servers, the sealing key')
    .action(() => connectList())

  connect
    .command('list')
    .description('show all built-in providers and other connection options')
    .action(() => connectList())

  connect
    .command('add')
    .description('choose a Connect provider and set up its app credentials')
    .argument('[provider]', 'provider id; omit to choose or see available options')
    .option('--url <origin>', 'development origin used for the callback URL', DEFAULT_DEV_URL)
    .option('--no-prompt', 'skip prompts; without a provider, only list the available options')
    .action(async (provider: string | undefined, opts: { url?: string; prompt?: boolean }) => {
      await connectAdd(process.cwd(), provider, {
        ...(opts.url !== undefined ? { url: opts.url } : {}),
        ...(opts.prompt === false ? { noPrompt: true } : {}),
      })
    })

  connect
    .command('key')
    .description('generate the key that seals tokens at rest')
    .option('--rotate', 'add a new key in front of the existing ones', false)
    .action(async (opts: { rotate: boolean }) => {
      await connectKey(process.cwd(), { rotate: opts.rotate })
    })

  connect
    .command('status')
    .description('report providers, missing credentials and callback URLs')
    .option('--url <origin>', 'development origin used for the callback URL', DEFAULT_DEV_URL)
    .action(async (opts: { url?: string }) => {
      await connectStatus(process.cwd(), opts.url !== undefined ? { url: opts.url } : {})
    })
}

/** Prints the supported setup options without loading config or reading credentials. */
export function connectList(): void {
  const columnWidth = Math.max(...CONNECT_PROVIDER_IDS.map((provider) => provider.length)) + 2
  const providers = CONNECT_PROVIDER_IDS.map((provider) => {
    const { label } = CONNECT_PROVIDERS[provider]
    const services = provider === 'google' ? ' (Gmail, Calendar, Drive and other Google APIs)' : ''
    return `  ${pc.cyan(provider.padEnd(columnWidth))}${label}${services}`
  })
  console.log(
    [
      pc.bold('Built-in OAuth providers'),
      ...providers,
      '',
      `Set up a provider: ${pc.bold('cloudconfig connect add <provider>')}`,
      `Choose interactively: ${pc.bold('cloudconfig connect add')}`,
      `Check this project: ${pc.bold('cloudconfig connect status')}`,
      '',
      pc.bold('Other connection options'),
      '  Hosted MCP servers  Enable connect.mcp; users authorize the server through your app.',
      '  Custom OAuth        Define other OAuth 2.0 APIs under connect.custom.',
      '  API keys            Connect through your app; Connect seals the credentials.',
      '',
      'API-key integrations such as Cloudflare Email Sending are set up in your app,',
      'rather than with cloudconfig connect add. Gmail uses cloudconfig connect add google.',
    ].join('\n'),
  )
}

function fail(message: string): void {
  console.error(pc.red(message))
  process.exitCode = 1
}

function isSet(local: Record<string, string>, key: string): boolean {
  return Boolean(local[key] ?? process.env[key])
}

function parseProvider(value: string): ConnectProviderId {
  const id = CONNECT_PROVIDER_IDS.find((providerId) => providerId === value)
  if (!id) {
    throw new Error(
      `Unknown provider "${value}". Expected one of: ${CONNECT_PROVIDER_IDS.join(', ')}. Run "cloudconfig connect list" for all connection options. Other OAuth APIs go under connect.custom.`,
    )
  }
  return id
}

function newKey(): string {
  return randomBytes(32).toString('hex')
}

/** Make sure a sealing key exists locally; never replaces one. */
function ensureKey(projectDir: string, keyEnv: string): string | null {
  const local = readLocalSecrets(projectDir)
  if (isSet(local, keyEnv)) return null
  const file = ENV_FILE
  upsertEnvValues(projectDir, file, { [keyEnv]: newKey() })
  ensureGitignored(projectDir, file)
  return file
}

async function enableProvider(
  projectDir: string,
  configPath: string,
  provider: ConnectProviderId,
): Promise<'already' | 'added' | 'manual'> {
  const original = readFileSync(configPath, 'utf8')
  const patch = addProviderToConfig(original, provider, 'connect')
  if (patch.status === 'unchanged') return 'already'
  if (patch.status === 'manual') return 'manual'
  writeFileSync(configPath, patch.text)
  try {
    const { config } = await loadConfig(projectDir)
    if (resolveConnect(config)?.providers.some((entry) => entry.id === provider)) return 'added'
  } catch {
    // fall through to the rollback
  }
  writeFileSync(configPath, original)
  return 'manual'
}

export async function connectAdd(
  projectDir: string,
  providerValue?: string,
  opts: { url?: string; noPrompt?: boolean } = {},
): Promise<void> {
  const isInteractive = opts.noPrompt !== true && process.stdin.isTTY === true
  if (providerValue === undefined) {
    if (!isInteractive) {
      connectList()
      return
    }
    const selectedProvider = await select({
      message: 'Which provider would you like to set up?',
      options: CONNECT_PROVIDER_IDS.map((provider) => ({
        value: provider,
        label: CONNECT_PROVIDERS[provider].label,
        hint:
          provider === 'google'
            ? 'google — Gmail, Calendar, Drive and other Google APIs'
            : provider,
      })),
    })
    if (isCancel(selectedProvider)) {
      cancel('No provider selected. Nothing was written.')
      return
    }
    providerValue = selectedProvider
  }
  const provider = parseProvider(providerValue)
  const configPath = findConfigPath(projectDir)
  if (!configPath) {
    fail(`No cloud.config.ts found in ${projectDir}. Run "cloudconfig init" first.`)
    return
  }
  const info = CONNECT_PROVIDERS[provider]
  intro(pc.bold(`Connect ${info.label}`))

  const outcome = await enableProvider(projectDir, configPath, provider)
  if (outcome === 'manual') {
    console.log(
      [
        pc.yellow(`Could not edit ${configPath} safely — add this to the config yourself:`),
        '',
        manualSnippet(provider, 'connect'),
        '',
      ].join('\n'),
    )
  } else {
    console.log(
      outcome === 'already'
        ? pc.dim(`${provider} was already enabled under connect.providers.`)
        : pc.green(`Enabled ${provider} under connect.providers.`),
    )
  }

  const { config } = await loadConfig(projectDir)
  const connect = resolveConnect(config)
  const entry = connect?.providers.find((candidate) => candidate.id === provider)
  if (!connect || !entry) {
    fail('Add the provider to connect.providers, then run this command again.')
    return
  }
  const local = readLocalSecrets(projectDir)
  const devUrl = (opts.url ?? DEFAULT_DEV_URL).replace(/\/+$/, '')
  const productionOrigin =
    local[config.auth?.baseUrlEnv ?? 'BETTER_AUTH_URL'] ?? PRODUCTION_PLACEHOLDER

  const guide: (string | null)[] = [
    '',
    pc.bold('1. Create the app'),
    `   ${pc.cyan(info.console.url)}`,
    info.console.note ? pc.dim(`   ${info.console.note}`) : null,
    '',
    pc.bold('2. Register these callback URLs'),
    `   ${pc.cyan(connectCallbackUrl(devUrl, connect.basePath, provider))}   ${pc.dim('(development)')}`,
    `   ${pc.cyan(connectCallbackUrl(productionOrigin, connect.basePath, provider))}   ${pc.dim('(production)')}`,
    info.webhookNote
      ? `\n${pc.bold('   Webhook URL')}\n   ${pc.cyan(connectWebhookUrl(productionOrigin, connect.basePath, provider))}\n${pc.dim(`   ${info.webhookNote}`)}`
      : null,
    entry.scopes.length ? `\n${pc.bold('   Scopes')}  ${entry.scopes.join(' ')}` : null,
    '',
    pc.bold('3. Paste the credentials below'),
    '',
  ]
  console.log(guide.filter((line): line is string => line !== null).join('\n'))

  const values: Record<string, string> = {}
  if (isInteractive) {
    const prompts = [
      { env: entry.clientIdEnv, label: entry.clientIdEnv, secret: false, optional: false },
      { env: entry.clientSecretEnv, label: entry.clientSecretEnv, secret: true, optional: false },
      ...entry.extraEnv.map((extra) => ({
        env: extra.env,
        label: `${extra.env} — ${extra.label}${extra.optional ? ' (optional)' : ''}`,
        secret: extra.secret,
        optional: extra.optional,
      })),
    ]
    for (const prompt of prompts) {
      const answer = prompt.secret
        ? await password({ message: prompt.label })
        : await text({
            message: prompt.label,
            placeholder: prompt.optional ? 'leave empty to skip' : '',
          })
      if (isCancel(answer)) {
        cancel('Nothing was written.')
        return
      }
      const value = String(answer ?? '').trim()
      // A PEM pasted on one line keeps its newlines as \n escapes.
      if (value) values[prompt.env] = value.replace(/\r?\n/g, '\\n')
    }
  }

  const keyFile = ensureKey(projectDir, connect.keyEnv)
  if (keyFile) console.log(pc.green(`Generated ${connect.keyEnv} in ${keyFile}.`))

  const file = ENV_FILE
  if (Object.keys(values).length > 0) {
    const result = upsertEnvValues(projectDir, file, values)
    console.log(pc.green(`Wrote ${[...result.added, ...result.replaced].join(', ')} to ${file}.`))
    if (ensureGitignored(projectDir, file)) console.log(pc.green(`Added ${file} to .gitignore.`))
  } else {
    const names = [
      entry.clientIdEnv,
      entry.clientSecretEnv,
      ...entry.extraEnv.filter((extra) => !extra.optional).map((extra) => extra.env),
    ]
    console.log(
      pc.dim(`No credentials written. Add ${names.join(', ')} to ${file} when you have them.`),
    )
  }
  outro('Next: cloudconfig db generate && cloudconfig db migrate, then restart your dev server.')
}

/** `cloudconfig connect key` — create, or rotate, the sealing keyring. */
export async function connectKey(
  projectDir: string,
  opts: { rotate?: boolean } = {},
): Promise<void> {
  const { config } = await loadConfig(projectDir)
  const connect = resolveConnect(config)
  if (!connect) {
    fail('Add a connect block to cloud.config.ts first (cloudconfig connect add github).')
    return
  }
  const file = ENV_FILE
  const local = readLocalSecrets(projectDir)
  const current = (local[connect.keyEnv] ?? process.env[connect.keyEnv] ?? '').trim()
  if (current && !opts.rotate) {
    console.log(
      pc.yellow(`${connect.keyEnv} is already set. Pass --rotate to add a new key in front of it.`),
    )
    return
  }
  if (!current) {
    upsertEnvValues(projectDir, file, { [connect.keyEnv]: newKey() })
    ensureGitignored(projectDir, file)
    console.log(pc.green(`Wrote ${connect.keyEnv} to ${file}.`))
    console.log(pc.dim('`cloudconfig deploy` pushes it to the Worker as a secret.'))
    return
  }
  // Rotation keeps every old key so existing connections still open; new
  // writes and the maintenance job re-seal under the new one.
  const entries = current.split(',').map((entry, index) => {
    const trimmed = entry.trim()
    return trimmed.includes(':') ? trimmed : `k${index + 1}:${trimmed}`
  })
  if (entries.some((entry) => !HEX_KEY.test(entry.slice(entry.indexOf(':') + 1)))) {
    fail(`${connect.keyEnv} is malformed; fix it before rotating.`)
    return
  }
  const used = new Set(entries.map((entry) => entry.slice(0, entry.indexOf(':'))))
  let next = entries.length + 1
  while (used.has(`k${next}`)) next++
  const rotated = [`k${next}:${newKey()}`, ...entries].join(',')
  upsertEnvValues(projectDir, file, { [connect.keyEnv]: rotated })
  console.log(
    [
      pc.green(`Added key k${next} to ${connect.keyEnv} in ${file}.`),
      pc.dim(
        'New secrets seal under it; existing ones open with the older keys and are re-sealed by maintenance.',
      ),
      pc.dim(
        'Drop an old key only after `connect.maintain()` has run everywhere — dropping it early strands those connections.',
      ),
    ].join('\n'),
  )
}

/** `cloudconfig connect status` — providers, missing secrets, URLs. */
export async function connectStatus(
  projectDir: string,
  opts: { url?: string } = {},
): Promise<void> {
  const { config } = await loadConfig(projectDir)
  const connect = resolveConnect(config)
  if (!connect) {
    console.log(
      [
        pc.yellow('Connect is not configured.'),
        '',
        `  ${pc.bold('cloudconfig connect list')}         see all connection options`,
        `  ${pc.bold('cloudconfig connect add github')}   add the first provider`,
      ].join('\n'),
    )
    return
  }
  const local = readLocalSecrets(projectDir)
  const present = (key: string) => isSet(local, key)
  const devUrl = (opts.url ?? DEFAULT_DEV_URL).replace(/\/+$/, '')
  const lines = [
    pc.bold('\nConnect'),
    `  Mounted at   ${connect.basePath}`,
    `  Sealing key  ${present(connect.keyEnv) ? pc.green(connect.keyEnv) : pc.red(`${connect.keyEnv} missing — run: cloudconfig connect key`)}`,
    `  MCP servers  ${connect.mcp ? pc.green(connect.mcp.allowedOrigins ? connect.mcp.allowedOrigins.join(', ') : 'any https server') : pc.dim('off')}`,
    `  Managers     ${connect.managerRoles.join(', ')}`,
  ]
  if (connect.providers.length === 0) {
    lines.push(pc.dim('\n  No providers. Add one: cloudconfig connect add github'))
  } else {
    lines.push(pc.bold('\nProviders'))
    for (const provider of connect.providers) {
      const required = [
        provider.clientIdEnv,
        provider.clientSecretEnv,
        ...provider.extraEnv.filter((extra) => !extra.optional).map((extra) => extra.env),
      ]
      const missing = required.filter((name) => !present(name))
      const optional = provider.extraEnv.filter((extra) => extra.optional && !present(extra.env))
      lines.push(
        `  ${missing.length === 0 ? pc.green('●') : pc.yellow('○')} ${provider.label} ${pc.dim(`(${provider.allow.join(', ')})`)}`,
        `      ${missing.length === 0 ? pc.dim('configured') : pc.yellow(`missing ${missing.join(', ')}`)}`,
        ...(optional.length
          ? [`      ${pc.dim(`optional: ${optional.map((extra) => extra.env).join(', ')}`)}`]
          : []),
        `      ${pc.dim(connectCallbackUrl(devUrl, connect.basePath, provider.id))}`,
      )
    }
  }
  lines.push(
    pc.dim(
      `\nDeploy requires: ${connect.requiredSecrets.join(', ')}; provider secrets are pushed when set.`,
    ),
  )
  console.log(lines.join('\n'))
}
