/**
 * A built-in task a user message starts, such as a code review launched from
 * the changes view. The transcript shows it as one card; the model receives
 * Halo's built-in instructions for it, built in the main process.
 */
import type { GitCompareScope } from './git'

export interface CodeReviewTask {
  type: 'code-review'
  /** quick: one agent. team: the instructions ask the agent to run a three-member review team. */
  variant: 'quick' | 'team'
  repoRoot: string
  repoName: string
  scope: GitCompareScope
  /** The compare scope as the user saw it. */
  scopeLabel: string
  /** See GitChangeList.beforeRevision. */
  beforeRevision: string | null
  fileCount: number
  /** UI language of the user who started it (BCP 47), so the report reads in it. */
  language: string
}

export type MessageTask = CodeReviewTask
