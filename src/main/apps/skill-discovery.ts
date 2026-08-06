/**
 * apps/skill-discovery
 *
 * Enumerates the skills a digital human can actually load at runtime by
 * scanning the exact directories the Claude Code SDK reads (see
 * services/agent/sdk-config.ts: settingSources ['user','project']):
 *
 *   - Global (user):   $CLAUDE_CONFIG_DIR/skills/<name>/SKILL.md
 *   - Space (project): <workDir>/.claude/skills/<name>/SKILL.md
 *
 * where workDir is the digital human's space working directory (the agent cwd).
 *
 * This is deliberately disk-based, not DB-based: global skills and manually
 * placed skills frequently have no installed-apps record, and space skills are
 * bound to a space's working dir — so filtering the app table would show an
 * empty or wrong list. The disk is the runtime source of truth.
 */

import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { resolveGlobalSkillsDir } from './manager/skill-sync'
import { getWorkingDir } from '../services/agent/helpers'
import { extractFrontmatterField } from '../../shared/skill-frontmatter'
import type { AvailableSkill } from '../../shared/apps/app-types'

/** Cap per-skill content to keep the response light for large skill sets. */
const MAX_CONTENT_CHARS = 20000

function scanSkillsDir(dir: string, scope: 'global' | 'space'): AvailableSkill[] {
  if (!existsSync(dir)) return []

  const results: AvailableSkill[] = []
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (err) {
    console.warn(`[SkillDiscovery] Failed to read ${dir}:`, (err as Error).message)
    return []
  }

  for (const entry of entries) {
    // Symlinked skill dirs load fine in the SDK; the SKILL.md check below
    // filters out symlinks that don't point at a skill directory.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const skillDir = join(dir, entry.name)
    const mdPath = join(skillDir, 'SKILL.md')
    if (!existsSync(mdPath)) continue

    let content = ''
    try {
      content = readFileSync(mdPath, 'utf-8')
    } catch {
      continue
    }

    const name = extractFrontmatterField(content, 'name') || entry.name
    const description = extractFrontmatterField(content, 'description') || ''
    results.push({
      name,
      description,
      scope,
      dirName: entry.name,
      path: skillDir,
      content: content.length > MAX_CONTENT_CHARS ? content.slice(0, MAX_CONTENT_CHARS) : content,
    })
  }

  return results
}

/**
 * List the skills a digital human in the given space can load at runtime.
 * Space-scoped skills override global ones sharing the same directory name
 * (project settings win over user settings), matching SDK resolution.
 */
export function listAvailableSkills(spaceId: string): AvailableSkill[] {
  const globalDir = resolveGlobalSkillsDir()
  const spaceDir = join(getWorkingDir(spaceId), '.claude', 'skills')

  const globalSkills = scanSkillsDir(globalDir, 'global')
  const spaceSkills = scanSkillsDir(spaceDir, 'space')

  const spaceNames = new Set(spaceSkills.map(s => s.dirName))
  const merged = [
    ...spaceSkills,
    ...globalSkills.filter(s => !spaceNames.has(s.dirName)),
  ]
  merged.sort((a, b) => a.name.localeCompare(b.name))

  console.log(
    `[SkillDiscovery] space=${spaceId}: ${spaceSkills.length} space + ` +
    `${globalSkills.length} global → ${merged.length} available`
  )
  return merged
}
