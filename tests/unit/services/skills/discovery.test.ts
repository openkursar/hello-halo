import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverPersonalSkills, parseSkillMetadata } from '../../../../src/main/services/skills/discovery'
import { resolveSkillGroups } from '../../../../src/main/apps/skills/catalog'
import type { SkillCopy } from '../../../../src/shared/types/skills'

const denied = vi.hoisted(() => ({ path: '' }))
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, realpathSync: (path: string) => {
    if (denied.path && String(path).startsWith(denied.path)) throw Object.assign(new Error('denied'), { code: 'EACCES' })
    return actual.realpathSync(path)
  } }
})
const home = vi.hoisted(() => ({ path: '' }))
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => home.path }))
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'skills-discovery-')); home.path = join(root, 'home'); mkdirSync(home.path) })
afterEach(() => { denied.path = ''; rmSync(root, { recursive: true, force: true }) })

function write(rootPath: string, relative: string, content: string) {
  const path = join(rootPath, relative)
  mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, content)
  return path
}

function copy(id: string, scope: 'global' | 'space', source: SkillCopy['source'], enabled = true): SkillCopy {
  return { id, name: 'weekly', displayName: 'Weekly', description: 'Report', path: id, scope,
    spaceId: scope === 'space' ? 'a' : null, source, owners: [], enabled,
    availability: enabled ? 'available' : 'disabled', revision: '', editable: true, isLink: false }
}

describe('skill discovery and effective copies', () => {
  it('discovers only the selected project and global conventional roots, including legacy commands', () => {
    const project = join(root, 'a')
    write(project, '.agents/skills/weekly/SKILL.md', '---\nname: weekly\ndescription: Current report\n---\nCurrent')
    write(home.path, '.claude/commands/global.md', 'Legacy command body')
    write(join(root, 'b'), '.agents/skills/other/SKILL.md', 'Other project')
    const result = discoverPersonalSkills(project)
    expect(result.skills.map(skill => skill.name).sort()).toEqual(['global', 'weekly'])
    expect(result.warnings).toEqual([])
  })

  it('rechecks a changed file even when its parent directory did not change', () => {
    const path = write(root, '.agents/skills/weekly/SKILL.md', '---\ndescription: Old\n---\nBody')
    expect(discoverPersonalSkills(root).skills[0].description).toBe('Old')
    writeFileSync(path, '---\ndescription: New and longer\n---\nBody')
    expect(discoverPersonalSkills(root).skills[0].description).toBe('New and longer')
  })

  it('deduplicates a project directory alias without modifying it', () => {
    write(root, '.agents/skills/weekly/SKILL.md', 'Weekly content')
    mkdirSync(join(root, '.claude'), { recursive: true })
    symlinkSync(join(root, '.agents/skills'), join(root, '.claude/skills'), 'dir')
    expect(discoverPersonalSkills(root).skills).toHaveLength(1)
  })

  it('isolates a root that cannot be canonicalized', () => {
    write(root, '.claude/skills/healthy.md', 'Healthy')
    denied.path = join(root, '.agents')
    const result = discoverPersonalSkills(root)
    expect(result.skills.map(skill => skill.name)).toContain('healthy')
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('does not canonicalize a denied entry again while reporting it', () => {
    write(root, '.agents/skills/blocked/SKILL.md', 'Blocked')
    write(root, '.agents/skills/healthy.md', 'Healthy')
    denied.path = join(root, '.agents/skills/blocked')
    const result = discoverPersonalSkills(root)
    expect(result.skills.find(skill => skill.name === 'healthy')).toBeDefined()
    expect(result.skills.find(skill => skill.name === 'blocked')?.error).toContain('cannot be read')
  })

  it('keeps a shared global root globally scoped when the project aliases it', () => {
    write(home.path, '.agents/skills/shared/SKILL.md', 'Shared')
    mkdirSync(join(root, '.agents'), { recursive: true })
    symlinkSync(join(home.path, '.agents/skills'), join(root, '.agents/skills'), 'dir')
    const result = discoverPersonalSkills(root)
    expect(result.skills).toHaveLength(1)
    expect(result.skills[0].scope).toBe('global')
    expect(result.skills[0].filePath).toBe(join(home.path, '.agents/skills/shared/SKILL.md'))
  })

  it('keeps legacy body-only skills and reports malformed headers', () => {
    expect(parseSkillMetadata('# Weekly\nBody-only content', 'weekly')).toMatchObject({ name: 'weekly', description: 'Body-only content' })
    expect(parseSkillMetadata('---\nname: [\n---\nBody', 'weekly').error).toContain('YAML')
  })

  it('applies scope before origin and falls back when a copy is disabled', () => {
    const personal = copy('global', 'global', 'personal')
    const installed = copy('space', 'space', 'builtin')
    expect(resolveSkillGroups([personal, installed])[0].effectiveId).toBe('space')
    expect(resolveSkillGroups([copy('global', 'global', 'personal'), copy('space', 'space', 'builtin', false)])[0].effectiveId).toBe('global')
  })

  it('personal wins within a scope; equal priority conflicts load neither copy', () => {
    expect(resolveSkillGroups([copy('own', 'space', 'personal'), copy('store', 'space', 'store')])[0].effectiveId).toBe('own')
    const conflict = resolveSkillGroups([copy('one', 'space', 'personal'), copy('two', 'space', 'personal')])[0]
    expect(conflict.conflict).toBe(true)
    expect(conflict.effectiveId).toBeUndefined()
    expect(conflict.copies.every(item => item.availability === 'conflict')).toBe(true)
  })
})
