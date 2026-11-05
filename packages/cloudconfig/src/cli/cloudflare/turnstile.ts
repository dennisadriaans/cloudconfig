import type { DeployConfig } from '../../dsl/model-config.js'
import { detectFramework } from '../detect.js'
import { wrangler } from './wrangler-ops.js'
import {
  isValidCustomDomain,
  readCustomDomains,
  readVars,
  setVar,
  writeWranglerFile,
  type WranglerFile,
} from './wrangler-config.js'

export const TURNSTILE_SECRET = 'TURNSTILE_SECRET_KEY'

interface Widget {
  sitekey: string
  name: string
  domains: string[]
  secret?: string
}

interface TurnstilePlan {
  siteKey?: string
  binding: string
  domains: string[]
}

/** Validate locally before provisioning anything, including on dry runs. */
export function planTurnstile(
  projectDir: string,
  file: WranglerFile,
  deploy: DeployConfig,
): TurnstilePlan | undefined {
  if (!deploy.turnstile) return
  const options = deploy.turnstile === true ? {} : deploy.turnstile
  const framework = detectFramework(projectDir)
  const publicBindings = {
    nuxt: 'NUXT_PUBLIC_TURNSTILE_SITE_KEY',
    next: 'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
    standalone: 'TURNSTILE_SITE_KEY',
  }
  const binding = options.siteKeyBinding ?? publicBindings[framework]
  if (!/^[A-Z][A-Z0-9_]*$/.test(binding) || binding === TURNSTILE_SECRET) {
    throw new Error(
      'deploy.turnstile.siteKeyBinding must be a public environment variable name, distinct from TURNSTILE_SECRET_KEY.',
    )
  }
  if (file.format === 'toml') {
    throw new Error(
      'Automatic Turnstile setup requires wrangler.jsonc. Convert the Wrangler config before deploying.',
    )
  }
  const domains = [
    ...new Set([
      ...(deploy.domain ? [deploy.domain.trim()] : []),
      ...readCustomDomains(file.text),
      ...(options.domains ?? []),
    ]),
  ]
  if (
    !domains.length ||
    domains.some((domain) => domain !== 'localhost' && !isValidCustomDomain(domain))
  ) {
    throw new Error(
      'Turnstile needs allowed hostnames. Set deploy.domain or deploy.turnstile.domains (no URLs or wildcards).',
    )
  }
  const saved = readVars(file.text)[binding]
  const siteKey = options.siteKey ?? (typeof saved === 'string' && saved ? saved : undefined)
  return { binding, domains, ...(siteKey ? { siteKey } : {}) }
}

/** Keep raw command output private: get/create include the widget secret. */
async function widgetCommand<T>(projectDir: string, args: string[]): Promise<T> {
  const result = await wrangler(projectDir, [
    'turnstile',
    'widget',
    ...args,
    '--json',
    '--config',
    '/dev/null',
  ])
  if (result.code !== 0) {
    throw new Error(
      `Turnstile ${args[0]} failed. Use a current Wrangler version and Cloudflare credentials with Turnstile Read/Edit access. Check the configured site key and account.`,
    )
  }
  try {
    return JSON.parse(result.stdout) as T
  } catch {
    throw new Error(
      'Wrangler returned invalid Turnstile JSON. Update Wrangler and retry; no secret output was logged.',
    )
  }
}

/** Reuse widgets and never rotate their secret or remove existing domains. */
export interface TurnstileTarget {
  projectDir: string
  file: WranglerFile
  workerName: string
}

export async function ensureTurnstile(
  { projectDir, file, workerName }: TurnstileTarget,
  plan: TurnstilePlan,
  dryRun: boolean,
): Promise<{ buildEnv: Record<string, string>; secret?: string }> {
  let siteKey = plan.siteKey
  if (!siteKey) {
    const widgets = await widgetCommand<Widget[]>(projectDir, ['list'])
    const matches = widgets.filter((widget) => widget.name === workerName)
    if (matches.length > 1) {
      throw new Error(
        'Multiple Turnstile widgets match the Worker name. Set deploy.turnstile.siteKey to choose one.',
      )
    }
    siteKey = matches[0]?.sitekey
  }

  let widget: Widget
  if (siteKey) {
    widget = await widgetCommand<Widget>(projectDir, ['get', siteKey])
  } else if (dryRun) {
    console.log(`Would create a managed Turnstile widget for ${plan.domains.join(', ')}.`)
    console.log(`Would set ${plan.binding} for the build and Worker, and sync ${TURNSTILE_SECRET}.`)
    return { buildEnv: {} }
  } else {
    widget = await widgetCommand<Widget>(projectDir, [
      'create',
      workerName,
      '--mode',
      'managed',
      '--domain',
      plan.domains.join(','),
    ])
    console.log(
      `Created Turnstile widget for ${plan.domains.join(', ')}. It is retained if the build fails.`,
    )
  }

  if (!widget.sitekey || !widget.secret || !Array.isArray(widget.domains)) {
    throw new Error(
      'Turnstile did not return a site key, secret, and domains. Deployment stopped before the build.',
    )
  }

  // Save the public key immediately so a retry can recover a newly created widget.
  if (!dryRun) writeWranglerFile(file, setVar(file.text, plan.binding, widget.sitekey))
  const missingDomains = plan.domains.filter((domain) => !widget.domains.includes(domain))
  if (missingDomains.length) {
    const domains = [...new Set([...widget.domains, ...plan.domains])]
    if (dryRun) console.log(`Would allow Turnstile on ${missingDomains.join(', ')}.`)
    else {
      await widgetCommand(projectDir, ['update', widget.sitekey, '--domain', domains.join(',')])
      console.log(`Added Turnstile hostnames: ${missingDomains.join(', ')}.`)
    }
  }
  console.log(
    `${dryRun ? 'Would use' : 'Using'} Turnstile widget ${widget.sitekey}; its matching secret will be synced automatically.`,
  )
  return { buildEnv: { [plan.binding]: widget.sitekey }, secret: widget.secret }
}
