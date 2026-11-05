import { describe, it, expect } from 'vitest'
import {
  findReferencedSkillNames,
  withDeclaredSkills,
} from '../../../src/shared/apps/skill-references'

describe('findReferencedSkillNames', () => {
  it('matches whole skill names in prose, slash commands and skill paths', () => {
    const prompt = [
      '优先使用 report-builder skill；',
      'run /promo-deck first.',
      'browser_run({ file: ".claude/skills/site-list/index.js" })',
    ].join('\n')
    expect(findReferencedSkillNames(prompt, ['report-builder', 'promo-deck', 'site-list', 'unused']))
      .toEqual(['promo-deck', 'report-builder', 'site-list'])
  })

  it('does not match a name inside a longer name', () => {
    expect(findReferencedSkillNames('use group-builder-v2', ['group-builder'])).toEqual([])
    expect(findReferencedSkillNames('use my_report_tool', ['report'])).toEqual([])
  })

  it('ignores names shorter than three characters and empty text', () => {
    expect(findReferencedSkillNames('go to qa now', ['qa'])).toEqual([])
    expect(findReferencedSkillNames('', ['promo-deck'])).toEqual([])
  })

  it('is case-insensitive', () => {
    expect(findReferencedSkillNames('Use Promo-Deck.', ['promo-deck'])).toEqual(['promo-deck'])
  })
})

describe('withDeclaredSkills', () => {
  it('appends ids and keeps the other requires fields', () => {
    expect(withDeclaredSkills({ mcps: [{ id: 'm' }], skills: ['a'] }, ['b'])).toEqual({ mcps: [{ id: 'm' }], skills: ['a', { id: 'b' }] })
    expect(withDeclaredSkills(undefined, ['b'])).toEqual({ skills: [{ id: 'b' }] })
  })

  it('skips ids already declared, in any case or form', () => {
    expect(withDeclaredSkills({ skills: ['acme/Image', { id: 'b' }] }, ['acme/image', 'B', 'c', 'c']))
      .toEqual({ skills: ['acme/Image', { id: 'b' }, { id: 'c' }] })
  })
})
