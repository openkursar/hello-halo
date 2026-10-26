/**
 * The Codex app-server gets its helper directory ahead of the PATH it
 * inherits, not instead of it. On Windows that PATH arrives spelled `Path`;
 * writing `PATH` beside it handed the child only the helper directory.
 */

import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn,
}))
vi.mock('../../../../../src/main/services/agent/helpers', () => ({
  getHeadlessElectronPath: () => '/stub/electron',
}))

import { createCodexConnection } from '../../../../../src/main/services/agent/codex/transport/connection'

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function fakeChild(): EventEmitter {
  return Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null,
    killed: false,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  })
}

async function spawnedEnv(options: { pathDirs: string[]; env: NodeJS.ProcessEnv }): Promise<NodeJS.ProcessEnv> {
  spawn.mockImplementation(() => fakeChild())
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    await createCodexConnection({ binaryPath: 'codex', isJsShim: false, cwd: '/work', ...options }).start()
  } finally {
    log.mockRestore()
  }
  return spawn.mock.calls[0][2].env
}

function pathKeys(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env).filter(key => key.toUpperCase() === 'PATH')
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
})

describe('Codex app-server PATH', () => {
  it('prepends the helper directory to the Path a Windows process inherits, leaving one PATH', async () => {
    setPlatform('win32')

    const env = await spawnedEnv({
      pathDirs: ['C:\\codex\\path'],
      env: { Path: 'C:\\Windows\\system32;C:\\Windows', CODEX_HOME: 'C:\\halo\\codex' },
    })

    expect(pathKeys(env)).toEqual(['Path'])
    expect(env.Path).toBe('C:\\codex\\path;C:\\Windows\\system32;C:\\Windows')
    expect(env.CODEX_HOME).toBe('C:\\halo\\codex')
  })

  it('prepends the helper directory to PATH on macOS', async () => {
    setPlatform('darwin')

    const env = await spawnedEnv({ pathDirs: ['/codex/path'], env: { PATH: '/usr/bin:/bin' } })

    expect(env.PATH).toBe('/codex/path:/usr/bin:/bin')
  })
})
