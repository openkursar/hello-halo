import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const electron = vi.hoisted(() => ({ app: { isPackaged: false as boolean, getAppPath: (): string => '/application' } }))
vi.mock('electron', () => electron)

const binary = process.platform === 'win32' ? 'rg.exe' : 'rg'
const packageDir = `ripgrep-${process.platform}-${process.arch}`

function plant(root: string): string {
  const file = join(root, 'node_modules', '@vscode', packageDir, 'bin', binary)
  fs.mkdirSync(join(file, '..'), { recursive: true })
  fs.writeFileSync(file, '')
  return file
}

function fakeSdk() {
  const runtime = { initialize: vi.fn(), close: vi.fn(), diagnostics: vi.fn(),
    createSession: vi.fn(async (_options: Record<string, unknown>, _placement?: unknown) => ({})), query: vi.fn() }
  return { runtime, sdk: { createWorkerRuntime: () => runtime, getWorkerEntryUrl: () => new URL('file:///sdk/dist/worker/entry.js'),
    tool: vi.fn(), createSdkMcpServer: vi.fn(), setLogger: vi.fn(),
    isResumeHistoryError: (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === 'RESUME_HISTORY_UNAVAILABLE' } }
}

describe('Halo SDK engine ripgrep', () => {
  let root: string
  beforeEach(() => {
    vi.resetModules()
    root = fs.mkdtempSync(join(tmpdir(), 'halo-ripgrep-'))
  })
  afterEach(() => {
    electron.app.isPackaged = false
    electron.app.getAppPath = () => '/application'
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('points a packaged build at the unpacked binary, never inside the archive', async () => {
    const file = plant(join(root, 'app.asar.unpacked'))
    electron.app.isPackaged = true
    electron.app.getAppPath = () => join(root, 'app.asar')
    const { getBundledRipgrepPath } = await import('../../../../../src/main/services/agent/halo/ripgrep')
    expect(getBundledRipgrepPath()).toBe(file)
  })

  it('reports none when the build carries no ripgrep', async () => {
    electron.app.getAppPath = () => root
    const { getBundledRipgrepPath } = await import('../../../../../src/main/services/agent/halo/ripgrep')
    expect(getBundledRipgrepPath()).toBeNull()
  })

  it('hands the binary to the engine without overriding an explicit choice', async () => {
    const file = plant(root)
    electron.app.getAppPath = () => root
    const { createHaloSdkModule } = await import('../../../../../src/main/services/agent/halo')
    const { runtime, sdk } = fakeSdk()
    const module = createHaloSdkModule(sdk as never)
    const separator = process.platform === 'win32' ? ';' : ':'
    await module.createSession({ env: { CLAUDE_CONFIG_DIR: '/config', PATH: `/usr/bin${separator}/bin` } })
    expect(runtime.createSession.mock.calls[0][0]).toMatchObject({ env: {
      CLAUDE_CONFIG_DIR: '/config', AGENT_RIPGREP_PATH: file, PATH: `/usr/bin${separator}/bin${separator}${join(file, '..')}`,
    } })
    await module.createSession({ env: { AGENT_RIPGREP_PATH: '/chosen/rg' } })
    expect(runtime.createSession.mock.calls[1][0]).toMatchObject({ env: { AGENT_RIPGREP_PATH: '/chosen/rg' } })
  })

  it('names the same package per platform as the packaging scripts', async () => {
    const { RIPGREP_PACKAGES } = await import('../../../../../src/main/services/agent/halo/ripgrep')
    const { RIPGREP_TARGETS } = createRequire(import.meta.url)('../../../../../scripts/lib/ripgrep.cjs') as { RIPGREP_TARGETS: Record<string, { packageName: string; binary: string }> }
    expect(RIPGREP_PACKAGES).toEqual(Object.fromEntries(Object.entries(RIPGREP_TARGETS).map(([key, target]) => [key, target.packageName])))
    for (const [key, target] of Object.entries(RIPGREP_TARGETS)) expect(target.binary).toBe(key.startsWith('win32') ? 'rg.exe' : 'rg')
  })
})
