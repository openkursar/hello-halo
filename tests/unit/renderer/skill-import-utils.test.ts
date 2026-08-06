/**
 * Unit tests for skill package parsing.
 *
 * The case handling is the point: a `skill.md` authored on macOS or Windows is
 * a working skill there and an invisible one on Linux, because everything
 * downstream — frontmatter normalization, the on-disk sync, SDK discovery —
 * addresses `SKILL.md` exactly. Import has to absorb that, not reject it.
 */

import { describe, it, expect } from 'vitest'
import { parseSkillFiles } from '../../../src/renderer/components/apps/skill-import-utils'

const SKILL_MD = `---
name: my-skill
description: Does a thing.
---

# My Skill
`

describe('parseSkillFiles', () => {
  it('accepts a misspelled entry file and ships it canonically', () => {
    const parsed = parseSkillFiles({ 'skill.md': SKILL_MD }, 'folder')
    expect(parsed.name).toBe('my-skill')
    expect(Object.keys(parsed.skillFiles)).toEqual(['SKILL.md'])
  })

  it('unwraps a wrapping folder before looking for the entry file', () => {
    const parsed = parseSkillFiles({ 'my-skill/SKILL.md': SKILL_MD }, 'my-skill')
    expect(parsed.skillFiles).toEqual({ 'SKILL.md': SKILL_MD })
  })

  it('never ships macOS metadata into the skill', () => {
    const parsed = parseSkillFiles({
      'SKILL.md': SKILL_MD,
      '.DS_Store': 'binary junk',
      '._SKILL.md': 'binary junk',
      'references/.DS_Store': 'binary junk',
      'references/guide.md': 'a guide',
    }, 'my-skill')
    expect(Object.keys(parsed.skillFiles).sort()).toEqual(['SKILL.md', 'references/guide.md'])
  })

  it('keeps Halo metadata riding alongside the skill', () => {
    const parsed = parseSkillFiles({
      'SKILL.md': SKILL_MD,
      'index.js': 'export default 1',
      'spec.yaml': 'type: skill',
    }, 'my-skill')
    expect(Object.keys(parsed.skillFiles).sort()).toEqual(['SKILL.md', 'index.js', 'spec.yaml'])
  })

  it('reads the description from the frontmatter', () => {
    expect(parseSkillFiles({ 'SKILL.md': SKILL_MD }, 'folder').description).toBe('Does a thing.')
  })

  it('falls back to the folder name when frontmatter carries none', () => {
    expect(parseSkillFiles({ 'SKILL.md': '# No frontmatter' }, 'My Folder').name).toBe('my-folder')
  })

  it('rejects a tree with no entry file', () => {
    expect(() => parseSkillFiles({ 'readme.md': 'a' }, 'folder')).toThrow(/SKILL\.md not found/)
  })
})
