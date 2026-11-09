import { closeSync, fstatSync, lstatSync, openSync, readSync, opendirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { parseDocument, isMap } from 'yaml'
import { createStampedLru } from '../../platform/file-cache'
import { canonicalSkillPath, skillDirectoryName, skillFileId, skillSearchRoots } from './paths'

const MAX_SKILLS = 2000
const METADATA_LIMIT = 16 * 1024
const metadata = createStampedLru<SkillMetadata>({ maxEntries: 1000, maxWeight: 4 * 1024 * 1024 })

export interface SkillMetadata {
  name: string
  description: string
  argumentHint?: string
  whenToUse?: string
  executionContext?: string
  error?: string
}

export interface DiscoveredSkill extends SkillMetadata {
  id: string
  filePath: string
  canonicalPath: string
  scope: 'global' | 'space'
  isLink: boolean
}

export function parseSkillMetadata(content: string, fallbackName: string): SkillMetadata {
  const match = /^\uFEFF?---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)/.exec(content)
  let fields: Record<string, string> = {}
  if (match) {
    const doc = parseDocument(match[1], { schema: 'failsafe', logLevel: 'silent' })
    if (doc.errors.length || !isMap(doc.contents)) return { name: fallbackName, description: '', error: 'The skill header is not valid YAML.' }
    fields = Object.fromEntries(['name', 'description', 'argument-hint', 'whenToUse', 'context'].flatMap(key => {
      const value = doc.get(key)
      return typeof value === 'string' ? [[key, value.trim()]] : []
    }))
  } else if (/^\uFEFF?---[^\S\r\n]*\r?\n/.test(content)) {
    return { name: fallbackName, description: '', error: 'The skill header is incomplete or too large.' }
  }
  const name = (fields.name || fallbackName).trim().replace(/(?:\.md)+$/, '')
  const body = match ? content.slice(match[0].length) : content
  const description = fields.description || body.split(/\r?\n/).find(line => line.trim() && !line.trim().startsWith('#'))?.trim() || ''
  const error = !name || name.length > 128 || name.toLowerCase() === 'list' || /[\\/\u0000-\u001f<>"&]/.test(name)
    ? 'The skill name is invalid or reserved.' : undefined
  return { name, description, argumentHint: fields['argument-hint'], whenToUse: fields.whenToUse,
    ...(fields.context ? { executionContext: fields.context } : {}), ...(error ? { error } : {}) }
}

export function readSkillMetadata(filePath: string): SkillMetadata {
  const value = metadata.get(filePath, () => {
    const fd = openSync(filePath, 'r')
    try {
      const info = fstatSync(fd)
      if (!info.isFile()) throw new Error('The skill source is not a regular file.')
      const bytes = Buffer.alloc(Math.min(info.size, METADATA_LIMIT))
      const length = readSync(fd, bytes, 0, bytes.length, 0)
      return parseSkillMetadata(bytes.toString('utf8', 0, length), skillDirectoryName(filePath))
    } finally { closeSync(fd) }
  })
  if (!value) throw new Error('The skill file is missing or cannot be read.')
  return value
}

export function inspectSkill(filePath: string, scope: 'global' | 'space'): DiscoveredSkill {
  const source = readSkillMetadata(filePath)
  return {
    ...source,
    id: skillFileId(filePath),
    filePath,
    canonicalPath: canonicalSkillPath(filePath),
    scope,
    isLink: lstatSync(filePath).isSymbolicLink() || (basename(filePath) === 'SKILL.md' && lstatSync(dirname(filePath)).isSymbolicLink()),
  }
}

export function discoverPersonalSkills(workDir: string | null, additionalRoots: string[] = []): { skills: DiscoveredSkill[]; warnings: string[]; truncated: boolean } {
  const skills: DiscoveredSkill[] = []
  const warnings: string[] = []
  const seen = new Set<string>()
  let truncated = false
  const roots = [...skillSearchRoots(workDir), ...additionalRoots.map(path => ({ path, scope: 'global' as const }))]
    .sort((a, b) => Number(a.scope === 'space') - Number(b.scope === 'space'))
  const seenRoots = new Set<string>()
  for (const root of roots) {
    let entries: ReturnType<typeof opendirSync>
    try {
      const identity = canonicalSkillPath(root.path)
      if (seenRoots.has(identity)) continue
      seenRoots.add(identity)
      entries = opendirSync(root.path)
    }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
      console.warn('[Skills] Skill root could not be read', { root: root.path, reason: (error as Error).message })
      warnings.push(`Cannot read skill directory: ${root.path}`)
      continue
    }
    try {
    let entry: ReturnType<typeof entries.readSync>
    let inspected = 0
    while ((entry = entries.readSync()) !== null) {
      if (skills.length >= MAX_SKILLS || inspected++ >= MAX_SKILLS) { truncated = true; break }
      const candidate = join(root.path, entry.name)
      let filePath: string
      try {
        const info = statSync(candidate)
        if (info.isDirectory()) filePath = join(candidate, 'SKILL.md')
        else if (info.isFile() && entry.name.endsWith('.md') && entry.name !== 'SKILL.md') filePath = candidate
        else continue
        if (!statSync(filePath).isFile()) continue
        const item = inspectSkill(filePath, root.scope)
        if (seen.has(item.canonicalPath)) continue
        seen.add(item.canonicalPath)
        skills.push(item)
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
        console.warn('[Skills] Skill entry could not be read', { path: candidate, reason: (error as Error).message })
        const id = `file:${createHash('sha256').update(resolve(candidate)).digest('hex')}`
        skills.push({ id, filePath: candidate, canonicalPath: candidate, scope: root.scope, isLink: false, name: entry.name, description: '', error: 'The skill file cannot be read.' })
      }
    }
    } catch (error) {
      console.warn('[Skills] Skill directory scan could not finish', { root: root.path, reason: (error as Error).message })
      warnings.push(`Cannot finish reading skill directory: ${root.path}`)
    } finally { entries.closeSync() }
  }
  if (truncated) warnings.push(`Only the first ${MAX_SKILLS} skill files were inspected.`)
  return { skills, warnings, truncated }
}
