import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface SkillPreference {
  version: 1
  enabled?: boolean
  displayName?: string
  requestId?: string
}

function preferencePath(root: string, identity: string): string {
  const key = createHash('sha256').update(identity).digest('hex')
  return join(root, 'skill-settings', `${key}.json`)
}

export function readSkillPreference(root: string, identity: string): SkillPreference {
  const path = preferencePath(root, identity)
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    if (fstatSync(fd).size > 16 * 1024) throw new Error('Skill preference record is too large.')
    const parsed = JSON.parse(readFileSync(fd, 'utf8')) as SkillPreference
    if (parsed.version !== 1 || (parsed.enabled !== undefined && typeof parsed.enabled !== 'boolean')) throw new Error('Unsupported skill preference record.')
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 }
    console.warn('[Skills] Skill preference could not be read; keeping it unavailable', { reason: (error as Error).message })
    throw error
  } finally { if (fd !== undefined) closeSync(fd) }
}

export function writeSkillPreference(root: string, identity: string, value: SkillPreference): void {
  const path = preferencePath(root, identity)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) rmSync(temporary)
  }
}

export function removeSkillPreference(root: string, identity: string): void {
  rmSync(preferencePath(root, identity), { force: true })
}
