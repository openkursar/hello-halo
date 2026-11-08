import { describe, it, expect } from 'vitest'
import { ensureSkillMdName, skillFilesOf } from '../../../src/shared/skill-frontmatter'

describe('ensureSkillMdName', () => {
  it('sets the name in an existing block', () => {
    expect(ensureSkillMdName('---\nname: old\ndescription: d\n---\nBody', 'new')).toBe('---\nname: new\ndescription: d\n---\nBody')
    expect(ensureSkillMdName('---\ndescription: d\n---\nBody', 'new')).toBe('---\nname: new\ndescription: d\n---\nBody')
  })

  it('fills an empty block instead of stacking a second one on top', () => {
    expect(ensureSkillMdName('---\n---\nBody', 'new')).toBe('---\nname: new\n---\nBody')
  })

  it('adds a block when there is none, quoting a value YAML would misread', () => {
    expect(ensureSkillMdName('# Body', 'new')).toBe('---\nname: new\n---\n\n# Body')
    expect(ensureSkillMdName('# Body', 'a: b')).toBe('---\nname: "a: b"\n---\n\n# Body')
  })
})

describe('skillFilesOf', () => {
  it('prefers skill_files and falls back to skill_content', () => {
    expect(skillFilesOf({ skill_files: { 'SKILL.md': 'a' }, skill_content: 'b' })).toEqual({ 'SKILL.md': 'a' })
    expect(skillFilesOf({ skill_files: {}, skill_content: 'b' })).toEqual({ 'SKILL.md': 'b' })
    expect(skillFilesOf({})).toEqual({})
  })
})
