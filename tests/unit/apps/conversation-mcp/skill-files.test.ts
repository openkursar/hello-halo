import { beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppManagerService } from '../../../../src/main/apps/manager'
import type { SkillRef } from '../../../../src/shared/types/skills'

const state = vi.hoisted(() => ({ library: null as unknown }))
vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(), homedir: () => globalThis.__HALO_TEST_DIR__,
}))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: (name: string, description: string, schema: unknown, handler: Function) => ({ name, description, schema, handler }),
  createSdkMcpServer: (options: unknown) => options,
}))
vi.mock('../../../../src/main/apps/skills', async importOriginal => ({
  ...await importOriginal<typeof import('../../../../src/main/apps/skills')>(), getSkillLibrary: () => state.library,
}))
vi.mock('../../../../src/main/apps/manager', () => ({ getAppManager: () => null }))
vi.mock('../../../../src/main/apps/runtime', () => ({ getAppRuntime: () => null }))
vi.mock('../../../../src/main/store', () => ({ installFromStore: vi.fn() }))
vi.mock('../../../../src/main/store/registry.service', () => ({ installRequiredSkills: vi.fn() }))
vi.mock('../../../../src/main/apps/team', () => ({ getTeamService: () => null }))
vi.mock('../../../../src/main/apps/runtime/team', () => ({ getActiveTeamRuntime: () => null }))
vi.mock('../../../../src/main/apps/runtime/team/team-tools', () => ({ buildCoordinationTools: () => [] }))
vi.mock('../../../../src/main/services/official-docs-mcp', () => ({ CREATE_GUIDE_PATH: 'create-digital-human/SKILL.md' }))

import { createSkillLibrary } from '../../../../src/main/apps/skills'
import { createHaloAppsMcpServer } from '../../../../src/main/apps/conversation-mcp'
import { writeSkillPackage } from '../../../../src/main/services/skills'

const asset = Buffer.from([0, 255, 128, 1])
const instructions = (name: string, body = 'Original instructions') => `---\nname: ${name}\ndescription: ${name} instructions\ncustom: keep\n---\n${body}\n`

describe('assembled skill management with real scoped files', () => {
  let root: string
  let work: string
  let trash: ReturnType<typeof vi.fn<[string], Promise<void>>>
  let invoke: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>

  beforeEach(() => {
    root = realpathSync(globalThis.__HALO_TEST_DIR__)
    globalThis.__HALO_TEST_DIR__ = root
    work = join(root, 'workspace')
    mkdirSync(work)
    const manager = { listSkillRecords: () => [] } as unknown as AppManagerService
    trash = vi.fn(async (path: string) => {
      const target = join(root, 'fixture-trash')
      mkdirSync(target, { recursive: true })
      renameSync(path, join(target, 'selected'))
    })
    state.library = createSkillLibrary({
      context: spaceId => ({
        manager, spaceId, haloDir: join(root, 'halo-data'), workDir: spaceId === null ? null : work,
        spaceDataPath: spaceId === null ? null : join(root, 'data', spaceId), legacyGlobalRoots: [],
      }),
      trash, openFolder: vi.fn(),
    })
    const server = createHaloAppsMcpServer('space', () => false) as unknown as {
      tools: Array<{ name: string; handler: typeof invoke }>
    }
    invoke = server.tools.find(tool => tool.name === 'skill_manage')!.handler
  })

  function personal(base: string, name: string) {
    const path = join(base, '.agents', 'skills', name, 'SKILL.md')
    writeSkillPackage(path, { 'SKILL.md': instructions(name), 'scripts/run.js': 'companion' }, {
      'assets/sample.bin': { encoding: 'base64', content: asset.toString('base64') },
    })
    return path
  }

  async function listed(scope?: string) {
    const response = await invoke({ action: 'list', scope })
    expect(response.isError).not.toBe(true)
    return JSON.parse(response.content[0].text) as { groups: Array<{ name: string; copies: Array<{ ref: SkillRef }> }> }
  }

  it('queries only current/global roots and returns reusable opaque references', async () => {
    personal(work, 'local')
    personal(root, 'global')
    personal(join(root, 'other-workspace'), 'unrelated')
    const local = await listed()
    expect(local.groups.map(group => group.name).sort()).toEqual(['global', 'local'])
    expect((await listed('global')).groups.map(group => group.name)).toEqual(['global'])
    const copies = local.groups.flatMap(group => group.copies)
    expect(copies.every(copy => /^file:[a-f0-9]{64}$/.test(copy.ref.id))).toBe(true)
    for (const copy of copies) expect((await invoke({ action: 'read', ref: copy.ref })).isError).not.toBe(true)
  })

  it('refuses arbitrary path references and cross-space references without changing files', async () => {
    const path = personal(work, 'local')
    const ref = (await listed()).groups[0].copies[0].ref
    const before = readFileSync(path)
    for (const args of [
      { action: 'delete', ref: { id: path, spaceId: 'space' }, revision: 'missing' },
      { action: 'delete', skill_id: path, revision: 'missing' },
      { action: 'delete', ref: { ...ref, spaceId: 'other' }, revision: 'missing' },
      { action: 'delete', path, revision: 'missing' },
    ]) expect((await invoke(args)).isError).toBe(true)
    expect(readFileSync(path)).toEqual(before)
    expect(trash).not.toHaveBeenCalled()
  })

  it('rejects stale saves and retains companion bytes when the current revision is saved', async () => {
    const path = personal(work, 'local')
    const ref = (await listed()).groups[0].copies[0].ref
    const previous = JSON.parse((await invoke({ action: 'read', ref })).content[0].text)
    writeFileSync(path, instructions('local', 'External edit'))
    expect((await invoke({ action: 'save', ref, revision: previous.revision, content: instructions('local', 'Stale') })).isError).toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('External edit')
    const current = JSON.parse((await invoke({ action: 'read', ref })).content[0].text)
    expect((await invoke({ action: 'save', ref, revision: current.revision, content: instructions('local', 'Approved edit') })).isError).not.toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('Approved edit')
    expect(readFileSync(join(dirname(path), 'assets/sample.bin'))).toEqual(asset)
    expect(readFileSync(join(dirname(path), 'scripts/run.js'), 'utf8')).toBe('companion')
  })

  it.each(['delete', 'uninstall'])('%s uses only the selected trash operation and fails closed when trash is unavailable', async action => {
    const path = personal(work, 'local')
    const control = personal(work, 'unrelated')
    const ref = (await listed()).groups.find(group => group.name === 'local')!.copies[0].ref
    expect((await invoke({ action, ref })).isError).toBe(true)
    expect(trash).not.toHaveBeenCalled()
    const { revision } = JSON.parse((await invoke({ action: 'read', ref })).content[0].text)
    trash.mockRejectedValueOnce(new Error('Fixture trash unavailable'))
    const failed = await invoke({ action, ref, revision })
    expect(failed.isError).toBe(true)
    expect(failed.content[0].text).toContain('Fixture trash unavailable')
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(join(dirname(path), 'assets/sample.bin'))).toEqual(asset)
    const removed = await invoke({ action, ref, revision })
    expect(removed.isError).not.toBe(true)
    expect(trash).toHaveBeenLastCalledWith(dirname(path))
    expect(existsSync(path)).toBe(false)
    expect(readFileSync(join(root, 'fixture-trash/selected/assets/sample.bin'))).toEqual(asset)
    expect(existsSync(control)).toBe(true)
  })
})
