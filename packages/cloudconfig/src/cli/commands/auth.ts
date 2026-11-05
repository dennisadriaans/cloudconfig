/**
 * `cloudconfig auth` — the credential wizard.
 *
 * The credentials are always the developer's own (no framework can hand out a
 * shared Google client without owning the consent screen and every user's
 * tokens), so this command automates the part that IS automatable: naming the
 * console page, computing the exact redirect URI, enabling the provider in the
 * config, writing the values into the env file the deploy already reads, and
 * making sure that file is git-ignored.
 *
 * Nothing here is required to build a sign-in flow — the development identity
 * provider (`cloudconfig dev`) covers that. This is the step before going live.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { cancel, intro, isCancel, outro, password, text } from '@clack/prompts'
import pc from 'picocolors'
import {
  AUTH_PROVIDER_IDS,
  providerCallbackUrl,
  providerConsole,
  providerEnvNames,
  providerLabel,
  resolveAuth,
  type AuthProviderId,
} from '../../index.js'
import { hasBetterAuth } from '../better-auth.js'
import { findConfigPath, loadConfig } from '../config-load.js'
import { addProviderToConfig, manualSnippet } from '../auth-config-patch.js'
import { ensureGitignored, generateSecret, upsertEnvValues } from '../auth-env.js'
import { ENV_FILE, readLocalSecrets } from '../cloudflare/secrets.js'
import { detectPackageManager, installDepCommand } from '../package-manager.js'

const DEFAULT_DEV_URL = 'http://localhost:3000'
const PRODUCTION_PLACEHOLDER = 'https://<your-domain>'

export interface AuthAddOptions {
  /** Origin used to render the development redirect URI. */
  url?: string
  /** Skip the credential prompts (CI, or "I'll paste them later"). */
  noPrompt?: boolean
}

function fail(message: string): void {
  console.error(pc.red(message))
  process.exitCode = 1
}

/** A secret counts as set if a local env file or the shell has it. */
function isSet(local: Record<string, string>, key: string): boolean {
  return Boolean(local[key] ?? process.env[key])
}

function parseProvider(value: string): AuthProviderId {
  const id = AUTH_PROVIDER_IDS.find((providerId) => providerId === value)
  if (!id) {
    throw new Error(
      `Unknown provider "${value}". Expected one of: ${AUTH_PROVIDER_IDS.join(', ')}.`,
    )
  }
  return id
}

/**
 * Enable the provider in `cloud.config.ts`, then prove it: the config is
 * re-loaded and the file rolled back if the provider did not actually land.
 */
async function enableProvider(
  projectDir: string,
  configPath: string,
  provider: AuthProviderId,
): Promise<'already' | 'added' | 'manual'> {
  const original = readFileSync(configPath, 'utf8')
  const patch = addProviderToConfig(original, provider)
  if (patch.status === 'unchanged') return 'already'
  if (patch.status === 'manual') return 'manual'

  writeFileSync(configPath, patch.text)
  try {
    const { config } = await loadConfig(projectDir)
    const resolved = resolveAuth(config)
    if (resolved?.providers.some((entry) => entry.id === provider)) return 'added'
  } catch {
    // fall through to the rollback
  }
  writeFileSync(configPath, original)
  return 'manual'
}

