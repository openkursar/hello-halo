import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as controller from '../../../src/main/controllers/skills.controller'
import { validateAppSpec } from '../../../src/main/apps/spec'

const { library, getLibrary } = vi.hoisted(() => {
  const library = {
    list: vi.fn(), read: vi.fn(), save: vi.fn(), import: vi.fn(), setEnabled: vi.fn(),
    movePreview: vi.fn(), move: vi.fn(), copy: vi.fn(), delete: vi.fn(), openFolder: vi.fn(),
    export: vi.fn(), restoreLegacy: vi.fn(), deleteLegacy: vi.fn(),
  }
  return { library, getLibrary: vi.fn(() => library) }
})
vi.mock('../../../src/main/apps/skills', () => ({ getSkillLibrary: getLibrary }))

const APP_ID = 'a9a7957e-2346-47d9-b714-92406811b27b'
const REF = { id: `file:${'a'.repeat(64)}`, spaceId: 'workspace-1' }
const REVISION = 'b'.repeat(64)
const SPEC = {
  type: 'skill', name: 'sample-skill', version: '1.0', description: 'A sample skill',
  skill_files: { 'SKILL.md': '# Sample', 'scripts/example.ts': 'export {}' },
  skill_assets: { 'assets/pixel.bin': { encoding: 'base64', content: 'AP8=' } },
}
const IMPORT = { spaceId: null, requestId: 'request_123', spec: SPEC }

