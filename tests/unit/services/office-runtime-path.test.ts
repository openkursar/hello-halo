/**
 * The halo-node shim directory joins the PATH a Claude engine process inherits
 * instead of replacing it (#448). On Windows the inherited variable is usually
 * spelled `Path`; a second `PATH` key holding only the shim directory is the one
 * Node's spawn passes on, so the agent's shell lost System32, python and node.
 */

import { mkdirSync } from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getTestDir } from '../setup'

vi.mock('../../../src/main/services/agent/helpers', () => ({
  getHeadlessElectronPath: () => '/stub/electron',
}))

import { applyOfficeRuntimeEnv, ensureOfficeRuntimeShim } from '../../../src/main/services/office-runtime'

const realPlatform = process.platform
const realResourcesPath = process.resourcesPath

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function pathKeys(env: Record<string, unknown>): string[] {
  return Object.keys(env).filter(key => key.toUpperCase() === 'PATH')
}

let shimDir = ''

beforeEach(() => {
  // A packaged layout (the electron mock reports isPackaged) with the bundle present.
  const resources = path.join(getTestDir(), 'resources')
  mkdirSync(path.join(resources, 'office-runtime', 'node_modules'), { recursive: true })
  Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
  shimDir = ensureOfficeRuntimeShim() ?? ''
  expect(shimDir).not.toBe('')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  Object.defineProperty(process, 'resourcesPath', { value: realResourcesPath, configurable: true })
})

describe('applyOfficeRuntimeEnv PATH', () => {
  it('appends the shim to the Path a Windows process inherits, leaving one PATH', () => {
    setPlatform('win32')
    const env: Record<string, string | undefined> = { Path: 'C:\\Windows\\system32;C:\\Windows' }

    applyOfficeRuntimeEnv(env)

    expect(pathKeys(env)).toEqual(['Path'])
    expect(env.Path).toBe(`C:\\Windows\\system32;C:\\Windows${path.delimiter}${shimDir}`)
  })

  it('appends to the spelling Node passes on when PATH and Path are both present', () => {
    setPlatform('win32')
    const env: Record<string, string | undefined> = {
      Path: 'C:\\Windows\\system32',
      PATH: 'C:\\Tools;C:\\Windows\\system32',
    }

    applyOfficeRuntimeEnv(env)

    expect(pathKeys(env)).toEqual(['PATH'])
    expect(env.PATH).toBe(`C:\\Tools;C:\\Windows\\system32${path.delimiter}${shimDir}`)
  })

  it.each(['darwin', 'linux'] as const)('appends to PATH on %s and leaves other spellings alone', (platform) => {
    setPlatform(platform)
    const env: Record<string, string | undefined> = { PATH: '/usr/bin:/bin', Path: 'unrelated' }

    applyOfficeRuntimeEnv(env)

    expect(env.PATH).toBe(`/usr/bin:/bin${path.delimiter}${shimDir}`)
    expect(env.Path).toBe('unrelated')
  })
})
