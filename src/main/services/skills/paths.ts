import { homedir } from 'node:os'
import { join, basename, resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { SkillSpec } from '../../../shared/apps/spec-types'
import type { SkillSource } from '../../../shared/types/skills'

export function classifySkillSource(spec: SkillSpec): SkillSource {
  if (spec.store?.slug?.startsWith('halo-builtin-skills/') || spec.store?.install_source === 'builtin') return 'builtin'
  if (spec.store?.install_source === 'bundled') return 'digital-human'
  if (spec.store?.install_source === 'manual' || (!spec.store?.slug && !spec.store?.install_source)) return 'personal'
  return 'store'
}

export function skillSourceIdentity(spec: SkillSpec): string {
  const source = classifySkillSource(spec)
  return JSON.stringify(source === 'personal' ? [source] : [source, spec.store?.slug ?? null, spec.store?.registry_id ?? null, spec.store?.repository ?? null])
}

export function sameSkillSource(left: SkillSpec, right: SkillSpec): boolean {
  return skillSourceIdentity(left) === skillSourceIdentity(right)
}

export function validateSkillName(name: string): string {
  const value = name.trim()
  if (!value || value.length > 128 || value === '.' || value === '..' || /[\\/\u0000-\u001f<>:"|?*]/.test(value) || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new Error('The skill name is not a valid file name.')
  }
  return value
}

export function personalSkillPath(workDir: string | null, name: string): string {
  return join(workDir ?? homedir(), '.agents', 'skills', validateSkillName(name), 'SKILL.md')
}

export function managedSkillPath(haloDir: string, spaceDataPath: string | null, appId: string): string {
  return join(spaceDataPath ? join(spaceDataPath, '.halo') : haloDir, 'skills', validateSkillName(appId), 'SKILL.md')
}

export function skillSearchRoots(workDir: string | null): Array<{ path: string; scope: 'global' | 'space' }> {
  const roots: Array<{ path: string; scope: 'global' | 'space' }> = []
  for (const [root, scope] of [[workDir, 'space'], [homedir(), 'global']] as const) {
    if (!root) continue
    for (const agentDir of ['.agents', '.claude']) {
      for (const leaf of ['skills', 'commands']) roots.push({ path: join(root, agentDir, leaf), scope })
    }
  }
  return roots
}

export function canonicalSkillPath(filePath: string): string {
  try { return realpathSync(filePath) }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    return resolve(filePath)
  }
}

export function skillFileId(filePath: string): string {
  return `file:${createHash('sha256').update(canonicalSkillPath(filePath)).digest('hex')}`
}

export function skillDirectoryName(filePath: string): string {
  return basename(filePath) === 'SKILL.md' ? basename(resolve(filePath, '..')) : basename(filePath, '.md')
}
