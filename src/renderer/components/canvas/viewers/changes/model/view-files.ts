/**
 * The one file shape the stack, the panel and the overview work with, built
 * from a git change list or from the edits an AI reply made.
 */

import type { GitChangedFile, GitFileState } from '../../../../../../shared/types/git'
import { isGeneratedFile } from './generated-files'
import { joinRepoPath } from './paths'

export interface FileEdit {
  id: string
  before: string
  after: string
}

export interface ViewFile {
  /** Unique within its list: the card and panel row key. */
  key: string
  /** Shown path: repository-relative, or relative to the space folder in message mode when inside it. */
  path: string
  /** Absolute path, for opening the file and for references. */
  absPath: string
  oldPath?: string
  state: GitFileState
  additions: number | null
  deletions: number | null
  binary: boolean
  generated: boolean
  /** Message mode: each edit the reply made to this file, in order. */
  edits?: FileEdit[]
  /** Message mode: the whole text the reply wrote. */
  written?: string
}

export function viewFileFromGit(file: GitChangedFile, repoRoot: string): ViewFile {
  return {
    key: file.path,
    path: file.path,
    absPath: joinRepoPath(repoRoot, file.path),
    oldPath: file.oldPath,
    state: file.state,
    additions: file.additions,
    deletions: file.deletions,
    binary: file.binary,
    generated: isGeneratedFile(file),
  }
}

export interface ChangeTotals {
  files: number
  additions: number
  deletions: number
}

export function totalsOf(files: readonly ViewFile[]): ChangeTotals {
  let additions = 0
  let deletions = 0
  for (const file of files) {
    additions += file.additions ?? 0
    deletions += file.deletions ?? 0
  }
  return { files: files.length, additions, deletions }
}

/** The one-letter status git and code editors show. */
export function stateLetter(state: GitFileState): string {
  switch (state) {
    case 'modified': return 'M'
    case 'added': return 'A'
    case 'deleted': return 'D'
    case 'renamed': return 'R'
    case 'copied': return 'C'
    case 'type-changed': return 'T'
    case 'untracked': return 'U'
    case 'conflicted': return '!'
  }
}

export function stateClass(state: GitFileState): string {
  switch (state) {
    case 'modified': return 'text-diff-mod'
    case 'added':
    case 'untracked': return 'text-diff-add'
    case 'deleted':
    case 'conflicted': return 'text-diff-del'
    case 'renamed':
    case 'copied': return 'text-primary'
    case 'type-changed': return 'text-muted-foreground'
  }
}

/** A file that exists only on the after side: its whole text is the change. */
export function isNewFile(state: GitFileState): boolean {
  return state === 'added' || state === 'untracked'
}

/** Diffs at least this big start folded; the user loads them on purpose. */
export const LARGE_DIFF_LINES = 1500

export function isLargeDiff(file: ViewFile): boolean {
  return (file.additions ?? 0) + (file.deletions ?? 0) >= LARGE_DIFF_LINES
}
