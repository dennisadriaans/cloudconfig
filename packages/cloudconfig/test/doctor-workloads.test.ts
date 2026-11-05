import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { workloadChecks } from '../src/cli/doctor-workloads.js'
import type { AnyConfig } from '../src/dsl/model-config.js'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const projectDir = mkdtempSync(join(tmpdir(), 'cloudconfig-workload-doctor-'))
  directories.push(projectDir)
  const config: AnyConfig = {
    models: {},
    deploy: { target: 'vercel', automations: { entry: 'automations.ts' } },
  }
  return { config, projectDir, framework: 'nuxt' as const }
}

it('identifies a missing host and optional native SDK without importing SDKs or accessing a cloud', () => {
  const options = fixture()
  const checks = workloadChecks({ ...options, hasRuntimePackage: () => false })
  expect(checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'workload-entry',
        status: 'fail',
        detail: 'Missing deployment entry: automations.ts',
      }),
      expect.objectContaining({
        id: 'workload-sdk',
        status: 'fail',
        detail: expect.stringContaining('workflow'),
      }),
    ]),
  )
})

it('catches invalid portable cron and Cloudflare-specific classes on another cloud', () => {
  const options = fixture()
  writeFileSync(join(options.projectDir, 'automations.ts'), 'export default {}')
  options.config.deploy!.automations!.schedules = {
    daily: {
      cron: 'invalid',
      timeZone: 'UTC',
      run: { scope: { ownerId: null, workspace: 'system' }, task: 'process', payload: {} },
    },
  }
  expect(workloadChecks(options)).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'workloads', status: 'fail' })]),
  )
  options.config.deploy!.workflows = [
    {
      entry: 'cloudflare.ts',
      className: 'SpecificWorkflow',
      binding: 'WORKFLOW',
      name: 'specific',
    },
  ]
  expect(workloadChecks(options)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'workloads',
        detail: expect.stringContaining('Use deploy.automations'),
      }),
    ]),
  )
})
