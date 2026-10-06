/**
 * Removing a session the engine stored on disk.
 *
 * The CC-protocol engines (the default engine and the halo engine) keep each
 * session under `<config dir>/projects/<project dir>/`: `<session id>.jsonl`,
 * and a `<session id>/` folder for its sub-agents and large tool results. The
 * project dir is the working directory with every non-alphanumeric character
 * turned into '-' — as given for the halo engine, resolved and NFC-normalized
 * for the default engine. Past 200 characters the default engine cuts it and
 * appends a hash of the full path, so a long one is found by that prefix. Other
 * engines store sessions elsewhere and are not covered here.
 */

import { existsSync, readdirSync, realpathSync, rmSync } from 'fs'
import { join } from 'path'
import { resolveClaudeConfigDir } from '../../foundation/config.service'

const PROJECT_DIR_MAX_LENGTH = 200

/** Session ids name files below the project dir; anything else is refused. */
const SESSION_ID = /^[A-Za-z0-9_-]+$/

/**
 * Delete what the engine stored for `sessionId` when it ran in `workDir`, so a
 * session that will never be resumed stops taking disk. Missing files are fine.
 */
export function deleteStoredSession(workDir: string, sessionId: string, configDir = resolveClaudeConfigDir()): void {
  if (!workDir || !SESSION_ID.test(sessionId)) return
  const projects = join(configDir, 'projects')
  for (const dir of projectDirs(projects, workDir)) {
    rmSync(join(projects, dir, `${sessionId}.jsonl`), { force: true })
    rmSync(join(projects, dir, sessionId), { recursive: true, force: true })
  }
}

/** The project folders a session run in `workDir` may have been stored under. */
function projectDirs(projects: string, workDir: string): Set<string> {
  const paths = [workDir]
  try {
    paths.push(realpathSync(workDir))
  } catch {
    // Gone: the path as given is all there is to go on.
  }
  const names = new Set(paths.flatMap(path => [path, path.normalize('NFC')]).map(path => path.replace(/[^a-zA-Z0-9]/g, '-')))
  const dirs = new Set<string>()
  let listing: string[] | undefined
  for (const name of names) {
    if (name.length <= PROJECT_DIR_MAX_LENGTH) {
      dirs.add(name)
      continue
    }
    // Matched against what exists: uncut, a long name may exceed what the
    // filesystem accepts as a name at all.
    listing ??= existsSync(projects) ? readdirSync(projects) : []
    const prefix = `${name.slice(0, PROJECT_DIR_MAX_LENGTH)}-`
    for (const entry of listing) if (entry === name || entry.startsWith(prefix)) dirs.add(entry)
  }
  return dirs
}