export async function authAdd(
  projectDir: string,
  providerValue: string,
  opts: AuthAddOptions = {},
): Promise<void> {
  const provider = parseProvider(providerValue)
  const configPath = findConfigPath(projectDir)
  if (!configPath) {
    fail(`No cloud.config.ts found in ${projectDir}. Run "cloudconfig init" first.`)
    return
  }

  const consoleInfo = providerConsole(provider)
  const env = providerEnvNames(provider)
  const devUrl = (opts.url ?? DEFAULT_DEV_URL).replace(/\/+$/, '')

  intro(pc.bold(`Add ${providerLabel(provider)} sign-in`))

  const outcome = await enableProvider(projectDir, configPath, provider)
  if (outcome === 'manual') {
    console.log(
      [
        pc.yellow(`Could not edit ${configPath} safely — add this to the config yourself:`),
        '',
        manualSnippet(provider),
        '',
      ].join('\n'),
    )
  } else {
    console.log(
      outcome === 'already'
        ? pc.dim(`${provider} was already enabled in cloud.config.ts.`)
        : pc.green(`Enabled ${provider} in cloud.config.ts.`),
    )
  }

  // The redirect URI has to be exact, and it is the one thing a developer
  // cannot guess — so print it before asking for anything.
  const { config } = await loadConfig(projectDir)
  const auth = resolveAuth(config)
  const authBasePath = auth?.basePath ?? '/api/auth'
  const local = readLocalSecrets(projectDir)
  const productionOrigin = local[auth?.baseUrlEnv ?? 'BETTER_AUTH_URL'] ?? PRODUCTION_PLACEHOLDER

  const guide: (string | null)[] = [
    '',
    pc.bold('1. Create the OAuth client'),
    `   ${pc.cyan(consoleInfo.url)}`,
    consoleInfo.note ? pc.dim(`   ${consoleInfo.note}`) : null,
    '',
    pc.bold('2. Register these redirect URIs'),
    `   ${pc.cyan(providerCallbackUrl(devUrl, authBasePath, provider))}   ${pc.dim('(development)')}`,
    `   ${pc.cyan(providerCallbackUrl(productionOrigin, authBasePath, provider))}   ${pc.dim('(production)')}`,
    productionOrigin === PRODUCTION_PLACEHOLDER
      ? pc.dim(
          `   Set ${auth?.baseUrlEnv ?? 'BETTER_AUTH_URL'} to your deployed URL and re-run to see the real one.`,
        )
      : null,
    '',
    pc.bold('3. Paste the credentials below'),
    '',
  ]
  console.log(guide.filter((line): line is string => line !== null).join('\n'))

  const interactive = opts.noPrompt !== true && process.stdin.isTTY === true
  const values: Record<string, string> = {}

  if (interactive) {
    const clientId = await text({
      message: `${env.clientId}`,
      placeholder: 'paste the client id',
    })
    if (isCancel(clientId)) {
      cancel('Nothing was written.')
      return
    }
    const clientSecret = await password({ message: `${env.clientSecret}` })
    if (isCancel(clientSecret)) {
      cancel('Nothing was written.')
      return
    }
    if (String(clientId).trim()) values[env.clientId] = String(clientId).trim()
    if (String(clientSecret).trim()) values[env.clientSecret] = String(clientSecret).trim()
  }

  // A signing secret is not optional, and nobody should have to be told to
  // generate one. Only ever created when it is genuinely absent.
  const secretEnv = auth?.secretEnv ?? 'BETTER_AUTH_SECRET'
  if (!isSet(local, secretEnv)) values[secretEnv] = generateSecret()

  const file = ENV_FILE
  if (Object.keys(values).length > 0) {
    const result = upsertEnvValues(projectDir, file, values)
    const written = [...result.added, ...result.replaced]
    console.log(pc.green(`Wrote ${written.join(', ')} to ${file}.`))
    if (ensureGitignored(projectDir, file)) {
      console.log(pc.green(`Added ${file} to .gitignore.`))
    }
  } else {
    console.log(
      pc.dim(
        `No credentials written. Add ${env.clientId} and ${env.clientSecret} to ${file} when you have them.`,
      ),
    )
  }

  const steps = ['cloudconfig db generate', 'cloudconfig db migrate']
  if (!hasBetterAuth(projectDir)) {
    steps.unshift(installDepCommand(detectPackageManager(projectDir), 'better-auth'))
  }
  outro(
    `Next: ${steps.join(' && ')}\nThen restart your dev server to load the auth config and credentials.`,
  )
}

/** `cloudconfig auth secret` — generate and store the session signing secret. */
export async function authSecret(
  projectDir: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const { config } = await loadConfig(projectDir)
  const auth = resolveAuth(config)
  const key = auth?.secretEnv ?? 'BETTER_AUTH_SECRET'
  const local = readLocalSecrets(projectDir)

  if (isSet(local, key) && opts.force !== true) {
    console.log(
      pc.yellow(
        `${key} is already set. Rotating it signs every open session out — re-run with --force to do it anyway.`,
      ),
    )
    return
  }

  const file = ENV_FILE
  upsertEnvValues(projectDir, file, { [key]: generateSecret() })
  console.log(pc.green(`Wrote ${key} to ${file}.`))
  if (ensureGitignored(projectDir, file)) console.log(pc.green(`Added ${file} to .gitignore.`))
  console.log(pc.dim('`cloudconfig deploy` pushes it to the Worker as a secret.'))
}