type Operation = keyof typeof controller
const REQUESTS: Array<[Operation, keyof typeof library, Record<string, unknown>]> = [
  ['listSkills', 'list', { spaceId: null, q: 'sample', source: 'mine', offset: 5, limit: 100 }],
  ['readSkill', 'read', REF],
  ['saveSkill', 'save', { ref: REF, content: '# Updated', revision: REVISION }],
  ['importSkill', 'import', IMPORT],
  ['setSkillEnabled', 'setEnabled', { ref: REF, enabled: false }],
  ['previewSkillMove', 'movePreview', { ref: REF, spaceId: null }],
  ['moveSkill', 'move', { ref: REF, spaceId: null, revision: REVISION }],
  ['copySkill', 'copy', { ref: REF, spaceId: null, name: 'sample-copy', content: '# Copy' }],
  ['deleteSkill', 'delete', { ref: REF, revision: REVISION }],
  ['openSkillFolder', 'openFolder', REF],
  ['exportSkill', 'export', REF],
  ['restoreLegacySkill', 'restoreLegacy', { appId: APP_ID, spaceId: null, name: 'restored' }],
  ['deleteLegacySkill', 'deleteLegacy', { appId: APP_ID }],
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('skills controller', () => {
  it.each(REQUESTS)('%s forwards the complete validated input and returns raw service data', async (operation, method, input) => {
    const result = { marker: method }
    library[method].mockReturnValueOnce(result)

    expect(await controller[operation](input)).toBe(result)
    expect(library[method]).toHaveBeenCalledTimes(1)
    expect(library[method]).toHaveBeenCalledWith(operation === 'importSkill'
      ? { ...input, spec: validateAppSpec(SPEC) }
      : input)
  })

  it.each(REQUESTS)('%s rejects malformed or unknown top-level fields without resolving the library', (operation, _method, input) => {
    for (const invalid of [null, undefined, [], true, 'input', 1, {}, { ...input, filePath: '/outside/SKILL.md' }]) {
      expect(() => controller[operation](invalid)).toThrow()
    }
    expect(getLibrary).not.toHaveBeenCalled()
  })

  it('requires an explicit bounded workspace and does not coerce or default its scope', () => {
    controller.listSkills({ spaceId: null })
    controller.listSkills({ spaceId: 'x'.repeat(128) })
    expect(library.list).toHaveBeenNthCalledWith(1, { spaceId: null })
    expect(library.list).toHaveBeenNthCalledWith(2, { spaceId: 'x'.repeat(128) })
    getLibrary.mockClear()

    for (const spaceId of [undefined, '', '   ', 'x'.repeat(129), 42, [], {}]) {
      expect(() => controller.listSkills({ spaceId })).toThrow()
      expect(() => controller.readSkill({ ...REF, spaceId })).toThrow()
      expect(() => controller.previewSkillMove({ ref: REF, spaceId })).toThrow()
      expect(() => controller.copySkill({ ref: REF, spaceId, name: 'copy' })).toThrow()
      expect(() => controller.importSkill({ ...IMPORT, spaceId })).toThrow()
      expect(() => controller.restoreLegacySkill({ appId: APP_ID, spaceId })).toThrow()
    }
    expect(getLibrary).not.toHaveBeenCalled()
  })

  it('accepts only discovered file IDs or UUID-based legacy app navigation', () => {
    controller.readSkill({ id: `app:${APP_ID}`, spaceId: null })
    expect(library.read).toHaveBeenCalledWith({ id: `app:${APP_ID}`, spaceId: null })
    getLibrary.mockClear()

    for (const id of ['/outside/SKILL.md', '../escape', 'file:abc', `file:${'A'.repeat(64)}`, 'app:app-1', `app:${APP_ID}/../escape`, APP_ID, '', null, 1]) {
      expect(() => controller.readSkill({ ...REF, id })).toThrow()
      expect(() => controller.deleteSkill({ ref: { ...REF, id }, revision: REVISION })).toThrow()
    }
    expect(() => controller.readSkill({ ...REF, path: '/outside/SKILL.md' })).toThrow()
    expect(() => controller.setSkillEnabled({ ref: { ...REF, filePath: '/outside' }, enabled: true })).toThrow()
    expect(getLibrary).not.toHaveBeenCalled()
  })

  it('rejects unbounded, fractional and non-numeric pagination and invalid search fields', () => {
    for (const pagination of [
      { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: '5' }, { limit: NaN }, { limit: Infinity },
      { offset: -1 }, { offset: 1.5 }, { offset: '5' }, { offset: NaN }, { offset: Infinity },
      { offset: Number.MAX_SAFE_INTEGER + 1 }, { q: 'x'.repeat(1025) }, { q: [] }, { source: 'personal' },
    ]) {
      expect(() => controller.listSkills({ spaceId: null, ...pagination })).toThrow()
    }
    expect(getLibrary).not.toHaveBeenCalled()
  })

  it('requires a bounded nonempty revision on every file-destructive operation', () => {
    for (const revision of [undefined, null, 1, '', '   ', 'r'.repeat(513)]) {
      expect(() => controller.saveSkill({ ref: REF, content: '# Updated', revision })).toThrow()
      expect(() => controller.moveSkill({ ref: REF, spaceId: null, revision })).toThrow()
      expect(() => controller.deleteSkill({ ref: REF, revision })).toThrow()
      expect(() => controller.importSkill({ ...IMPORT, replace: { ref: REF, revision } })).toThrow()
    }
    expect(getLibrary).not.toHaveBeenCalled()
  })

  it('bounds instructions by UTF-8 bytes without changing their content', () => {
    const content = 'a'.repeat(1024 * 1024)
    controller.saveSkill({ ref: REF, content, revision: REVISION })
    expect(library.save).toHaveBeenCalledWith({ ref: REF, content, revision: REVISION })
    getLibrary.mockClear()

    for (const invalid of [content + 'a', '界'.repeat(350000), null, 42, {}]) {
      expect(() => controller.saveSkill({ ref: REF, content: invalid, revision: REVISION })).toThrow()
      expect(() => controller.copySkill({ ref: REF, spaceId: null, name: 'copy', content: invalid })).toThrow()
    }
    expect(getLibrary).not.toHaveBeenCalled()
  })

  it('requires a real boolean and bounded copy/recovery names', () => {
    for (const enabled of ['false', 0, null, undefined]) {
      expect(() => controller.setSkillEnabled({ ref: REF, enabled })).toThrow()
    }
    for (const name of ['', '   ', 'n'.repeat(129), null, 1]) {
      expect(() => controller.copySkill({ ref: REF, spaceId: null, name })).toThrow()
      expect(() => controller.restoreLegacySkill({ appId: APP_ID, spaceId: null, name })).toThrow()
    }
    expect(getLibrary).not.toHaveBeenCalled()
  })

  it('requires a stable bounded import request ID and explicit replacement ref plus revision', () => {
    for (const requestId of [undefined, '', 'short', 'x'.repeat(129), 'with space', '../escape', 1]) {
      expect(() => controller.importSkill({ ...IMPORT, requestId })).toThrow()
    }
    for (const replace of [null, {}, { ref: REF }, { revision: REVISION }, { ref: REF, revision: REVISION, filePath: '/outside' }]) {
      expect(() => controller.importSkill({ ...IMPORT, replace })).toThrow()
    }
    expect(getLibrary).not.toHaveBeenCalled()

    const replace = { ref: REF, revision: REVISION }
    controller.importSkill({ ...IMPORT, replace })
    expect(library.import).toHaveBeenCalledWith({ ...IMPORT, spec: validateAppSpec(SPEC), replace })
  })

  it('validates the full spec and rejects other app types before reaching the skill service', () => {
    for (const spec of [undefined, null, [], 'spec', {}, { ...SPEC, version: null }, { ...SPEC, skill_files: { 'SKILL.md': 1 } }, { ...SPEC, skill_assets: { 'asset.bin': { encoding: 'hex', content: '00' } } }, { ...SPEC, type: 'automation', author: 'Halo', system_prompt: 'Run' }]) {
      expect(() => controller.importSkill({ ...IMPORT, spec })).toThrow()
    }
    expect(getLibrary).not.toHaveBeenCalled()
  })

  it('keeps spec normalization and private-field stripping in the existing validator', () => {
    const spec = { ...SPEC, name: '测试技能', filePath: '/outside', userOverrides: { skill: { filePath: '/outside' } } }
    controller.importSkill({ ...IMPORT, spec })
    const received = library.import.mock.calls[0][0]
    expect(received.spec).toEqual(validateAppSpec(spec))
    expect(received.spec.name).not.toBe(spec.name)
    expect(received.spec.filePath).toBeUndefined()
    expect(received.spec.userOverrides).toBeUndefined()
  })

  it('requires UUIDs for both legacy actions', () => {
    for (const appId of [undefined, '', 'app-1', `app:${APP_ID}`, '../escape', 1]) {
      expect(() => controller.restoreLegacySkill({ appId, spaceId: null })).toThrow()
      expect(() => controller.deleteLegacySkill({ appId })).toThrow()
    }
    expect(getLibrary).not.toHaveBeenCalled()
  })

  it('does not copy invalid submitted values into errors consumed by transport logging', () => {
    const secret = 'private instruction body'
    expect(() => controller.listSkills({ spaceId: null, source: secret })).toThrow('Invalid skill request field: source')
    try {
      controller.importSkill({ ...IMPORT, spec: { ...SPEC, skill_assets: { 'asset.bin': { encoding: secret, content: 'AA==' } } } })
      expect.fail('The malformed asset should be rejected')
    } catch (error) {
      expect(String(error)).not.toContain(secret)
      expect(error).not.toHaveProperty('issues')
    }
  })

  it('leaves service resolution and revision failures intact for the transport to report once', () => {
    const error = new Error('The skill changed; read it again.')
    library.save.mockImplementationOnce(() => { throw error })
    expect(() => controller.saveSkill({ ref: REF, content: 'updated', revision: REVISION })).toThrow(error)
  })
})
