/**
 * apps/manager -- Skill Filesystem Sync
 *
 * Synchronizes Skill app records from the database to filesystem `.md` files
 * so that the Claude Code SDK auto-loads them.
 *
 * Paths:
 *   - Global skills:      $CLAUDE_CONFIG_DIR/skills/<specId>/SKILL.md
 *   - Space-scoped skills: <spacePath>/.claude/skills/<specId>/SKILL.md
 *
 * This module is called by the service layer on install/uninstall/reinstall/delete.
 */

import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join, resolve, dirname, normalize, sep } from 'path'
import { app } from 'electron'
import type { InstalledApp } from './types'
import type { SkillSpec } from '../../apps/spec/schema'
import { resolveClaudeConfigDir } from '../../foundation/config.service'
import { normalizeSkillMd, alignSkillMdName } from '../../../shared/skill-frontmatter'
import { toSkillDirName } from '../../../shared/skill-naming'

/**
 * Resolve the global skills directory without touching the disk.
 *
 * Must follow the user's configDirMode setting: the SDK loads global skills
 * from resolveClaudeConfigDir()/skills, so writing anywhere else (e.g. a
 * fixed userData path) produces skills the agent never sees.
 */
export function resolveGlobalSkillsDir(): string {
  return join(resolveClaudeConfigDir(), 'skills')
}

/**
 * Get the global Claude config skills directory.
 * Creates it if it doesn't exist.
 */
function getGlobalSkillsDir(): string {
  const skillsDir = resolveGlobalSkillsDir()
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true })
  }
  return skillsDir
}

/**
 * Get the space-scoped skills directory.
 * Creates it if it doesn't exist.
 */
function getSpaceSkillsDir(spacePath: string): string {
  const skillsDir = join(spacePath, '.claude', 'skills')
  if (!existsSync(skillsDir)) {
    mkdirSync(skillsDir, { recursive: true })
  }
  return skillsDir
}

/**
 * Resolve the on-disk directory for a skill app without performing any I/O.
 * Returns null if the space cannot be resolved.
 *
 * Used by IPC handlers that need to open the folder in the OS file manager.
 */
export function getSkillDir(
  appRecord: InstalledApp,
  getSpacePath: (spaceId: string) => string | null
): string | null {
  if (appRecord.spec.type !== 'skill') return null

  const dirName = toSkillDirName(appRecord.specId)

  if (appRecord.spaceId === null) {
    return join(getGlobalSkillsDir(), dirName)
  }

  const spacePath = getSpacePath(appRecord.spaceId)
  if (!spacePath) return null
  return join(getSpaceSkillsDir(spacePath), dirName)
}

/**
 * Write a skill's content to the appropriate filesystem location.
 * Called on install/reinstall of a skill app.
 */
export function syncSkillToFilesystem(
  appRecord: InstalledApp,
  getSpacePath: (spaceId: string) => string | null
): void {
  if (appRecord.spec.type !== 'skill') return

  const spec = appRecord.spec as SkillSpec

  // skill_files takes priority (registry installs); fall back to skill_content (manual add)
  const skillFiles: Record<string, string> = spec.skill_files
    ?? (spec.skill_content ? { 'SKILL.md': spec.skill_content } : {})

  if (Object.keys(skillFiles).length === 0) {
    console.warn(`[SkillSync] Skill '${appRecord.specId}' has no skill_files or skill_content, skipping filesystem sync`)
    return
  }

  const dirName = toSkillDirName(appRecord.specId)

  const skillDir = appRecord.spaceId === null
    ? join(getGlobalSkillsDir(), dirName)
    : (() => {
        const spacePath = getSpacePath(appRecord.spaceId)
        if (!spacePath) {
          console.warn(`[SkillSync] Space '${appRecord.spaceId}' not found, skipping filesystem sync`)
          return null
        }
        return join(getSpaceSkillsDir(spacePath), dirName)
      })()

  if (!skillDir) return

  mkdirSync(skillDir, { recursive: true })
  const resolvedSkillDir = resolve(skillDir)

  for (const [filename, content] of Object.entries(skillFiles)) {
    // normalize() collapses ".." segments; the startsWith guard below
    // rejects any path that still escapes the skill directory.
    const target = resolve(skillDir, normalize(filename))
    if (!target.startsWith(resolvedSkillDir + sep) && target !== resolvedSkillDir) {
      console.warn(`[SkillSync] Skipping unsafe path "${filename}" for skill '${appRecord.specId}'`)
      continue
    }
    // Create intermediate subdirectories (e.g. "references/INDEX.md" → mkdir references/)
    const targetDir = dirname(target)
    if (targetDir !== resolvedSkillDir) {
      mkdirSync(targetDir, { recursive: true })
    }
    // Normalize SKILL.md frontmatter for CC SDK compatibility before writing.
    // Other files are written as-is.
    const fileContent = filename === 'SKILL.md'
      ? alignSkillMdName(normalizeSkillMd(content), spec)
      : content
    writeFileSync(target, fileContent, 'utf-8')
  }

  const scope = appRecord.spaceId === null ? 'global' : 'space'
  console.log(`[SkillSync] Written ${scope} skill: ${skillDir}/ (${Object.keys(skillFiles).length} files)`)
}

/**
 * Remove a skill's file from the filesystem.
 * Called on uninstall/delete of a skill app.
 */
export function removeSkillFromFilesystem(
  appRecord: InstalledApp,
  getSpacePath: (spaceId: string) => string | null
): void {
  if (appRecord.spec.type !== 'skill') return

  const dirName = toSkillDirName(appRecord.specId)

  if (appRecord.spaceId === null) {
    // Global skill
    const skillDir = join(getGlobalSkillsDir(), dirName)
    if (existsSync(skillDir)) {
      rmSync(skillDir, { recursive: true, force: true })
      console.log(`[SkillSync] Removed global skill: ${skillDir}`)
    }
  } else {
    // Space-scoped skill
    const spacePath = getSpacePath(appRecord.spaceId)
    if (!spacePath) return
    const skillDir = join(getSpaceSkillsDir(spacePath), dirName)
    if (existsSync(skillDir)) {
      rmSync(skillDir, { recursive: true, force: true })
      console.log(`[SkillSync] Removed space skill: ${skillDir}`)
    }
  }
}

/**
 * Move installed global skills to the directory the SDK actually reads.
 *
 * Earlier versions always wrote global skills to the fixed
 * userData/claude-config/skills path, so under 'cc'/'custom' configDirMode
 * they landed where the SDK never looks. Re-writes each installed global
 * skill from its DB record (source of truth) into the resolved directory and
 * removes the stale copy from the legacy path. No-op in the default mode
 * where both paths coincide. Called once at App Manager startup.
 */
export function reconcileGlobalSkillsLocation(
  apps: InstalledApp[],
  getSpacePath: (spaceId: string) => string | null
): void {
  const legacyDir = join(app.getPath('userData'), 'claude-config', 'skills')
  const resolvedDir = resolveGlobalSkillsDir()
  if (resolve(resolvedDir) === resolve(legacyDir)) return

  let migrated = 0
  for (const record of apps) {
    if (record.spec.type !== 'skill' || record.spaceId !== null) continue
    if (record.status === 'uninstalled') continue

    syncSkillToFilesystem(record, getSpacePath)

    const staleDir = join(legacyDir, toSkillDirName(record.specId))
    if (existsSync(staleDir)) {
      rmSync(staleDir, { recursive: true, force: true })
      migrated++
    }
  }

  if (migrated > 0) {
    console.log(`[SkillSync] Relocated ${migrated} global skills from legacy dir to ${resolvedDir}`)
  }
}