/** Configure the DashboardStack email service used by email second factors. */
export async function authEmail(
  projectDir: string,
  opts: { noPrompt?: boolean } = {},
): Promise<void> {
  const { config } = await loadConfig(projectDir)
  const factor = resolveAuth(config)?.twoFactor
  if (!factor) {
    fail('Enable auth.twoFactor: true in cloud.config.ts before configuring email OTP.')
    return
  }
  const file = ENV_FILE
  intro(pc.bold('Set up email verification codes'))
  console.log(
    'Uses @dashboardstack/email on Cloudflare. Use your deployed service URL and a project API key bound to its registered sender.',
  )
  if (opts.noPrompt) {
    outro(
      `Set ${factor.email.serviceUrlEnv} and ${factor.email.apiKeyEnv} in ${file}, then restart your dev server.`,
    )
    return
  }
  const local = readLocalSecrets(projectDir)
  const serviceUrl = await text({
    message: 'DashboardStack email service URL',
    initialValue:
      local[factor.email.serviceUrlEnv] ?? process.env[factor.email.serviceUrlEnv] ?? '',
    validate: (value) => {
      if (isHttpUrl(value ?? '')) return
      return 'Enter the http(s) URL of your DashboardStack email service.'
    },
  })
  if (isCancel(serviceUrl)) {
    cancel('No credentials written.')
    return
  }
  const apiKey = await password({
    message: 'Project email API key',
    validate: (value) => (value.trim() ? undefined : 'Enter your DashboardStack email API key.'),
  })
  if (isCancel(apiKey)) {
    cancel('No credentials written.')
    return
  }
  upsertEnvValues(projectDir, file, {
    [factor.email.apiKeyEnv]: apiKey.trim(),
    [factor.email.serviceUrlEnv]: serviceUrl.trim().replace(/\/+$/, ''),
  })
  outro(
    `Saved email credentials to ${file}. Restart your dev server to load them. CloudConfig deploy syncs them automatically.`,
  )
}

/** `cloudconfig auth status` — what is configured, what is missing, where it redirects. */
export async function authStatus(projectDir: string, opts: { url?: string } = {}): Promise<void> {
  const { config } = await loadConfig(projectDir)
  const auth = resolveAuth(config)
  if (!auth) {
    console.log(
      [
        pc.yellow('Auth is not configured.'),
        '',
        `  ${pc.bold('cloudconfig auth add github')}   enable the default provider`,
        '  Or set `auth: { emailPassword: true }` in cloud.config.ts.',
      ].join('\n'),
    )
    return
  }

  const local = readLocalSecrets(projectDir)
  const devUrl = (opts.url ?? DEFAULT_DEV_URL).replace(/\/+$/, '')
  const present = (key: string): boolean => isSet(local, key)

  const lines: string[] = [
    pc.bold('\nAuth'),
    `  Mounted at        ${auth.basePath}`,
    `  Email + password  ${auth.emailPassword ? pc.green('on') : pc.dim('off')}`,
    `  Two-factor        ${auth.twoFactor ? pc.green(auth.twoFactor.passkey === false ? 'email OTP' : 'email OTP or passkey (user choice)') : pc.dim('off')}`,
    `  Signing secret    ${present(auth.secretEnv) ? pc.green(auth.secretEnv) : pc.red(`${auth.secretEnv} missing — run: cloudconfig auth secret`)}`,
    `  Development IdP   ${auth.devIdp.enabled ? pc.green('on') : pc.dim('off')} ${pc.dim('(development only)')}`,
    `  better-auth       ${hasBetterAuth(projectDir) ? pc.green('installed') : pc.red(`missing — run: ${installDepCommand(detectPackageManager(projectDir), 'better-auth')}`)}`,
  ]

  if (auth.twoFactor) {
    const email = auth.twoFactor.email
    lines.push(
      `  Email service     ${present(email.apiKeyEnv) && present(email.serviceUrlEnv) ? pc.green('DashboardStack / Cloudflare configured') : pc.yellow(`missing ${[email.apiKeyEnv, email.serviceUrlEnv].filter((key) => !present(key)).join(', ')} — run: cloudconfig auth email`)}`,
    )
  }

  if (auth.providers.length === 0) {
    lines.push(pc.dim('\n  No social providers. Add one: cloudconfig auth add github'))
  } else {
    lines.push(pc.bold('\nProviders'))
    for (const provider of auth.providers) {
      const ok = present(provider.clientIdEnv) && present(provider.clientSecretEnv)
      lines.push(
        `  ${ok ? pc.green('●') : pc.yellow('○')} ${providerLabel(provider.id)}`,
        `      ${ok ? pc.dim(`${provider.clientIdEnv}, ${provider.clientSecretEnv}`) : pc.yellow(`missing ${[provider.clientIdEnv, provider.clientSecretEnv].filter((envName) => !present(envName)).join(', ')}`)}`,
        `      ${pc.dim(providerCallbackUrl(devUrl, auth.basePath, provider.id))}`,
      )
    }
  }

  lines.push(pc.dim(`\nDeploy requires: ${auth.requiredSecrets.join(', ')}`))
  console.log(lines.join('\n'))
}

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value.trim())) return false
  const { protocol } = new URL(value.trim())
  return protocol === 'https:' || protocol === 'http:'
}
