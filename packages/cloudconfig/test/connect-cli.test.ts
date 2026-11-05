import { Command } from 'commander'
import { stripVTControlCharacters } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancel, select } from '@clack/prompts'
import { CONNECT_PROVIDER_IDS, CONNECT_PROVIDERS } from '../src/index.js'
import { registerConnectCommands } from '../src/cli/commands/connect.js'
import { findConfigPath, loadConfig } from '../src/cli/config-load.js'

vi.mock('@clack/prompts', () => ({
  cancel: vi.fn(),
  intro: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
  outro: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
  text: vi.fn(),
}))

vi.mock('../src/cli/config-load.js', () => ({
  findConfigPath: vi.fn(),
  loadConfig: vi.fn(),
}))

const originalStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
const originalExitCode = process.exitCode

function setInteractiveTerminal(isTTY: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true })
}

function createConnectProgram(): Command {
  const program = new Command('cloudconfig').exitOverride()
  registerConnectCommands(program)
  return program
}

function printedOutput(): string {
  return stripVTControlCharacters(
    vi
      .mocked(console.log)
      .mock.calls.map(([message]) => String(message))
      .join('\n'),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(select).mockReset()
  vi.mocked(findConfigPath).mockReset()
  vi.mocked(loadConfig).mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  setInteractiveTerminal(false)
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalStdinIsTTY) {
    Object.defineProperty(process.stdin, 'isTTY', originalStdinIsTTY)
  } else {
    Reflect.deleteProperty(process.stdin, 'isTTY')
  }
  process.exitCode = originalExitCode
})

describe('connect provider discovery', () => {
  it('lists every built-in and other connection modes without loading a project', async () => {
    await createConnectProgram().parseAsync(['connect', 'list'], { from: 'user' })

    const output = printedOutput()
    for (const provider of CONNECT_PROVIDER_IDS) {
      expect(output).toContain(provider)
      expect(output).toContain(CONNECT_PROVIDERS[provider].label)
    }
    expect(output).toContain('Hosted MCP servers')
    expect(output).toContain('Custom OAuth')
    expect(output).toContain('API keys')
    expect(output).toContain('Cloudflare Email Sending')
    expect(output).toContain('cloudconfig connect add google')
    expect(output).toContain('cloudconfig connect status')
    expect(findConfigPath).not.toHaveBeenCalled()
    expect(loadConfig).not.toHaveBeenCalled()
  })

  it('shows the catalog for bare connect', async () => {
    await createConnectProgram().parseAsync(['connect'], { from: 'user' })

    expect(printedOutput()).toContain('Built-in OAuth providers')
    expect(printedOutput()).toContain('cloudconfig connect add <provider>')
    expect(select).not.toHaveBeenCalled()
  })

  it('suggests providers for add without an argument in a non-interactive terminal', async () => {
    await createConnectProgram().parseAsync(['connect', 'add'], { from: 'user' })

    expect(printedOutput()).toContain('Built-in OAuth providers')
    expect(select).not.toHaveBeenCalled()
    expect(findConfigPath).not.toHaveBeenCalled()
    expect(loadConfig).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  })

  it('honors --no-prompt without a provider even in an interactive terminal', async () => {
    setInteractiveTerminal(true)
    await createConnectProgram().parseAsync(['connect', 'add', '--no-prompt'], { from: 'user' })

    expect(printedOutput()).toContain('Built-in OAuth providers')
    expect(select).not.toHaveBeenCalled()
    expect(findConfigPath).not.toHaveBeenCalled()
  })

  it('offers every built-in in the picker and continues setup for the chosen provider', async () => {
    setInteractiveTerminal(true)
    vi.mocked(select).mockResolvedValue('google')
    await createConnectProgram().parseAsync(['connect', 'add'], { from: 'user' })

    const options = vi.mocked(select).mock.calls[0]?.[0].options
    expect(options?.map((option) => option.value)).toEqual([...CONNECT_PROVIDER_IDS])
    expect(findConfigPath).toHaveBeenCalledWith(process.cwd())
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('No cloud.config.ts'))
  })

  it('leaves project files untouched when the picker is canceled', async () => {
    setInteractiveTerminal(true)
    vi.mocked(select).mockResolvedValue(Symbol('cancel'))
    await createConnectProgram().parseAsync(['connect', 'add'], { from: 'user' })

    expect(cancel).toHaveBeenCalledWith('No provider selected. Nothing was written.')
    expect(findConfigPath).not.toHaveBeenCalled()
    expect(loadConfig).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  })

  it('keeps explicit provider setup and rejects unknown providers with discovery guidance', async () => {
    setInteractiveTerminal(true)
    await createConnectProgram().parseAsync(['connect', 'add', 'github', '--no-prompt'], {
      from: 'user',
    })
    expect(select).not.toHaveBeenCalled()
    expect(findConfigPath).toHaveBeenCalledWith(process.cwd())

    await expect(
      createConnectProgram().parseAsync(['connect', 'add', 'unknown-provider'], { from: 'user' }),
    ).rejects.toThrow('cloudconfig connect list')
  })
})
