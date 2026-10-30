import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  existsWait: undefined as ((path: string) => Promise<boolean>) | undefined
}))
vi.mock('../../../src/main/services/cc-runtime/probe', () => ({ checkInstallation: mocks.check }))
vi.mock('../../../src/main/services/cc-runtime/paths', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/main/services/cc-runtime/paths')>()
  return { ...actual, fileExists: (path: string) => mocks.existsWait ? mocks.existsWait(path) : path.startsWith(globalThis.__HALO_TEST_DIR__) ? actual.fileExists(path) : Promise.resolve(false) }
})

import { discoverInstallations } from '../../../src/main/services/cc-runtime/discovery'

beforeEach(() => {
  mocks.existsWait = undefined
  mocks.check.mockReset().mockImplementation(async (path: string) => ({ path, compatibility: 'compatible', version: '3.0.0' }))
})

async function candidate(directory: string) {
  await mkdir(directory, { recursive: true })
  const file = join(directory, process.platform === 'win32' ? 'claude.exe' : 'claude')
  await writeFile(file, '#!/usr/bin/env node\n')
  return file
}

describe('bounded local CC discovery', () => {
  it('deduplicates aliases and stops after the first usable candidate during migration', async () => {
    const first = await candidate(join(globalThis.__HALO_TEST_DIR__, 'selected'))
    const nativeDirectory = join(globalThis.__HALO_TEST_DIR__, '.local', 'bin')
    await mkdir(nativeDirectory, { recursive: true })
    await symlink(first, join(nativeDirectory, process.platform === 'win32' ? 'claude.exe' : 'claude'))
    await candidate(join(globalThis.__HALO_TEST_DIR__, '.npm-global', 'bin'))
    const scan = await discoverInstallations(first, { stopOnCompatible: true })
    expect(scan.installations).toHaveLength(1)
    expect(scan.installations[0].path).toBe(first)
    expect(mocks.check).toHaveBeenCalledTimes(1)
  })

  it('caps PATH inspection without recursive filesystem scans', async () => {
    const originalPath = process.env.PATH
    process.env.PATH = Array.from({ length: 200 }, (_, index) => join(globalThis.__HALO_TEST_DIR__, `path-${index}`)).join(delimiter)
    try {
      const scan = await discoverInstallations()
      expect(scan.searchedLocations).toBeLessThanOrEqual(65)
      expect(scan.truncated).toBe(true)
      expect(scan.installations).toEqual([])
    } finally { process.env.PATH = originalPath }
  })

  it('returns completed checks at the deadline and aborts outstanding probes', async () => {
    const first = await candidate(join(globalThis.__HALO_TEST_DIR__, 'selected'))
    await candidate(join(globalThis.__HALO_TEST_DIR__, '.local', 'bin'))
    await candidate(join(globalThis.__HALO_TEST_DIR__, '.npm-global', 'bin'))
    let aborted = 0
    mocks.check.mockImplementation((path, options) => path === first
      ? Promise.resolve({ path, compatibility: 'compatible', version: '3.0.0' })
      : new Promise(resolve => options.signal.addEventListener('abort', () => {
        aborted++
        resolve({ path, compatibility: 'unavailable', issue: 'probe-timeout' })
      }, { once: true })))
    const started = Date.now()
    const scan = await discoverInstallations(first, { deadlineMs: 50 })
    expect(Date.now() - started).toBeLessThan(500)
    expect(scan.truncated).toBe(true)
    expect(scan.installations.map(item => item.path)).toEqual([first])
    expect(aborted).toBeGreaterThan(0)
    const probesStarted = mocks.check.mock.calls.length
    await new Promise(resolve => setImmediate(resolve))
    expect(mocks.check).toHaveBeenCalledTimes(probesStarted)
    expect(scan.installations).toHaveLength(1)
  })

  it('does not hold the response for a stalled filesystem lookup or start work after it resumes', async () => {
    const first = await candidate(join(globalThis.__HALO_TEST_DIR__, 'selected'))
    let release!: (exists: boolean) => void
    mocks.existsWait = () => new Promise(resolve => { release = resolve })
    const started = Date.now()
    const scan = await discoverInstallations(first, { deadlineMs: 30 })
    expect(Date.now() - started).toBeLessThan(500)
    expect(scan).toMatchObject({ installations: [], truncated: true })
    expect(mocks.check).not.toHaveBeenCalled()
    release(true)
    await new Promise(resolve => setImmediate(resolve))
    expect(mocks.check).not.toHaveBeenCalled()
  })
})
