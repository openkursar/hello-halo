/**
 * Locating git: the first git on PATH wins; one that cannot run, or is too
 * old, is reported as not-runnable (macOS without the command line tools),
 * and the repository list says so instead of failing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chmodSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { makeTempDir } from './_repo'

const { spaces } = vi.hoisted(() => ({ spaces: new Map<string, string>() }))
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpaceDir: (spaceId: string) => spaces.get(spaceId) ?? '',
}))

const posix = process.platform !== 'win32'
const savedPath = process.env.PATH
const dirs: string[] = []

function fakeGit(script: string): string {
  const dir = makeTempDir('halo-fake-git-')
  dirs.push(dir)
  const file = join(dir, 'git')
  writeFileSync(file, `#!/bin/sh\n${script}\n`)
  chmodSync(file, 0o755)
  return dir
}

async function freshLocate() {
  vi.resetModules()
  return import('../../../../src/main/services/git/locate')
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  process.env.PATH = savedPath
  spaces.clear()
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.runIf(posix)('getGitAvailability', () => {
  it('uses the first git on PATH and reports its version', async () => {
    process.env.PATH = `${fakeGit('echo "git version 2.45.1"')}:${savedPath}`
    const { getGitAvailability, requireGitExecutable } = await freshLocate()
    expect(await getGitAvailability()).toEqual({ available: true, version: '2.45.1' })
    expect(await requireGitExecutable()).toBe(join(process.env.PATH.split(':')[0], 'git'))
  })

  it('reports a git that cannot run as not-runnable, with what it printed', async () => {
    process.env.PATH = `${fakeGit('echo "xcrun: error: invalid active developer path" >&2; exit 1')}:${savedPath}`
    const { getGitAvailability, requireGitExecutable } = await freshLocate()
    expect(await getGitAvailability()).toEqual({
      available: false,
      reason: 'not-runnable',
      detail: 'xcrun: error: invalid active developer path',
    })
    await expect(requireGitExecutable()).rejects.toMatchObject({ code: 'GIT_UNAVAILABLE' })
  })

  it('refuses a git older than the service needs', async () => {
    process.env.PATH = `${fakeGit('echo "git version 2.20.1"')}:${savedPath}`
    const { getGitAvailability } = await freshLocate()
    const availability = await getGitAvailability()
    expect(availability).toMatchObject({ available: false, reason: 'not-runnable' })
    expect(availability.available === false && availability.detail).toMatch(/2\.23 or newer/)
  })

  it('looks again when PATH changes instead of keeping a failure', async () => {
    const broken = fakeGit('exit 1')
    const working = fakeGit('echo "git version 2.40.0"')
    process.env.PATH = `${broken}:${savedPath}`
    const { getGitAvailability } = await freshLocate()
    expect((await getGitAvailability()).available).toBe(false)
    process.env.PATH = `${working}:${savedPath}`
    expect(await getGitAvailability()).toEqual({ available: true, version: '2.40.0' })
  })

  it('lets the repository list describe a missing git instead of failing', async () => {
    const space = makeTempDir('halo-git-space-')
    dirs.push(space)
    spaces.set('s', space)
    process.env.PATH = `${fakeGit('exit 1')}:${savedPath}`
    vi.resetModules()
    const { listRepositories } = await import('../../../../src/main/services/git')
    expect(await listRepositories('s')).toEqual({ git: { available: false, reason: 'not-runnable', detail: '' }, repositories: [] })
  })
})
