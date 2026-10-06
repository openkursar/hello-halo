/**
 * Removing a session the engine stored on disk, and carrying a working
 * directory's stored sessions over to the directory a space moved to.
 *
 * The default engine keeps each session under `<config dir>/projects/<project dir>/`:
 * `<session id>.jsonl`, and a `<session id>/` folder for its sub-agents and
 * large tool results. The project dir is the working directory, resolved and
 * NFC-normalized, with every non-alphanumeric character turned into '-'; past
 * 200 characters it is cut and a hash of the full path appended, so a long one
 * is found by that prefix.
 *
 * The halo engine uses the same layout (its project dir is the path as given,
 * which is tried too), but running in-process it currently takes its config dir
 * from the process environment instead of the session's, so its sessions land
 * in `~/.claude` whatever Halo configures. Only the configured config dir is
 * looked in, so with the default setting they are not reached; they are covered
 * once the engine stores them in the session's config dir. Codex and dsh store
 * sessions elsewhere and are not covered.
 */

import { existsSync, readdirSync, realpathSync, rmSync } from 'fs'
import { copyFile, cp, mkdir, readdir, stat } from 'fs/promises'
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

/**
 * Make the sessions stored while running in `fromWorkDir` resumable from
 * `toWorkDir`, which a space's working directory was just changed to: the
 * engine looks a session up under the project dir of the directory it runs
 * in, so every conversation would otherwise start afresh. Copies, never moves
 * (another space may still run in the old directory). A session file already
 * there is replaced only by a newer one — after a change back and forth, the
 * conversation resumes from where it last ran — and session folders are
 * merged. `toWorkDir` must exist.
 *
 * @returns how many session files were copied
 */
export async function copyStoredSessions(fromWorkDir: string, toWorkDir: string, configDir = resolveClaudeConfigDir()): Promise<number> {
  const projects = join(configDir, 'projects')
  const target = join(projects, projectDirName(realpathSync(toWorkDir).normalize('NFC')))
  let copied = 0
  for (const dir of projectDirs(projects, fromWorkDir)) {
    const source = join(projects, dir)
    if (source === target || !existsSync(source)) continue
    await mkdir(target, { recursive: true })
    for (const entry of await readdir(source, { withFileTypes: true })) {
      const from = join(source, entry.name)
      const to = join(target, entry.name)
      if (entry.isDirectory()) {
        await cp(from, to, { recursive: true, force: false, errorOnExist: false })
      } else if (entry.isFile() && (await mtimeOf(to)) < (await stat(from)).mtimeMs) {
        await copyFile(from, to)
        copied += 1
      }
    }
  }
  return copied
}

async function mtimeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return -Infinity
  }
}

/**
 * The engine's own name for the project dir of `path` (already resolved and
 * NFC-normalized): past the length limit, the 31-multiplier string hash it
 * uses when running on Node, not Bun. Exported for its test, which pins it to
 * the engine's output.
 */
export function projectDirName(path: string): string {
  const name = path.replace(/[^a-zA-Z0-9]/g, '-')
  if (name.length <= PROJECT_DIR_MAX_LENGTH) return name
  let hash = 0
  for (let i = 0; i < path.length; i++) hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0
  return `${name.slice(0, PROJECT_DIR_MAX_LENGTH)}-${Math.abs(hash).toString(36)}`
}
