/**
 * Where Halo's installed skills live on disk.
 *
 * `apps/manager/skill-sync.ts` writes a skill to one of two roots — the shared
 * config directory for a global skill, the space for a space-scoped one — and
 * the default engine reads them back implicitly, by way of the Claude Code
 * SDK's own `settingSources` discovery. An engine that runs in a child process
 * has no such discovery: it has to be told the paths.
 *
 * Naming them here rather than in each adapter keeps the layout a single fact.
 * The alternative is every new engine re-deriving `.claude/skills`, which is
 * exactly the kind of duplicated convention that stops being true after the
 * first change to it.
 */

import path from 'path'
import { resolveClaudeConfigDir } from '../../foundation/config.service'

/**
 * The skill roots for a session working in `workDir`, outermost first.
 *
 * The global root follows the user's configured config-directory mode, so an
 * engine reading these agrees with what the default engine loads. Neither path
 * is created here — a root that does not exist yet is a root with no skills,
 * which every consumer already handles.
 */
export function getSkillRoots(workDir: string): string[] {
  return [path.join(resolveClaudeConfigDir(), 'skills'), path.join(workDir, '.claude', 'skills')]
}
