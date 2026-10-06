import { resolve } from 'path'

/**
 * A working directory a session cannot start in — moved, deleted, or on a
 * drive that is not there. Its own type, carrying the folder and the space it
 * belongs to, so a chat can offer to point the space somewhere else instead
 * of only reporting the failure. The folder is kept out of the message, which
 * travels further than the owner's own window (a team lead's report, a run's
 * memory summary) and must not carry their local path.
 */
export class WorkingDirectoryUnavailableError extends Error {
  constructor(readonly workDir: string, readonly spaceId?: string) {
    super('Working directory does not exist: it was moved, deleted or is on a drive that is not connected. Choose another folder for this workspace, or restore it.')
    this.name = 'WorkingDirectoryUnavailableError'
  }
}

/** What a chat's error event adds for a missing working directory; nothing for any other failure. */
export function workingDirErrorDetail(error: unknown, spaceId: string): { errorType: 'working_dir_unavailable'; workDirIssue: { spaceId: string; workDir: string } } | undefined {
  if (!(error instanceof WorkingDirectoryUnavailableError)) return undefined
  return { errorType: 'working_dir_unavailable', workDirIssue: { spaceId: error.spaceId ?? spaceId, workDir: error.workDir } }
}

/**
 * A turn prepared in a folder its space has since left: it read the folder,
 * then the space was pointed elsewhere before its session started. Started
 * there, what it writes would stay behind in the old folder.
 */
export class WorkingDirectoryChangedError extends Error {
  constructor() {
    super('The working folder changed while this message was being prepared. Send it again.')
    this.name = 'WorkingDirectoryChangedError'
  }
}

/** spaceId → folders the space worked in before its current one. */
const retiredWorkDirs = new Map<string, Set<string>>()

/** From now on no session of the space starts in `dirs`; `current` is its folder again if it was one of them. */
export function retireWorkingDirs(spaceId: string, dirs: Iterable<string>, current: string): void {
  const retired = retiredWorkDirs.get(spaceId) ?? new Set<string>()
  for (const dir of dirs) retired.add(resolve(dir))
  retired.delete(resolve(current))
  retiredWorkDirs.set(spaceId, retired)
}

/** Refuses a session of `spaceId` in a folder the space has left. */
export function assertWorkingDirCurrent(spaceId: string, workDir: string | undefined): void {
  if (!workDir) return
  if (retiredWorkDirs.get(spaceId)?.has(resolve(workDir))) throw new WorkingDirectoryChangedError()
}
