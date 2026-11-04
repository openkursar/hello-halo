import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { dirname } from 'node:path'
import { getSkillLibrary } from './skills'
import type { AvailableSkill } from '../../shared/apps/app-types'

function readInstructions(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('The skill instructions cannot be read safely.')
    const buffer = Buffer.alloc(Math.min(info.size, 20000))
    const count = readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.toString('utf8', 0, count)
  } finally { closeSync(fd) }
}

function availableCopies(spaceId: string, effectiveOnly: boolean, workDir?: string): AvailableSkill[] {
  const library = getSkillLibrary()
  const results: AvailableSkill[] = []
  for (const copy of library.runtimeCopies(spaceId, workDir)) {
    if (!copy.enabled || copy.availability === 'missing' || copy.availability === 'invalid' || (effectiveOnly && copy.availability !== 'available')) continue
    try {
      results.push({ name: copy.name, description: copy.description, scope: copy.scope,
        dirName: copy.name, path: dirname(copy.path), content: readInstructions(copy.path) })
    } catch (error) {
      console.warn('[Skills] Available skill could not be inspected', { id: copy.id, reason: (error as Error).message })
    }
  }
  return results
}

export function listAvailableSkills(spaceId: string): AvailableSkill[] {
  return availableCopies(spaceId, true)
}

/** Permission checks conservatively consider every enabled copy an external engine could discover. */
export function listLoadableSkillCopies(spaceId: string, workDir?: string): AvailableSkill[] {
  return availableCopies(spaceId, false, workDir)
}
