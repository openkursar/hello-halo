/**
 * Unit tests for collectFiles — the shared file-collection step used by both
 * publish and dhpkg export, covering bundled-skill packaging for digital
 * humans and the missingSkillIds failure contract.
 */

import { describe, it, expect, vi } from 'vitest'


// Newly reachable via ai-sources/manager.ts or mcp-manager.ts pulling in
// analytics.service.ts (which statically imports providers/baidu.ts's
// `BrowserWindow` from 'electron') — mock it out like every other test that
// touches this transitive chain, so this file's own module graph controls
// what it needs rather than the real telemetry provider stack.
vi.mock('../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() }
}))

// collectFiles itself is pure, but publish/index.ts also wires the publish()
// entry point to app-manager bootstrap, product config, and the registry —
// none of which can load in plain Node. Stub those siblings out.
vi.mock('../../../src/main/apps/manager', () => ({ getAppManager: () => null }))
vi.mock('../../../src/main/services/ai-sources/auth-loader', () => ({ loadProductConfig: () => ({}) }))
vi.mock('../../../src/main/store/registry.service', () => ({ getRegistries: () => [], findStoreEntry: () => null }))

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
  const rows = skillApps.map((app, index) => ({ ...app, id: `skill-${index}`, status: 'active', spaceId: null, userOverrides: {} }))
  return {
    listEffectiveSkillApps: () => rows,
    listApps: () => rows,
    listSkillRecords: (spaceId: string | null) => rows.filter(row => row.spaceId === spaceId),
    getApp: (id: string) => rows.find(app => app.id === id),
  } as unknown as AppManagerService
}

describe('store/collectFiles', () => {
  it('skill: returns own skill_files minus spec.yaml', () => {
    const { files, missingSkillIds } = collectFiles(skillSpec(), fakeManager([]), null)
    expect(missingSkillIds).toEqual([])
    expect(files).toEqual({ 'SKILL.md': '# skill\n', 'scripts/run.js': 'x()' })
  })

  it('selects an explicit source slug despite namespaced identities and rejects ambiguous names', () => {
    const a = { ...skillSpec(), store: { slug: 'one/bundled-skill', install_source: 'store', tags: [] }, skill_files: { 'SKILL.md': 'SOURCE_A' } } as AppSpec
    const b = { ...skillSpec(), store: { slug: 'two/bundled-skill', install_source: 'store', tags: [] }, skill_files: { 'SKILL.md': 'SOURCE_B' } } as AppSpec
    const manager = fakeManager([{ specId: 'skill:hash-a:bundled-skill', spec: a }, { specId: 'skill:hash-b:bundled-skill', spec: b }])
    expect(() => collectFiles(dhSpec({ skills: [{ id: 'bundled-skill', bundled: true }] }), manager, null)).toThrow(/multiple installed sources/)
    const result = collectFiles(dhSpec({ skills: [{ id: 'two/bundled-skill', bundled: true }] }), manager, null)
    expect(result.files['skills/two/bundled-skill/SKILL.md']).toBe('SOURCE_B')
    expect(JSON.stringify(result.files)).not.toContain('SOURCE_A')
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

  it('digital human: non-bundled and string deps are flagged missing when unresolvable and not installed', () => {
    const spec = dhSpec({ skills: ['plain-dep', { id: 'soft-dep', bundled: false }] })
    const { files, missingSkillIds } = collectFiles(spec, fakeManager([]), 'space-1')
    expect(files).toEqual({})
    expect(missingSkillIds).toEqual(['plain-dep', 'soft-dep'])
  })

  it('reads current global personal content instead of the body-free list record', () => {
    const manager = fakeManager([{ specId: 'bundled-skill', spec: skillSpec() }])
    manager.listSkillRecords = (() => [{ id: 'skill-0', specId: 'bundled-skill', status: 'active', spaceId: null, userOverrides: {}, spec: { ...skillSpec(), skill_files: undefined } }]) as any
    const { files } = collectFiles(dhSpec({ skills: ['bundled-skill'] }), manager, null)
    expect(files['skills/bundled-skill/SKILL.md']).toBe('# skill\n')
  })

  it('preserves binary resources through collection and package roundtrip', async () => {
    const bytes = Buffer.from([0, 255, 128, 10, 13])
    const spec = { ...skillSpec(), skill_assets: { 'images/probe.bin': { encoding: 'base64', content: bytes.toString('base64') } } } as AppSpec
    const { files } = collectFiles(spec, fakeManager([]), null)
    expect(files['images/probe.bin']).toEqual(bytes)
    const unpacked = await unpack(await pack(spec, files))
    expect(unpacked.files['images/probe.bin']).toEqual(bytes)
  })

  it('packages a bundled dependency binary from its current file snapshot', () => {
    const bytes = Buffer.from([255, 0, 128])
    const spec = { ...skillSpec(), skill_assets: { 'probe.bin': { encoding: 'base64', content: bytes.toString('base64') } } } as AppSpec
    const { files } = collectFiles(dhSpec({ skills: [{ id: 'bundled-skill', bundled: true }] }), fakeManager([{ specId: 'bundled-skill', spec }]), 'space-1')
    expect(files['skills/bundled-skill/probe.bin']).toEqual(bytes)
  })

  it.each(['%%%=', 'AA'])('rejects malformed base64 rather than publishing partial content', content => {
    const spec = { ...skillSpec(), skill_assets: { 'probe.bin': { encoding: 'base64', content } } } as AppSpec
    expect(() => collectFiles(spec, fakeManager([]), null)).toThrow(/base64/)
  })

  it('rejects escaping resource paths', () => {
    const spec = { ...skillSpec(), skill_assets: { '../escape': { encoding: 'base64', content: 'AA==' } } } as AppSpec
    expect(() => collectFiles(spec, fakeManager([]), null)).toThrow()
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
