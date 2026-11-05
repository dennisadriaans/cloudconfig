import pc from 'picocolors'
import { resolveAuth } from '../../shared/auth-resolve.js'
import { resolveConnect } from '../../shared/connect-resolve.js'
import { resolveSecretValues } from '../cloudflare/secrets.js'
import type { DeploymentRequest, HostingAdapter } from './ports.js'
import { prepareDataDeployment } from './data.js'
import { prepareTurnstileDeployment } from './adapters/turnstile.js'
import { isValidCustomDomain } from '../cloudflare/wrangler-config.js'
import { agentDeployment, workerExports } from '../../shared/worker-exports.js'
import { prepareAutomationDeployment } from './automations.js'

/** Shared use case: validate -> build -> provision/migrate -> publish with secrets. */
export async function deployHostedProject(
  request: DeploymentRequest,
  host: HostingAdapter,
): Promise<void> {
  const { config, projectDir, options, target } = request
  workerExports(config.deploy)
  if (config.deploy?.domain && !isValidCustomDomain(config.deploy.domain)) {
    throw new Error('deploy.domain must be a hostname without a scheme, path, port or wildcard.')
  }
  if (config.deploy?.workflows?.length) {
    throw new Error(
      `deploy.target "${target}" does not support Cloudflare Workflow classes. Use deploy.agent for portable agents, or keep deploy.workflows on Cloudflare.`,
    )
  }
  const agent = agentDeployment(config.deploy)
  if (agent && target === 'vercel' && request.framework !== 'nuxt') {
    throw new Error(
      'Automatic Vercel agent deployment currently requires Nuxt and workflow/nuxt. Other frameworks must configure the Workflow integration and agent platform explicitly.',
    )
  }
  if (target === 'azure' && config.deploy?.domain) {
    throw new Error(
      'Automatic deploy.domain setup is not available on Azure App Service yet. Bind the hostname and certificate in Azure before using that domain; omit deploy.domain to use the Azure hostname.',
    )
  }
  const auth = resolveAuth(config)
  const connect = resolveConnect(config)
  const automations = prepareAutomationDeployment(request)
  const turnstile = prepareTurnstileDeployment(request)
  const required = [
    ...new Set([
      ...(config.deploy?.secrets ?? []),
      ...(auth?.requiredSecrets ?? []),
      ...(connect?.requiredSecrets ?? []),
    ]),
  ]
  const optional = [...(config.deploy?.optionalSecrets ?? []), ...(connect?.optionalSecrets ?? [])]
  const { values } = resolveSecretValues([...required, ...optional], projectDir)
  const missing = required.filter(
    (name) => !values[name] && !(turnstile && name === 'TURNSTILE_SECRET_KEY'),
  )
  if (missing.length) {
    throw new Error(
      `Missing required secret(s): ${missing.join(', ')}. Set them in the environment or .env.`,
    )
  }
  const data = prepareDataDeployment(request)
  const env = { ...values, ...data.env, ...automations?.env, NODE_ENV: 'production' }

  if (options.dryRun) {
    console.log(
      pc.dim(
        `Would build ${request.framework} for ${target}, provision/check the existing data services, apply pending migrations, and publish "${request.name}".`,
      ),
    )
    if (agent) {
      console.log(
        pc.dim(
          target === 'azure'
            ? 'Agent execution: a separate Durable Functions app and private Storage account on the web app plan.'
            : 'Agent execution: Vercel Workflow with private records in the configured database.',
        ),
      )
    }
    console.log(pc.dim(`Runtime setting names: ${Object.keys(env).sort().join(', ')}`))
    if (automations) {
      console.log(
        pc.dim(
          `Would synchronize ${automations.count} static automation schedule(s) after publication.`,
        ),
      )
    }
    return
  }
  await host.check(request)
  await host.prepare(request)
  if (turnstile) Object.assign(env, await turnstile())
  console.log(
    pc.dim(
      options.skipBuild
        ? 'Checking existing build output…'
        : `Building ${request.framework} for ${target}…`,
    ),
  )
  await host.build(request, env)
  await host.provision?.(request)
  console.log(pc.dim('Checking and migrating the database…'))
  await data.migrate()
  Object.assign(env, data.env)
  let url: string
  try {
    console.log(pc.dim(`Publishing to ${target}…`))
    url = await host.publish(request, env)
  } catch (cause) {
    throw new Error(
      `Publishing failed after the database migration step. Database changes were retained; fix the deployment and run cloudconfig deploy again.\n${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
  }
  await automations?.configure(url)
  console.log(pc.green('Deployed.'), pc.cyan(url))
}
