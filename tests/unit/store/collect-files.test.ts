/**
 * Unit tests for collectFiles — the shared file-collection step used by both
 * publish and dhpkg export, covering bundled-skill packaging for digital
 * humans and the missingSkillIds failure contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'


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
const storeEntry = vi.fn((_slug: string): { entry: { slug: string; name: string; type: string }; registryId: string } | null => null)
// Mirrors registry.service's rule over the mocked index: a skill, from an enabled source.
vi.mock('../../../src/main/store/registry.service', () => ({
  getRegistries: () => [{ id: 'on', enabled: true }, { id: 'off', enabled: false }],
  findStoreEntry: (slug: string) => storeEntry(slug),
  findSkillListing: (slug: string) => {
    const found = storeEntry(slug)
    return found && found.entry.type === 'skill' && found.registryId === 'on' ? found : null
  },
}))
// Disk scanning is stubbed; resolving a dependency against the listed skills is real.
const undeclaredSkills = vi.fn((): Array<{ id: string; folder: string }> => [])
const loadableSkills = vi.fn((): LoadableSkill[] => [])
const diskFiles = vi.fn((skill: LoadableSkill): Record<string, string> | null => ({ 'SKILL.md': `# ${skill.folder}\n` }))
vi.mock('../../../src/main/apps/skill-discovery', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/main/apps/skill-discovery')>()),
  findUndeclaredSkills: () => undeclaredSkills(),
  listLoadableSkills: () => loadableSkills(),
  readLoadableSkillFiles: (skill: LoadableSkill) => diskFiles(skill),
  hasPackageableSkillMd: (skill: LoadableSkill) => !!diskFiles(skill)?.['SKILL.md'],
}))

import { collectFiles, inspectSkillDeps } from '../../../src/main/store/publish'
import { pack, unpack } from '../../../src/main/store/dhpkg'
import type { AppManagerService } from '../../../src/main/apps/manager'
import type { AppSpec } from '../../../src/main/apps/spec/schema'
import type { LoadableSkill } from '../../../src/main/apps/skill-discovery'

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

  it('digital human: non-bundled and string deps are flagged missing when unresolvable and not installed', () => {
    const spec = dhSpec({ skills: ['plain-dep', { id: 'soft-dep', bundled: false }] })
    const { files, missingSkillIds } = collectFiles(spec, fakeManager([]), 'space-1')
    expect(files).toEqual({})
    expect(missingSkillIds).toEqual(['plain-dep', 'soft-dep'])
  })

  it('digital human: packages a hand-placed skill folder, which has no installed app, from disk', () => {
    loadableSkills.mockReturnValueOnce([{ folder: 'report-builder', path: '/skills/report-builder', app: null }])
    const spec = dhSpec({ skills: [{ id: 'report-builder' }] })
    const { files, missingSkillIds } = collectFiles(spec, fakeManager([]), 'space-1')
    expect(missingSkillIds).toEqual([])
    expect(files).toEqual({ 'skills/report-builder/SKILL.md': '# report-builder\n' })
  })

  it('digital human: packages a Store-slug dependency under its folder, declared bundled by that name', () => {
    const app = { id: 'app-image', specId: 'Image Gen', spec: { ...skillSpec(), store: { slug: 'acme/image-gen-2', install_source: 'store' } } }
    loadableSkills.mockReturnValueOnce([{ folder: 'Image_Gen', path: '/skills/Image_Gen', app } as unknown as LoadableSkill])
    const spec = dhSpec({ skills: ['acme/image-gen-2', { id: 'report-builder', reason: 'tables' }] })
    const manager = fakeManager([app as never, { specId: 'report-builder', spec: skillSpec() }])
    const { files, missingSkillIds, packagedSpec } = collectFiles(spec, manager, 'space-1')
    expect(missingSkillIds).toEqual([])
    expect(new Set(Object.keys(files).map(path => path.split('/')[1]))).toEqual(new Set(['Image_Gen', 'report-builder']))
    expect(Object.keys(files).filter(path => path.startsWith('skills/Image_Gen/'))).toEqual(['skills/Image_Gen/SKILL.md', 'skills/Image_Gen/scripts/run.js'])
    expect(packagedSpec.type === 'automation' && packagedSpec.requires?.skills).toEqual([
      { id: 'Image_Gen', bundled: true, files: ['SKILL.md', 'scripts/run.js'] },
      { id: 'report-builder', reason: 'tables', bundled: true, files: ['SKILL.md', 'scripts/run.js'] },
    ])
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

describe('store/inspectSkillDeps', () => {
  it('lists declared dependencies as declared', () => {
    const spec = dhSpec({ skills: ['bundled-skill'] })
    const manager = fakeManager([{ specId: 'bundled-skill', spec: skillSpec() }])
    const result = inspectSkillDeps(spec, manager, 'space-1')
    expect(result.map(d => ({ id: d.id, declared: d.declared, installed: d.installed }))).toEqual([
      { id: 'bundled-skill', declared: true, installed: true },
    ])
  })

  it('adds skills the prompt uses but requires.skills lacks, marked undeclared', () => {
    undeclaredSkills.mockReturnValueOnce([{ id: 'local-skill', folder: 'local-skill' }])
    const spec = dhSpec(undefined)
    const result = inspectSkillDeps(spec, fakeManager([]), 'space-1')
    expect(result).toEqual([
      { id: 'local-skill', declaredBundled: false, resolvable: false, installed: false, appId: null, storeName: null, declared: false },
    ])
  })

  it('treats a dependency on a hand-placed skill folder as present, with no app to list separately', () => {
    loadableSkills.mockReturnValue([{ folder: 'report-builder', path: '/skills/report-builder', app: null }])
    const result = inspectSkillDeps(dhSpec({ skills: ['report-builder'] }), fakeManager([]), 'space-1')
    loadableSkills.mockReturnValue([])
    expect(result).toEqual([
      { id: 'report-builder', declaredBundled: false, resolvable: false, installed: true, appId: null, storeName: null, declared: true },
    ])
  })

  it('matches an installed skill declared by its Store slug, not only by specId', () => {
    const app = { id: 'app-image', specId: 'Image Gen', spec: { ...skillSpec(), store: { slug: 'acme/image-gen-2', install_source: 'store' } } }
    loadableSkills.mockReturnValue([{ folder: 'Image_Gen', path: '/skills/Image_Gen', app } as unknown as LoadableSkill])
    const result = inspectSkillDeps(dhSpec({ skills: ['acme/image-gen-2'] }), fakeManager([app as never]), 'space-1')
    loadableSkills.mockReturnValue([])
    expect(result.map(d => ({ id: d.id, installed: d.installed, appId: d.appId }))).toEqual([
      { id: 'acme/image-gen-2', installed: true, appId: 'app-image' },
    ])
  })
})

describe('store/collectFiles — which copy of a skill travels', () => {
  const handPlaced = (folder: string): LoadableSkill => ({ folder, path: `/skills/${folder}`, app: null })
  const listing = (slug: string, type = 'skill', registryId = 'on') => ({ entry: { slug, name: slug, type }, registryId })

  beforeEach(() => {
    loadableSkills.mockReset().mockReturnValue([])
    storeEntry.mockReset().mockReturnValue(null)
    diskFiles.mockClear()
  })

  it('packages the folder the engine loads, not an installed app it shadows', () => {
    loadableSkills.mockReturnValue([handPlaced('report-builder')])
    const shadowed = { id: 'app-global', specId: 'report-builder', spec: { ...skillSpec(), skill_files: { 'SKILL.md': 'GLOBAL COPY' } } }
    const manager = fakeManager([shadowed as never])
    const spec = dhSpec({ skills: ['report-builder'] })
    expect(collectFiles(spec, manager, 'space-1').files).toEqual({ 'skills/report-builder/SKILL.md': '# report-builder\n' })
    expect(inspectSkillDeps(spec, manager, 'space-1')[0]).toMatchObject({ installed: true, appId: null })
  })

  it("packages a hand-placed folder instead of someone else's Store listing of the same name", () => {
    loadableSkills.mockReturnValue([handPlaced('fix')])
    storeEntry.mockReturnValue(listing('fix'))
    const { files, missingSkillIds } = collectFiles(dhSpec({ skills: ['fix'] }), fakeManager([]), 'space-1')
    expect(missingSkillIds).toEqual([])
    expect(Object.keys(files)).toEqual(['skills/fix/SKILL.md'])
  })

  it('references the Store for a skill installed from that very listing', () => {
    const app = { id: 'app-x', specId: 'x', spec: { ...skillSpec(), store: { slug: 'acme/x', install_source: 'store' } } }
    loadableSkills.mockReturnValue([{ folder: 'x', path: '/skills/x', app } as unknown as LoadableSkill])
    storeEntry.mockReturnValue(listing('acme/x'))
    expect(collectFiles(dhSpec({ skills: ['acme/x'] }), fakeManager([app as never]), 'space-1').files).toEqual({})
  })

  it('does not count a digital-human listing or a turned-off source as resolving a skill', () => {
    storeEntry.mockReturnValueOnce(listing('helper', 'automation')).mockReturnValueOnce(listing('other', 'skill', 'off'))
    expect(collectFiles(dhSpec({ skills: ['helper', 'other'] }), fakeManager([]), 'space-1').missingSkillIds).toEqual(['helper', 'other'])
  })

  it('neither packages nor reports a skill Halo ships, and drops it from the packaged spec', () => {
    const pdf = { id: 'app-pdf', specId: 'pdf', spec: { ...skillSpec(), store: { slug: 'halo-builtin-skills/pdf', install_source: 'bundled' } } }
    loadableSkills.mockReturnValue([{ folder: 'pdf', path: '/skills/pdf', app: pdf } as unknown as LoadableSkill, handPlaced('report-builder')])
    storeEntry.mockReturnValue(listing('pdf'))
    const spec = dhSpec({ skills: ['pdf', 'report-builder'] })
    const { files, missingSkillIds, packagedSpec } = collectFiles(spec, fakeManager([pdf as never]), 'space-1')
    expect(missingSkillIds).toEqual([])
    expect(Object.keys(files)).toEqual(['skills/report-builder/SKILL.md'])
    expect(packagedSpec.type === 'automation' && packagedSpec.requires?.skills).toEqual([
      { id: 'report-builder', bundled: true, files: ['SKILL.md'] },
    ])
    expect(inspectSkillDeps(spec, fakeManager([pdf as never]), 'space-1').map(d => d.id)).toEqual(['report-builder'])
  })

  it('keeps a product-specific builtin skill in the exported package and dependency list', async () => {
    const app = { id: 'app-private', specId: 'private-helper', spec: { ...skillSpec(), name: 'private-helper', store: { install_source: 'builtin' } } }
    loadableSkills.mockReturnValue([{ folder: 'private-helper', path: '/skills/private-helper', app } as unknown as LoadableSkill])
    const spec = dhSpec({ skills: [{ id: 'private-helper', bundled: true }] })
    const manager = fakeManager([app as never])
    const { files, missingSkillIds, packagedSpec } = collectFiles(spec, manager, 'space-1')
    expect(missingSkillIds).toEqual([])
    expect(files['skills/private-helper/SKILL.md']).toBe('# skill\n')
    expect(packagedSpec.requires?.skills).toEqual([
      { id: 'private-helper', bundled: true, files: ['SKILL.md', 'scripts/run.js'] },
    ])
    expect(inspectSkillDeps(spec, manager, 'space-1')[0]).toMatchObject({ id: 'private-helper', installed: true })
    const restored = await unpack(await pack(packagedSpec, files))
    expect(restored.spec.requires?.skills).toEqual(packagedSpec.requires?.skills)
    expect(restored.files['skills/private-helper/scripts/run.js'].toString('utf8')).toBe('x()')
  })

  it('reports a folder that reads back without its SKILL.md as missing, in the dialog too', () => {
    loadableSkills.mockReturnValue([handPlaced('report-builder')])
    diskFiles.mockReturnValue({ 'scripts/run.js': 'x()' })
    const spec = dhSpec({ skills: ['report-builder'] })
    const { files, missingSkillIds } = collectFiles(spec, fakeManager([]), 'space-1')
    expect(files).toEqual({})
    expect(missingSkillIds).toEqual(['report-builder'])
    expect(inspectSkillDeps(spec, fakeManager([]), 'space-1')[0]).toMatchObject({ id: 'report-builder', installed: false })
    diskFiles.mockImplementation((skill: LoadableSkill) => ({ 'SKILL.md': `# ${skill.folder}\n` }))
  })

  it('reports a folder that cannot be read whole as missing rather than packaging part of it', () => {
    loadableSkills.mockReturnValue([handPlaced('report-builder')])
    // SKILL.md checks out; reading the whole folder then fails.
    diskFiles.mockReturnValueOnce({ 'SKILL.md': '# x' }).mockReturnValueOnce(null)
    const { files, missingSkillIds } = collectFiles(dhSpec({ skills: ['report-builder'] }), fakeManager([]), 'space-1')
    expect(files).toEqual({})
    expect(missingSkillIds).toEqual(['report-builder'])
  })

  it('packages a skill written in Halo, which keeps only skill_content', () => {
    const written = { id: 'app-notes', specId: 'notes', spec: { type: 'skill', name: 'notes', skill_content: '# notes' } }
    loadableSkills.mockReturnValue([{ folder: 'notes', path: '/skills/notes', app: written } as unknown as LoadableSkill])
    const spec = dhSpec({ skills: ['notes'] })
    const { files, missingSkillIds } = collectFiles(spec, fakeManager([written as never]), 'space-1')
    expect(missingSkillIds).toEqual([])
    expect(files).toEqual({ 'skills/notes/SKILL.md': '# notes' })
    expect(inspectSkillDeps(spec, fakeManager([written as never]), 'space-1')[0]).toMatchObject({ installed: true, appId: 'app-notes' })
  })
})
