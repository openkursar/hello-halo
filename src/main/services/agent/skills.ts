/**
 * The skill folders an engine that is handed explicit paths should read.
 *
 * Skills of every origin live in the user's own `.agents/skills` (global and per workspace);
 * older `.claude/skills` folders are still honored. An engine that runs in a child process
 * has no discovery of its own and has to be told the paths. Naming them here rather than in
 * each adapter keeps the layout a single fact.
 */

import path from 'path'
import { resolveClaudeConfigDir } from '../../foundation/config.service'
import { skillSearchRoots } from '../skills'

/**
 * The skill roots for a session working in `workDir`, outermost first.
 * None is created here: a root that does not exist yet is a root with no skills,
 * which every consumer already handles.
 */
export function getSkillRoots(workDir: string): string[] {
  const roots = skillSearchRoots(workDir).filter(root => path.basename(root.path) === 'skills')
  const global = roots.filter(root => root.scope === 'global').map(root => root.path)
  const space = roots.filter(root => root.scope === 'space').map(root => root.path)
  return [...new Set([...global, path.join(resolveClaudeConfigDir(), 'skills'), ...space].map(root => path.resolve(root)))]
}
