import { lstatSync } from 'fs'
import { dirname, join } from 'path'
import type { InstalledApp } from './types'
import { getHaloDir } from '../../foundation/config.service'
import { classifySkillSource, writeSkillPackage } from '../../services/skills'
import { skillPackage } from './skill-lifecycle'

export function resolveGlobalSkillsDir(): string {
  return join(getHaloDir(), 'skills')
}

/** Legacy callers may reveal only an explicitly recorded location, never a guessed name. */
export function getSkillDir(
  appRecord: InstalledApp,
  _getSpacePath: (spaceId: string) => string | null,
): string | null {
  return appRecord.spec.type === 'skill' && appRecord.userOverrides.skill?.filePath
    ? dirname(appRecord.userOverrides.skill.filePath) : null
}

/** Compatibility repair for missing managed packages; personal files are never restored from SQLite. */
export function syncSkillToFilesystem(
  appRecord: InstalledApp,
  _getSpacePath: (spaceId: string) => string | null,
): void {
  if (appRecord.spec.type !== 'skill') return
  const state = appRecord.userOverrides.skill
  if (!state || state.deleted || appRecord.status === 'uninstalled'
    || state.customized || classifySkillSource(appRecord.spec) === 'personal') {
    console.warn('[SkillSync] Skipped automatic write; skill authority does not permit repair', { appId: appRecord.id })
    return
  }
  try {
    lstatSync(state.filePath)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const pkg = skillPackage(appRecord.spec)
  writeSkillPackage(state.filePath, pkg.files, pkg.assets)
}

/** Scope-bounded apps/skills migration replaces the old startup rewrite. */
export function reconcileGlobalSkillsLocation(
  _apps: InstalledApp[],
  _getSpacePath: (spaceId: string) => string | null,
): void {
  console.warn('[SkillSync] Legacy startup relocation is disabled; use scope-bounded skill migration')
}
