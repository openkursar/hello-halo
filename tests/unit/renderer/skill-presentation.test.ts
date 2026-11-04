import { describe, expect, it, vi } from 'vitest'
import type { SkillCopy, SkillGroup } from '../../../src/shared/types/skills'
import { selectedSkill, skillDisplay, skillErrorMessage, skillSourceLabel, skillInstructions } from '../../../src/renderer/utils/skill-presentation'

function copy(overrides: Partial<SkillCopy> = {}): SkillCopy {
  return {
    id: 'review-a', name: 'review', displayName: 'Review code', description: 'Check a change',
    path: '/workspace/.agents/skills/review/SKILL.md', scope: 'space', spaceId: 'a',
    source: 'personal', owners: [], enabled: true, availability: 'available', revision: 'revision-a',
    editable: true, isLink: false, ...overrides,
  }
}

function group(copies: SkillCopy[], effectiveId?: string): SkillGroup {
  return { name: 'review', displayName: 'Review', description: 'Review changes', source: 'mine', conflict: false, copies, effectiveId }
}

describe('skill presentation', () => {
  it('previews only the instruction body without changing the editable file', () => {
    const content = '\uFEFF---\r\nname: sample\r\nuser-invocable: true\r\nx-custom: preserved\r\n---\r\n\r\n# Instructions\r\nDo the work.\r\n'
    expect(skillInstructions(content)).toBe('# Instructions\r\nDo the work.\r\n')
    expect(content).toContain('x-custom: preserved')
    expect(skillInstructions('# Legacy instructions\nBody')).toBe('# Legacy instructions\nBody')
    expect(skillInstructions('---\nUnclosed header')).toBe('---\nUnclosed header')
  })

  it('uses the effective identity instead of list order or identical display names', () => {
    const shadow = copy({ id: 'shadow', availability: 'overridden' })
    const effective = copy()
    expect(selectedSkill(group([shadow, effective], effective.id))).toBe(effective)
    expect(selectedSkill(group([shadow, effective]))).toBe(shadow)
    expect(selectedSkill(group([]))).toBeUndefined()
  })

  it('supports copies without optional metadata and never mutates their command identity', () => {
    const original = copy()
    expect(skillDisplay(original, 'zh-CN')).toMatchObject({ name: 'Review code', description: 'Check a change' })
    expect(original.name).toBe('review')
    expect(original).not.toHaveProperty('i18n')
    expect(original).not.toHaveProperty('version')
  })

  it('localizes only the display name and description with a canonical fallback', () => {
    const original = copy({ version: '1.2', i18n: { 'zh-CN': { name: '代码评审', description: '检查变更' }, ja: { name: 'コードレビュー' } } })
    expect(skillDisplay(original, 'zh-CN')).toMatchObject({ name: '代码评审', description: '检查变更' })
    expect(skillDisplay(original, 'zh-TW')).toMatchObject({ name: '代码评审', description: '检查变更' })
    expect(skillDisplay(original, 'ja')).toMatchObject({ name: 'コードレビュー', description: 'Check a change' })
    expect(skillDisplay(original, 'de')).toMatchObject({ name: 'Review code', description: 'Check a change' })
    expect(original.name).toBe('review')
    expect(original.version).toBe('1.2')
  })

  it.each([
    ['personal', 'Custom'], ['store', 'Store'], ['builtin', 'Built-in'], ['digital-human', 'Digital human skills'],
  ] as const)('translates the %s source label', (source, label) => {
    const t = vi.fn((key: string) => `translated:${key}`)
    expect(skillSourceLabel(copy({ source }), t)).toBe(`translated:${label}`)
    expect(t).toHaveBeenCalledWith(label)
  })

  it('shows true digital-human owners instead of inventing a source label', () => {
    const t = vi.fn((key: string) => key)
    expect(skillSourceLabel(copy({ source: 'digital-human', owners: [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }] }), t)).toBe('Alice, Bob')
    expect(t).not.toHaveBeenCalled()
  })
})

describe('skill failure presentation', () => {
  it.each([
    ['ENOENT: no such file, /private/skills/review/SKILL.md', 'The skill file could not be found. Check its folder or import the skill again.'],
    ['The file is no longer available at /private/skills/review', 'The skill file could not be found. Check its folder or import the skill again.'],
    ['EACCES: permission denied, /private/skills/review', 'Halo cannot access this skill folder. Check its permissions and try again.'],
    ['EPERM: operation not permitted, /private/skills/review', 'Halo cannot access this skill folder. Check its permissions and try again.'],
    ['read-only folder /private/skills/review', 'Halo cannot access this skill folder. Check its permissions and try again.'],
    ['Concurrent edit at /private/skills/review', 'This skill was changed elsewhere. Your draft is kept; reload the file before saving again.'],
    ['Revision changed since reading /private/skills/review', 'This skill was changed elsewhere. Your draft is kept; reload the file before saving again.'],
    ['Destination already exists: /private/skills/review', 'A skill with this name already exists there. Choose another name or workspace.'],
    ['A skill already has the same name', 'A skill with this name already exists there. Choose another name or workspace.'],
  ])('replaces raw diagnostics with translated recovery guidance: %s', (failure, expected) => {
    const t = vi.fn((key: string) => `translated:${key}`)
    const message = skillErrorMessage(new Error(failure), 'fallback', t)
    expect(message).toBe(`translated:${expected}`)
    expect(message).not.toMatch(/ENOENT|EACCES|EPERM|\/private\//)
    expect(t).toHaveBeenCalledOnce()
    expect(t).toHaveBeenCalledWith(expected)
  })

  it.each([new Error('Unexpected /private/path'), 'Unhandled backend detail', undefined, { error: 'ENOENT /private/path' }])('keeps unknown failures bounded to the caller supplied translated fallback', failure => {
    const t = vi.fn((key: string) => key)
    expect(skillErrorMessage(failure, 'translated fallback', t)).toBe('translated fallback')
    expect(t).not.toHaveBeenCalled()
  })
})
