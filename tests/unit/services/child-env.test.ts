/**
 * PATH edits on a child environment copied from process.env. Windows keeps the
 * inherited spelling (usually `Path`) in the copy, and Node's spawn passes only
 * the first spelling in sort order, so an edit must land on that one key.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { updateEnvPath } from '../../../src/main/services/child-env'

const realPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

function pathKeys(env: Record<string, unknown>): string[] {
  return Object.keys(env).filter(key => key.toUpperCase() === 'PATH')
}

const append = (dir: string) => (current: string | undefined) => (current ? `${current};${dir}` : dir)

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
})

describe('updateEnvPath on Windows', () => {
  it('edits the inherited Path instead of adding PATH beside it', () => {
    setPlatform('win32')
    const env: Record<string, string | undefined> = { Path: 'C:\\Windows\\system32;C:\\Windows', TEMP: 'C:\\Temp' }

    updateEnvPath(env, append('C:\\shim'))

    expect(env).toEqual({ Path: 'C:\\Windows\\system32;C:\\Windows;C:\\shim', TEMP: 'C:\\Temp' })
  })

  it('starts from the spelling Node passes on and leaves only that one', () => {
    setPlatform('win32')
    const env: Record<string, string | undefined> = { Path: 'C:\\Windows\\system32', PATH: 'C:\\Tools' }

    updateEnvPath(env, append('C:\\shim'))

    expect(pathKeys(env)).toEqual(['PATH'])
    expect(env.PATH).toBe('C:\\Tools;C:\\shim')
  })

  it('creates PATH when no spelling is present', () => {
    setPlatform('win32')
    const env: Record<string, string | undefined> = {}

    updateEnvPath(env, append('C:\\shim'))

    expect(env).toEqual({ PATH: 'C:\\shim' })
  })
})

describe.each(['darwin', 'linux'] as const)('updateEnvPath on %s', (platform) => {
  it('edits PATH and leaves a differently cased variable alone', () => {
    setPlatform(platform)
    const env: Record<string, string | undefined> = { PATH: '/usr/bin:/bin', Path: 'unrelated' }

    updateEnvPath(env, current => `/shim:${current}`)

    expect(env).toEqual({ PATH: '/shim:/usr/bin:/bin', Path: 'unrelated' })
  })
})
