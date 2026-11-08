import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linkSkillsForClaudeCode } from '../../../../src/main/services/agent/engine-skill-links'
import type { SkillCatalogEntry } from '../../../../src/shared/types/skills'

describe('Claude Code skill link directory', () => {
  let base: string
  let views: string

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'halo-skill-links-'))
    views = join(base, 'views')
  })
  afterEach(() => { rmSync(base, { recursive: true, force: true }); vi.restoreAllMocks() })

  function folderSkill(name: string): SkillCatalogEntry {
    const dir = join(base, 'skills', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name}\n---\n`)
    return { name, description: name, source: { kind: 'file', path: join(dir, 'SKILL.md') } }
  }
  function flatCommand(name: string): SkillCatalogEntry {
    const file = join(base, 'commands', `${name}.md`)
    mkdirSync(join(base, 'commands'), { recursive: true })
    writeFileSync(file, `Instructions for ${name}\n`)
    return { name, description: name, source: { kind: 'file', path: file } }
  }

  it('links folder skills as skills and single files as commands, pointing at the real files', () => {
    const report = folderSkill('report')
    const note = flatCommand('note')
    const view = linkSkillsForClaudeCode([report, note], views)!
    expect(readdirSync(join(view, '.claude', 'skills'))).toEqual(['report'])
    expect(readdirSync(join(view, '.claude', 'commands'))).toEqual(['note.md'])
    expect(realpathSync(join(view, '.claude', 'skills', 'report'))).toBe(realpathSync(join(base, 'skills', 'report')))
    expect(readFileSync(join(view, '.claude', 'skills', 'report', 'SKILL.md'), 'utf8')).toContain('name: report')
    expect(readFileSync(join(view, '.claude', 'commands', 'note.md'), 'utf8')).toBe('Instructions for note\n')
  })

  it('follows later edits because it links instead of copying folders', () => {
    const report = folderSkill('report')
    const view = linkSkillsForClaudeCode([report], views)!
    writeFileSync(report.source.path, 'edited')
    expect(readFileSync(join(view, '.claude', 'skills', 'report', 'SKILL.md'), 'utf8')).toBe('edited')
  })

  it('reuses one directory for the same skills and builds another when they change', () => {
    const report = folderSkill('report')
    const first = linkSkillsForClaudeCode([report], views)!
    expect(linkSkillsForClaudeCode([report], views)).toBe(first)
    const second = linkSkillsForClaudeCode([report, folderSkill('plan')], views)!
    expect(second).not.toBe(first)
    expect(readdirSync(join(second, '.claude', 'skills')).sort()).toEqual(['plan', 'report'])
    expect(readdirSync(views).filter(name => name.startsWith('.building-'))).toEqual([])
  })

  it('does not depend on the order of the catalog', () => {
    const entries = [folderSkill('b'), folderSkill('a'), flatCommand('c')]
    expect(linkSkillsForClaudeCode([...entries].reverse(), views)).toBe(linkSkillsForClaudeCode(entries, views))
  })

  it('removes views no session used for two weeks at the first use of a run, and keeps recent ones', async () => {
    const old = linkSkillsForClaudeCode([folderSkill('old')], views)!
    const recent = linkSkillsForClaudeCode([folderSkill('recent')], views)!
    const longAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000)
    utimesSync(old, longAgo, longAgo)
    vi.resetModules()
    const nextRun = await import('../../../../src/main/services/agent/engine-skill-links')
    nextRun.linkSkillsForClaudeCode([folderSkill('new')], views)
    expect(() => lstatSync(old)).toThrow()
    expect(lstatSync(recent).isDirectory()).toBe(true)
  })

  it('prunes only once per run, so a view handed out earlier in the run stays even when it ages', () => {
    const inUse = linkSkillsForClaudeCode([folderSkill('in-use')], views)!
    const longAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000)
    utimesSync(inUse, longAgo, longAgo)
    linkSkillsForClaudeCode([folderSkill('another')], views)
    expect(lstatSync(inUse).isDirectory()).toBe(true)
  })

  it('copies single-file commands where links are unavailable, and tells copies apart by their version', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const note = flatCommand('note')
      const report = folderSkill('report')
      const first = linkSkillsForClaudeCode([note, report], views)!
      expect(lstatSync(join(first, '.claude', 'commands', 'note.md')).isSymbolicLink()).toBe(false)
      expect(lstatSync(join(first, '.claude', 'skills', 'report')).isSymbolicLink()).toBe(true)
      writeFileSync(note.source.path, 'newer instructions')
      const later = new Date(Date.now() + 5000)
      utimesSync(note.source.path, later, later)
      const second = linkSkillsForClaudeCode([note, report], views)!
      expect(second).not.toBe(first)
      expect(readFileSync(join(second, '.claude', 'commands', 'note.md'), 'utf8')).toBe('newer instructions')
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('has nothing to link for an empty set or for names that cannot be file names', () => {
    expect(linkSkillsForClaudeCode([], views)).toBeUndefined()
    const bad: SkillCatalogEntry = { name: '../escape', description: '', source: { kind: 'file', path: join(base, 'x', 'SKILL.md') } }
    expect(linkSkillsForClaudeCode([bad], views)).toBeUndefined()
    expect(() => lstatSync(views)).toThrow()
  })

  it('degrades to no extra directory, with one warning, when the directory cannot be built', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const blocker = join(base, 'blocker')
    writeFileSync(blocker, 'a file where the directory should go')
    expect(linkSkillsForClaudeCode([folderSkill('report')], join(blocker, 'views'))).toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })
})
