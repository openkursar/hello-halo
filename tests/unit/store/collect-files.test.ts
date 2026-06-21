/**
 * Unit tests for collectFiles — the shared file-collection step used by both
 * publish and dhpkg export, covering bundled-skill packaging for digital
 * humans and the missingSkillIds failure contract.
 */

import { describe, it, expect, vi } from 'vitest'

// collectFiles itself is pure, but publish/index.ts also wires the publish()
// entry point to app-manager bootstrap, product config, and the registry —
// none of which can load in plain Node. Stub those siblings out.
vi.mock('../../../src/main/apps/manager', () => ({ getAppManager: () => null }))
vi.mock('../../../src/main/services/ai-sources/auth-loader', () => ({ loadProductConfig: () => ({}) }))
vi.mock('../../../src/main/store/registry.service', () => ({ getRegistries: () => [] }))

import { collectFiles } from '../../../src/main/store/publish'
import { pack, unpack } from '../../../src/main/store/dhpkg'
import type { AppManagerService } from '../../../src/main/apps/manager'
import type { AppSpec } from '../../../src/main/apps/spec/schema'

function skillSpec(): AppSpec {
  return {
    spec_version: '1',
    name: 'bundled-skill',
    version: '0.1.0',
    author: 'tester',
    description: 'unit-test',
    type: 'skill',
    skill_files: { 'SKILL.md': '# skill\n', 'spec.yaml': 'should-be-excluded', 'scripts/run.js': 'x()' },
  } as AppSpec
}

function dhSpec(deps: AppSpec['requires']): AppSpec {
  return {
    spec_version: '1',
    name: 'dh-test',
    version: '1.0.0',
    author: 'tester',
    description: 'unit-test',
    type: 'automation',
    system_prompt: 'do things',
    subscriptions: [],
    requires: deps,
  } as unknown as AppSpec
}

function fakeManager(skillApps: { specId: string; spec: AppSpec }[]): AppManagerService {
  return {
    listEffectiveSkillApps: () => skillApps,
    listApps: () => skillApps,
  } as unknown as AppManagerService
}

describe('store/collectFiles', () => {
  it('skill: returns own skill_files minus spec.yaml', () => {
    const { files, missingSkillIds } = collectFiles(skillSpec(), fakeManager([]), null)
    expect(missingSkillIds).toEqual([])
    expect(files).toEqual({ 'SKILL.md': '# skill\n', 'scripts/run.js': 'x()' })
  })

  it('digital human: collects bundled skill files under skills/<id>/', () => {
    const spec = dhSpec({ skills: [{ id: 'bundled-skill', bundled: true }] })
    const manager = fakeManager([{ specId: 'bundled-skill', spec: skillSpec() }])
    const { files, missingSkillIds } = collectFiles(spec, manager, 'space-1')
    expect(missingSkillIds).toEqual([])
    expect(files).toEqual({
      'skills/bundled-skill/SKILL.md': '# skill\n',
      'skills/bundled-skill/scripts/run.js': 'x()',
    })
  })

  it('digital human: reports missing bundled skills instead of silently dropping them', () => {
    const spec = dhSpec({ skills: [{ id: 'absent-skill', bundled: true }] })
    const { files, missingSkillIds } = collectFiles(spec, fakeManager([]), 'space-1')
    expect(files).toEqual({})
    expect(missingSkillIds).toEqual(['absent-skill'])
  })

  it('digital human: non-bundled and string deps contribute no files', () => {
    const spec = dhSpec({ skills: ['plain-dep', { id: 'soft-dep', bundled: false }] })
    const { files, missingSkillIds } = collectFiles(spec, fakeManager([]), 'space-1')
    expect(files).toEqual({})
    expect(missingSkillIds).toEqual([])
  })

  it('packs into a dhpkg whose entries match the registry layout', async () => {
    const spec = dhSpec({ skills: [{ id: 'bundled-skill', bundled: true }] })
    const manager = fakeManager([{ specId: 'bundled-skill', spec: skillSpec() }])
    const { files } = collectFiles(spec, manager, 'space-1')
    const buf = await pack(spec, files)
    const unpacked = await unpack(buf)
    expect(unpacked.spec.name).toBe('dh-test')
    expect(Object.keys(unpacked.files).sort()).toEqual([
      'skills/bundled-skill/SKILL.md',
      'skills/bundled-skill/scripts/run.js',
    ])
  })
})
