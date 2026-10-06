/**
 * A working directory a session cannot start in — moved, deleted, or on a
 * drive that is not there. Its own type, carrying the folder and the space it
 * belongs to, so a chat can offer to point the space somewhere else instead
 * of only reporting the failure.
 */
export class WorkingDirectoryUnavailableError extends Error {
  constructor(readonly workDir: string, readonly spaceId?: string) {
    super(`Working directory does not exist: "${workDir}". Choose another folder for this workspace, or restore this one.`)
    this.name = 'WorkingDirectoryUnavailableError'
  }
}

/** What a chat's error event adds for a missing working directory; nothing for any other failure. */
export function workingDirErrorDetail(error: unknown, spaceId: string): { errorType: 'working_dir_unavailable'; workDirIssue: { spaceId: string; workDir: string } } | undefined {
  if (!(error instanceof WorkingDirectoryUnavailableError)) return undefined
  return { errorType: 'working_dir_unavailable', workDirIssue: { spaceId: error.spaceId ?? spaceId, workDir: error.workDir } }
}
