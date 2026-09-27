/**
 * Unit tests for apps/manager/builtin-skills
 *
 * The seeder is a startup maintenance task driven by the shipped
 * resources/builtin-skills/ tree, so tests write a fake tree under the test
 * app path (electron mock: getAppPath() = <testdir>/app) and assert against a
 * stub AppManagerService: install/refresh/GC decisions and their guards.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
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
  const updateSpec = vi.fn()
  const uninstall = vi.fn(async () => undefined)
  const deleteApp = vi.fn(async (id: string) => {
    const idx = rows.findIndex(r => r.id === id)
    if (idx >= 0) rows.splice(idx, 1)
  })

  const manager = {
    listApps: () => rows as unknown as InstalledApp[],
    install,
    updateSpec,
    uninstall,
    deleteApp,
  } as unknown as AppManagerService

  return { manager, install, updateSpec, uninstall, deleteApp, rows }
}

beforeEach(() => {
  mkdirSync(skillsRoot(), { recursive: true })
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

  it('refreshes via updateSpec only on version drift', async () => {
    writeSkill('drift', '2.0.0')
    writeSkill('stable', '1.0.0')
    const { manager, install, updateSpec } = createStubManager([
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
    expect(updateSpec).toHaveBeenCalledTimes(1)
    expect(updateSpec.mock.calls[0][0]).toBe('row-drift')
    expect((updateSpec.mock.calls[0][1] as { version: string }).version).toBe('2.0.0')
  })

  // syncSkillToFilesystem refuses to write a paused record, so refreshing the
  // spec here can't accidentally re-enable the skill.
  it('refreshes the spec of a paused row without resuming it', async () => {
    writeSkill('dormant', '2.0.0')
    const { manager, install, updateSpec, uninstall } = createStubManager([
      {
        id: 'row-dormant',
        status: 'paused',
        spec: { type: 'skill', version: '1.0.0', store: { slug: 'halo-builtin-skills/dormant', install_source: 'bundled' } },
      },
    ])

    await seedBuiltinSkills(manager)

    expect(install).not.toHaveBeenCalled()
    expect(uninstall).not.toHaveBeenCalled()
    expect(updateSpec).toHaveBeenCalledTimes(1)
    expect(updateSpec.mock.calls[0][0]).toBe('row-dormant')
  })

  it('respects user uninstalls: never reinstalls or refreshes uninstalled rows', async () => {
    writeSkill('removed', '3.0.0')
    const { manager, install, updateSpec } = createStubManager([
      {
        id: 'row-removed',
        status: 'uninstalled',
        spec: { type: 'skill', version: '1.0.0', store: { slug: 'halo-builtin-skills/removed', install_source: 'bundled' } },
      },
    ])

    await seedBuiltinSkills(manager)

    expect(install).not.toHaveBeenCalled()
    expect(updateSpec).not.toHaveBeenCalled()
  })

  it('GCs seeded rows whose directory no longer ships, leaving other skills alone', async () => {
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

    expect(uninstall).toHaveBeenCalledWith('row-stale')
    expect(deleteApp).toHaveBeenCalledWith('row-stale')
    expect(deleteApp).toHaveBeenCalledTimes(1)
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
