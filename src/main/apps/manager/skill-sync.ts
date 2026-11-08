import { dirname } from 'path'
import type { InstalledApp } from './types'

/** Legacy callers may reveal only an explicitly recorded location, never a guessed name. */
export function getSkillDir(
  appRecord: InstalledApp,
  _getSpacePath: (spaceId: string) => string | null,
): string | null {
  return appRecord.spec.type === 'skill' && appRecord.userOverrides.skill?.filePath
    ? dirname(appRecord.userOverrides.skill.filePath) : null
}
