/**
 * Unit tests for skill command-name derivation and the schema-level
 * normalization that applies it.
 *
 * The invariant under test: a skill's `name` is what becomes its directory,
 * its SKILL.md frontmatter name and therefore its slash command, so it must
 * always be usable as an ASCII path segment — while the authored name survives
 * in `display_name`. Names that already round-trip must be left untouched, so
 * specs written before this rule keep their identity across an upgrade.
 */

import { describe, it, expect } from 'vitest'
import {
  deriveSkillCommandName,
  needsCommandNameDerivation,
} from '../../../../src/main/apps/spec/skill-identity'
import { AppSpecSchema } from '../../../../src/main/apps/spec/schema'
import { toSkillDirName } from '../../../../src/shared/skill-naming'

function skill(overrides: Record<string, unknown>) {
  return {
    name: 'placeholder',
    version: '1.0',
    description: 'A test skill',
    type: 'skill',
    skill_content: '---\nname: placeholder\ndescription: A test skill\n---\nBody',
    ...overrides,
  }
}

describe('needsCommandNameDerivation', () => {
  it('accepts names that already survive the directory sanitizer', () => {
    for (const name of ['code-commit', 'Code_Commit', 'Code Review', 'skill.v2', 'a1']) {
      expect(needsCommandNameDerivation(name)).toBe(false)
    }
  })

  it('flags any non-ASCII name', () => {
    for (const name of ['AI写作', '代码评审', 'резюме', 'スキル', '🚀']) {
      expect(needsCommandNameDerivation(name)).toBe(true)
    }
  })
})

describe('deriveSkillCommandName', () => {
  it('romanizes Chinese to pinyin', () => {
    expect(deriveSkillCommandName('代码评审')).toBe('dai-ma-ping-shen')
  })

  it('keeps ASCII runs intact when mixed with Chinese', () => {
    expect(deriveSkillCommandName('AI写作')).toBe('ai-xie-zuo')
  })

  it('always returns a usable directory segment', () => {
    for (const name of ['代码评审', 'AI写作', 'резюме', '🚀', 'Code Review']) {
      const derived = deriveSkillCommandName(name)
      expect(derived.length).toBeGreaterThan(0)
      expect(toSkillDirName(derived)).toBe(derived)
      expect(needsCommandNameDerivation(derived)).toBe(false)
    }
  })

  it('falls back to a stable digest when romanization yields nothing', () => {
    const first = deriveSkillCommandName('🚀')
    expect(first).toMatch(/^skill-[0-9a-f]{8}$/)
    expect(deriveSkillCommandName('🚀')).toBe(first)
    expect(deriveSkillCommandName('✨')).not.toBe(first)
  })

  it('caps length at a hyphen boundary', () => {
    const derived = deriveSkillCommandName('这是一个非常非常非常冗长的中文技能名称用来测试截断行为')
    expect(derived.length).toBeLessThanOrEqual(48)
    expect(derived.endsWith('-')).toBe(false)
  })
})

describe('AppSpecSchema skill identity normalization', () => {
  it('moves a non-ASCII name into display_name', () => {
    const parsed = AppSpecSchema.parse(skill({ name: 'AI写作' }))
    expect(parsed.name).toBe('ai-xie-zuo')
    expect(parsed.display_name).toBe('AI写作')
  })

  it('leaves an ASCII name and its absent display_name untouched', () => {
    const parsed = AppSpecSchema.parse(skill({ name: 'Code Review' }))
    expect(parsed.name).toBe('Code Review')
    expect(parsed.display_name).toBeUndefined()
  })

  it('is idempotent', () => {
    const once = AppSpecSchema.parse(skill({ name: '代码评审' }))
    const twice = AppSpecSchema.parse(once)
    expect(twice.name).toBe(once.name)
    expect(twice.display_name).toBe(once.display_name)
  })

  it('preserves an explicitly authored display_name', () => {
    const parsed = AppSpecSchema.parse(skill({ name: 'AI写作', display_name: 'Writing Assistant' }))
    expect(parsed.name).toBe('ai-xie-zuo')
    expect(parsed.display_name).toBe('Writing Assistant')
  })

  it('honours a command name the author already resolved', () => {
    const parsed = AppSpecSchema.parse(skill({ name: 'my-writer', display_name: 'AI写作' }))
    expect(parsed.name).toBe('my-writer')
    expect(parsed.display_name).toBe('AI写作')
  })

  it('does not touch non-skill types', () => {
    const parsed = AppSpecSchema.parse({
      name: '会议室预订数字人',
      version: '1.0',
      author: 'Test',
      description: 'An automation',
      type: 'automation',
      system_prompt: 'Do the thing',
    })
    expect(parsed.name).toBe('会议室预订数字人')
    expect(parsed.display_name).toBeUndefined()
  })
})
