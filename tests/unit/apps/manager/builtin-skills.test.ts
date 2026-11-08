/**
 * Unit tests for apps/manager/builtin-skills
 *
 * The seeder is a startup maintenance task driven by the shipped
 * resources/builtin-skills/ tree, so tests write a fake tree under the test
 * app path (electron mock: getAppPath() = <testdir>/app) and assert against a
 * stub AppManagerService: install/refresh/GC decisions and their guards.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import * as fs from 'fs'
import { createHash } from 'node:crypto'
const realFs = vi.hoisted(() => ({ opendir: null as unknown, lstat: null as unknown }))
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  realFs.opendir = actual.opendirSync
  realFs.lstat = actual.lstatSync
  return { ...actual, opendirSync: vi.fn(actual.opendirSync), lstatSync: vi.fn(actual.lstatSync) }
})
const { definitions } = vi.hoisted(() => ({ definitions: vi.fn(() => [] as Array<{ name: string; description: string; argumentHint?: string; instructions: string }>) }))
vi.mock('@hello-halo/agent-sdk/worker', () => ({ getBuiltinSkillDefinitions: definitions }))
import { basename, join } from 'path'
import { seedBuiltinSkills } from '../../../../src/main/apps/manager/builtin-skills'
import type { AppManagerService, InstalledApp, AppStatus } from '../../../../src/main/apps/manager/types'
import type { AppSpec, SkillSpec } from '../../../../src/main/apps/spec/schema'

function skillsRoot(): string {
  return join(globalThis.__HALO_TEST_DIR__, 'app', 'resources', 'builtin-skills')
}

function writeSkill(id: string, version: string, extraFiles: Record<string, string> = {}): void {
  const dir = join(skillsRoot(), id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${id}\ndescription: Test skill ${id}\nversion: ${version}\n---\n\n# ${id}\n`
  )
  for (const [rel, content] of Object.entries(extraFiles)) {
    const file = join(dir, rel)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, content)
  }
}

interface StubRow {
  id: string
  status: AppStatus
  userOverrides?: InstalledApp['userOverrides']
  spec: {
    type: string
    version: string
    store?: { slug?: string; install_source?: string }
  }
}

function createStubManager(rows: StubRow[]) {
  const install = vi.fn(async (_spaceId: string | null, spec: AppSpec) => {
    rows.push({
      id: `row-${spec.name}`,
      status: 'active',
      spec: {
        type: spec.type,
        version: spec.version,
        store: spec.store as StubRow['spec']['store'],
      },
    })
    return { id: `row-${spec.name}` } as unknown as InstalledApp
  })
  const upgradeSpec = vi.fn((_id: string, next: AppSpec) => ({ fromVersion: '1.0.0', toVersion: next.version, kept: [], editsKnown: true }))
  const uninstall = vi.fn(async () => undefined)
  const deleteApp = vi.fn(async (id: string) => {
    const idx = rows.findIndex(r => r.id === id)
    if (idx >= 0) rows.splice(idx, 1)
  })

  const manager = {
    listSkillRecords: () => rows.map(row => ({ ...row, userOverrides: row.userOverrides ?? { skill: { version: 1, filePath: '/fixture/SKILL.md' } } })) as unknown as InstalledApp[],
    install,
    upgradeSpec,
    uninstall,
    deleteApp,
  } as unknown as AppManagerService

  return { manager, install, upgradeSpec, uninstall, deleteApp, rows }
}

beforeEach(() => {
  definitions.mockReturnValue([])
  mkdirSync(skillsRoot(), { recursive: true })
})

const sdkDefinitions = [
  { name: 'commit', description: 'Commit workflow', argumentHint: '<scope>', instructions: 'Inspect changes. $ARGUMENTS' },
  { name: 'pull-request', description: 'Pull request workflow', instructions: 'Prepare a request. $ARGUMENTS' },
]
const sdkVersion = (definition: typeof sdkDefinitions[number]) => createHash('sha256').update(JSON.stringify(definition)).digest('hex').slice(0, 16)

describe('SDK builtin inventory seeding', () => {
  it('installs two discoverable records before the resources-root check with stable slugs and content hashes', async () => {
    rmSync(skillsRoot(), { recursive: true })
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(globalThis.__HALO_TEST_DIR__)
    definitions.mockReturnValue(sdkDefinitions)
    const { manager, install, rows } = createStubManager([])
    await seedBuiltinSkills(manager)
    expect(install).toHaveBeenCalledTimes(2)
    for (const [index, definition] of sdkDefinitions.entries()) {
      const [scope, spec] = install.mock.calls[index]
      expect(scope).toBeNull()
      expect(spec).toMatchObject({ name: definition.name, version: sdkVersion(definition), store: { slug: `halo-builtin-skills/sdk-${definition.name}` } })
      expect((spec as SkillSpec).skill_content).toContain(definition.instructions)
      expect(rows[index].spec.store?.slug).toBe(`halo-builtin-skills/sdk-${definition.name}`)
    }
    await seedBuiltinSkills(manager)
    expect(install).toHaveBeenCalledTimes(2)
    expect(rows).toHaveLength(2)
    cwd.mockRestore()
  })

  it('refreshes a changed definition through upgradeSpec without resuming a paused record', async () => {
    definitions.mockReturnValue(sdkDefinitions)
    const rows: StubRow[] = sdkDefinitions.map(definition => ({ id: definition.name, status: 'paused', spec: { type: 'skill', version: sdkVersion(definition), store: { slug: `halo-builtin-skills/sdk-${definition.name}` } } }))
    const { manager, install, upgradeSpec } = createStubManager(rows)
    definitions.mockReturnValue([{ ...sdkDefinitions[0], instructions: 'Updated workflow' }, sdkDefinitions[1]])
    await seedBuiltinSkills(manager)
    expect(install).not.toHaveBeenCalled()
    expect(upgradeSpec).toHaveBeenCalledTimes(1)
    expect(upgradeSpec.mock.calls[0][0]).toBe('commit')
    expect(upgradeSpec.mock.calls[0][1].version).not.toBe(sdkVersion(sdkDefinitions[0]))
    expect(rows.every(row => row.status === 'paused')).toBe(true)
  })

  it.each(['uninstalled', 'deleted', 'customized'] as const)('preserves %s records even when the bundled definition changes', async condition => {
    definitions.mockReturnValue(sdkDefinitions)
    const rows: StubRow[] = sdkDefinitions.map(definition => ({ id: definition.name, status: condition === 'uninstalled' ? 'uninstalled' : 'paused',
      userOverrides: { skill: { version: 1, filePath: '/fixture/SKILL.md', ...(condition === 'uninstalled' ? {} : { [condition]: true }) } },
      spec: { type: 'skill', version: 'old', store: { slug: `halo-builtin-skills/sdk-${definition.name}` } } }))
    const { manager, install, upgradeSpec } = createStubManager(rows)
    await seedBuiltinSkills(manager)
    expect(install).not.toHaveBeenCalled()
    expect(upgradeSpec).not.toHaveBeenCalled()
    expect(rows.every(row => row.spec.version === 'old')).toBe(true)
  })
})

describe('shipped skills inside a read-only archive', () => {
  const office = ['docx', 'pdf', 'pptx', 'xlsx', 'office-runtime-check']
  const archiveRoot = () => join(globalThis.__HALO_TEST_DIR__, 'app.asar', 'resources', 'builtin-skills')
  let appPath: { mockRestore: () => void }

  beforeEach(async () => {
    // A packaged app serves resources from app.asar, whose filesystem implements readdir but not opendir.
    const { app } = await import('electron')
    appPath = vi.spyOn(app, 'getAppPath').mockReturnValue(join(globalThis.__HALO_TEST_DIR__, 'app.asar'))
    vi.mocked(fs.opendirSync).mockImplementation((() => {
      throw Object.assign(new Error('ENOTDIR: not a directory, opendir'), { code: 'ENOTDIR' })
    }) as unknown as typeof fs.opendirSync)
    // With Electron's virtual layer bypassed (process.noAsar) the archive is one regular file on disk.
    vi.mocked(fs.lstatSync).mockImplementation(((path: fs.PathLike, options?: unknown) => {
      const stat = (realFs.lstat as typeof fs.lstatSync)(path, options as fs.StatOptions) as fs.Stats
      // The product resolves the test directory to its real path (/private/var on macOS), so match the archive by name.
      if (basename(String(path)) === 'app.asar' && (process as NodeJS.Process & { noAsar?: boolean }).noAsar) {
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { isFile: () => true, isDirectory: () => false })
      }
      return stat
    }) as typeof fs.lstatSync)
  })

  afterEach(() => {
    appPath.mockRestore()
    vi.mocked(fs.opendirSync).mockImplementation(realFs.opendir as typeof fs.opendirSync)
    vi.mocked(fs.lstatSync).mockImplementation(realFs.lstat as typeof fs.lstatSync)
  })

  it('installs every shipped skill, including nested resources, without logging a read failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const id of office) {
      const dir = join(archiveRoot(), id)
      mkdirSync(join(dir, 'references'), { recursive: true })
      mkdirSync(join(dir, 'scripts'), { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: Test skill ${id}\nversion: 1.0.0\n---\n\n# ${id}\n`)
      writeFileSync(join(dir, 'references', 'guide.md'), `guide for ${id}`)
      writeFileSync(join(dir, 'scripts', 'run.js'), 'run()\n')
    }
    const { manager, install } = createStubManager([])
    await seedBuiltinSkills(manager)

    const installed = install.mock.calls.map(call => (call[1] as SkillSpec).name).sort()
    expect(installed).toEqual([...office].sort())
    for (const [, raw] of install.mock.calls) {
      const spec = raw as SkillSpec
      expect(Object.keys(spec.skill_files ?? {}).sort()).toEqual(['SKILL.md', 'references/guide.md', 'scripts/run.js'])
    }
    const messages = [...warn.mock.calls, ...error.mock.calls].map(call => String(call[0]))
    expect(messages.filter(message => message.includes('Failed to read shipped package'))).toEqual([])
  })
})

describe('seedBuiltinSkills', () => {
  it('installs shipped skills globally with the bundled slug namespace', async () => {
    writeSkill('office-check', '1.0.0', { 'scripts/check.js': 'console.log(1)\n' })
    const { manager, install } = createStubManager([])

    await seedBuiltinSkills(manager)

    expect(install).toHaveBeenCalledTimes(1)
    const [spaceId, rawSpec] = install.mock.calls[0]
    const spec = rawSpec as SkillSpec
    expect(spaceId).toBeNull()
    expect(spec.type).toBe('skill')
    expect(spec.version).toBe('1.0.0')
    expect(spec.store?.slug).toBe('halo-builtin-skills/office-check')
    expect(spec.store?.install_source).toBe('bundled')
    expect(Object.keys(spec.skill_files ?? {})).toEqual(
      expect.arrayContaining(['SKILL.md', 'scripts/check.js'])
    )
  })

  it('skips the next launch once a complete run has applied the same bundle', async () => {
    mkdirSync(join(globalThis.__HALO_TEST_DIR__, '.halo'), { recursive: true })
    writeSkill('office-check', '1.0.0')
    const first = createStubManager([])
    await seedBuiltinSkills(first.manager)
    expect(first.install).toHaveBeenCalledTimes(1)

    const listSkillRecords = vi.fn(() => [])
    const second = createStubManager([])
    await seedBuiltinSkills({ ...second.manager, listSkillRecords } as unknown as AppManagerService)
    expect(listSkillRecords).toHaveBeenCalledTimes(1)
    expect(listSkillRecords).toHaveBeenCalledWith(null)
    expect(second.install).not.toHaveBeenCalled()
  })

  it('refreshes via upgradeSpec only on version drift', async () => {
    writeSkill('drift', '2.0.0')
    writeSkill('stable', '1.0.0')
    const { manager, install, upgradeSpec } = createStubManager([
      {
        id: 'row-drift',
        status: 'active',
        spec: { type: 'skill', version: '1.0.0', store: { slug: 'halo-builtin-skills/drift', install_source: 'bundled' } },
      },
      {
        id: 'row-stable',
        status: 'active',
        spec: { type: 'skill', version: '1.0.0', store: { slug: 'halo-builtin-skills/stable', install_source: 'bundled' } },
      },
    ])

    await seedBuiltinSkills(manager)

    expect(install).not.toHaveBeenCalled()
    expect(upgradeSpec).toHaveBeenCalledTimes(1)
    expect(upgradeSpec.mock.calls[0][0]).toBe('row-drift')
    expect((upgradeSpec.mock.calls[0][1] as { version: string }).version).toBe('2.0.0')
  })

  it('refreshes the spec of a paused row without resuming it', async () => {
    writeSkill('dormant', '2.0.0')
    const { manager, install, upgradeSpec, uninstall } = createStubManager([
      {
        id: 'row-dormant',
        status: 'paused',
        spec: { type: 'skill', version: '1.0.0', store: { slug: 'halo-builtin-skills/dormant', install_source: 'bundled' } },
      },
    ])

    await seedBuiltinSkills(manager)

    expect(install).not.toHaveBeenCalled()
    expect(uninstall).not.toHaveBeenCalled()
    expect(upgradeSpec).toHaveBeenCalledTimes(1)
    expect(upgradeSpec.mock.calls[0][0]).toBe('row-dormant')
  })

  it('respects user uninstalls: never reinstalls or refreshes uninstalled rows', async () => {
    writeSkill('removed', '3.0.0')
    const { manager, install, upgradeSpec } = createStubManager([
      {
        id: 'row-removed',
        status: 'uninstalled',
        spec: { type: 'skill', version: '1.0.0', store: { slug: 'halo-builtin-skills/removed', install_source: 'bundled' } },
      },
    ])

    await seedBuiltinSkills(manager)

    expect(install).not.toHaveBeenCalled()
    expect(upgradeSpec).not.toHaveBeenCalled()
  })

  it('keeps installed packages and tombstones when their directory no longer ships', async () => {
    writeSkill('kept', '1.0.0')
    const { manager, uninstall, deleteApp } = createStubManager([
      {
        id: 'row-kept',
        status: 'active',
        spec: { type: 'skill', version: '1.0.0', store: { slug: 'halo-builtin-skills/kept', install_source: 'bundled' } },
      },
      {
        id: 'row-stale',
        status: 'active',
        spec: { type: 'skill', version: '1.0.0', store: { slug: 'halo-builtin-skills/stale', install_source: 'bundled' } },
      },
      {
        id: 'row-store-skill',
        status: 'active',
        spec: { type: 'skill', version: '1.0.0', store: { slug: 'someone/skill', install_source: 'store' } },
      },
    ])

    await seedBuiltinSkills(manager)

    expect(uninstall).not.toHaveBeenCalled()
    expect(deleteApp).not.toHaveBeenCalled()
  })

  it('skips GC entirely when the scan finds zero skills', async () => {
    // Root exists but is empty — must never wipe user rows.
    const { manager, uninstall, deleteApp } = createStubManager([
      {
        id: 'row-existing',
        status: 'active',
        spec: { type: 'skill', version: '1.0.0', store: { slug: 'halo-builtin-skills/existing', install_source: 'bundled' } },
      },
    ])

    await seedBuiltinSkills(manager)

    expect(uninstall).not.toHaveBeenCalled()
    expect(deleteApp).not.toHaveBeenCalled()
  })

  it.each(['customized', 'deleted', 'unmigrated'])('does not refresh a %s skill', async condition => {
    writeSkill('kept', '2.0.0')
    const userOverrides = condition === 'unmigrated' ? {} : { skill: { version: 1 as const, filePath: '/fixture/SKILL.md', [condition]: true } }
    const { manager, install, upgradeSpec } = createStubManager([{
      id: 'kept', status: 'active', userOverrides,
      spec: { type: 'skill', version: '1.0.0', store: { slug: 'halo-builtin-skills/kept' } },
    }])
    await seedBuiltinSkills(manager)
    expect(install).not.toHaveBeenCalled()
    expect(upgradeSpec).not.toHaveBeenCalled()
  })

  it('skips directories without SKILL.md and isolates per-skill failures', async () => {
    mkdirSync(join(skillsRoot(), 'no-manifest'), { recursive: true })
    writeSkill('good', '1.0.0')
    const { manager, install } = createStubManager([])
    install.mockRejectedValueOnce(new Error('boom')).mockImplementationOnce(async () => {
      return { id: 'row-good' } as unknown as InstalledApp
    })
    writeSkill('bad', '1.0.0')

    await seedBuiltinSkills(manager)

    // Both real skills attempted despite the first failing; bare dir skipped.
    expect(install).toHaveBeenCalledTimes(2)
  })
})
