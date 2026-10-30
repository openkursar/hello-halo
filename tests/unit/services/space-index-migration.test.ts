import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { _resetActivityState, _resetSpaceRegistry, getSpaceDir, getSpaceWithPreferences, listSpaces } from '../../../src/main/services/space.service'
import { createMigrationCommand, installLegacySpaceIndex, migrationFileIdentity, spaceIndexFixture } from '../../e2e/fixtures/acceptance-space-index-migration'

const exited = { exitCode: 0, signalCode: null }

beforeEach(() => {
  vi.stubEnv('HALO_DATA_DIR', join(globalThis.__HALO_TEST_DIR__, '.halo'))
  _resetSpaceRegistry()
  _resetActivityState()
})

afterEach(() => {
  _resetSpaceRegistry()
  _resetActivityState()
  vi.unstubAllEnvs()
})

describe('historical workspace index input', () => {
  it('pins independent historical producer formats without current registration metadata', () => {
    const v1 = spaceIndexFixture('space-index-v1')
    expect(v1.sha256).toBe('3c8dae3dc5613a23efb619b6eaeeb529b974e39590b1d906a52f60d970b5b69a')
    expect(v1.input.historicalProducer).toBe('284439ce0298071d8afaa005b7de187a4de53479')
    expect(Object.keys(v1.input.index)).toEqual(['customPaths'])
    expect(v1.input.spaces.every(space => !('workingDir' in space.meta))).toBe(true)
    expect(v1.input.spaces.flatMap(space => space.conversations).every(conversation => !('version' in conversation))).toBe(true)
    const v2 = spaceIndexFixture('space-index-v2')
    expect(v2.sha256).toBe('1df6443d4aa6afddd798a6bac18578c9bdc9c10e21a28f963036ac3b6761f9d3')
    expect(v2.input.historicalProducer).toBe('15156b85ec86c7f875c8723d4eb553336143303b')
    expect(v2.input.index.version).toBe(2)
    expect(Object.values(v2.input.index.spaces!).every(entry => Object.keys(entry).join(',') === 'path')).toBe(true)
    expect(v2.input.spaces.filter(space => !space.registered)).toHaveLength(1)
    expect(v2.input.spaces.flatMap(space => space.conversations).every(conversation => conversation.version === 2)).toBe(true)
    for (const fixture of [v1, v2]) {
      expect(fixture.input.spaces.every(space => !('sortOrder' in space.meta) && !('lastActiveAt' in space.meta))).toBe(true)
      expect(fixture.input.spaces.flatMap(space => space.conversations).every(conversation => !('sessionId' in conversation))).toBe(true)
    }
  })

  for (const dataset of ['space-index-v1', 'space-index-v2'] as const) {
    it(`${dataset} uses the real service to preserve order, metadata and working directories without repeating the migration`, () => {
      const input = installLegacySpaceIndex(globalThis.__HALO_TEST_DIR__, exited, dataset)
      const spaces = listSpaces()
      expect(spaces.map(space => space.id)).toEqual(input.expectedOrder)
      const current = JSON.parse(readFileSync(input.index, 'utf8'))
      expect(current.version).toBe(3)
      expect(Object.keys(current.spaces).sort()).toEqual([...input.expectedOrder].sort())
      for (const [position, id] of input.expectedOrder.entries()) {
        const historical = input.spaces.find(space => space.meta.id === id)!
        const { id: _id, preferences, ...meta } = historical.meta
        const { path, ...entry } = current.spaces[id]
        expect(entry).toEqual({ ...meta, sortOrder: position })
        expect(realpathSync(path)).toBe(realpathSync(historical.path))
        expect(getSpaceWithPreferences(id)).toMatchObject({ ...historical.meta, sortOrder: position, isMissing: false })
        expect(realpathSync(getSpaceWithPreferences(id)!.path)).toBe(realpathSync(historical.path))
        expect(getSpaceWithPreferences(id)?.preferences).toEqual(preferences)
        expect(realpathSync(getSpaceDir(id))).toBe(realpathSync(historical.meta.workingDir ?? historical.path))
      }
      for (const space of input.spaces.filter(space => !space.registered)) expect(getSpaceWithPreferences(space.meta.id)).toBeNull()
      for (const file of input.files) expect(migrationFileIdentity(file.path)).toEqual(file.identity)
      const indexBefore = migrationFileIdentity(input.index)
      _resetSpaceRegistry()
      expect(listSpaces()).toEqual(spaces)
      expect(migrationFileIdentity(input.index)).toEqual(indexBefore)
      for (const file of input.files) expect(migrationFileIdentity(file.path)).toEqual(file.identity)
    })
  }

  it('rejects a real running owned process and installs only after its exit', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' })
    await once(child, 'spawn')
    try {
      expect(() => installLegacySpaceIndex(globalThis.__HALO_TEST_DIR__, child, 'space-index-v1')).toThrow('owned application to have exited')
      expect(readdirSync(join(globalThis.__HALO_TEST_DIR__, '.halo', 'spaces'))).toEqual([])
      const completion = once(child, 'exit')
      child.kill()
      await completion
      expect(installLegacySpaceIndex(globalThis.__HALO_TEST_DIR__, child, 'space-index-v1').spaces).toHaveLength(3)
    } finally { if (child.exitCode == null && child.signalCode == null) { const completion = once(child, 'exit'); child.kill(); await completion } }
  })

  it('refuses to replace an existing registry even when its directory is empty', () => {
    const index = join(globalThis.__HALO_TEST_DIR__, '.halo', 'spaces-index.json')
    const bytes = JSON.stringify({ version: 3, spaces: { existing: { path: '/unrelated' } } })
    writeFileSync(index, bytes)
    expect(() => installLegacySpaceIndex(globalThis.__HALO_TEST_DIR__, exited, 'space-index-v2')).toThrow('never be overwritten')
    expect(readFileSync(index, 'utf8')).toBe(bytes)
    expect(readdirSync(join(globalThis.__HALO_TEST_DIR__, '.halo', 'spaces'))).toEqual([])
  })

  it('refuses a redirected spaces directory before writing any historical file', () => {
    const profile = globalThis.__HALO_TEST_DIR__
    const destination = join(profile, 'redirected-directory')
    mkdirSync(destination)
    const spaces = join(profile, '.halo', 'spaces')
    rmSync(spaces, { recursive: true })
    symlinkSync(destination, spaces, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => installLegacySpaceIndex(profile, exited, 'space-index-v1')).toThrow('symbolic links')
    expect(readdirSync(destination)).toEqual([])
    expect(existsSync(join(profile, '.halo', 'spaces-index.json'))).toBe(false)
  })

  it('runs the receipt program only in an owned working directory and refuses an outside cwd', () => {
    const profile = globalThis.__HALO_TEST_DIR__
    const directory = join(profile, 'working directory')
    mkdirSync(directory)
    const command = createMigrationCommand(profile, process.execPath, process.platform)
    const valid = spawnSync(process.execPath, [command.script], { cwd: directory, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' })
    expect(valid.status, valid.stderr).toBe(0)
    expect(JSON.parse(valid.stdout)).toEqual({ cwd: realpathSync(directory), marker: command.marker })
    expect(JSON.parse(readFileSync(join(directory, command.outputName), 'utf8'))).toEqual(JSON.parse(valid.stdout))
    const outside = dirname(realpathSync(profile))
    const refused = spawnSync(process.execPath, [command.script], { cwd: outside, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' })
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('Refusing work outside the owned profile')
    expect(existsSync(join(outside, command.outputName))).toBe(false)
  })
})
