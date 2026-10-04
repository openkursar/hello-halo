/**
 * Starting a review: snapshot the working tree, open a conversation in the
 * background, give it the tools its variant needs, send the review task as
 * its first message, and remember the review for the repository.
 *
 * The user's current conversation is never touched: the review conversation
 * is created in the main process and nothing here selects it.
 */

import { getConfig } from '../../foundation/config.service'
import { createConversation } from '../conversation.service'
import { closeToolset, getToolset, getWorkingDir, openToolset, sendMessage } from '../agent'
import { createSnapshot, getChangeList, isGitError, resolveRepository } from '../git'
import { TEAM_MCP_SERVER_NAME } from '../../../shared/apps/team-types'
import type {
  CodeReviewAvailability,
  CodeReviewRefusal,
  CodeReviewStartRequest,
  CodeReviewStartResult,
} from '../../../shared/types/code-review'
import type { GitChangeList, GitReviewRecord, GitSnapshot } from '../../../shared/types/git'
import type { CodeReviewTask } from '../../../shared/types/message-task'
import { buildCodeReviewInstructions } from './review-instructions'
import { saveLatestReview } from './review-store'

const LOG_TAG = '[CodeReview]'

/** Whether a team review can run now. Cheap: reads the toolset registry and config only. */
export function getReviewAvailability(): CodeReviewAvailability {
  // Registered by the apps runtime at startup; absent until it is up, or if it failed.
  if (!getToolset(TEAM_MCP_SERVER_NAME)) return { team: { available: false, reason: 'team-unavailable' } }
  // No setting offers this, but a hand-edited config can withhold the team tools,
  // and a review conversation opening the toolset would not get past it.
  const disabled = getConfig().agent?.disabledTools ?? []
  if (disabled.some(tool => tool.startsWith(`mcp__${TEAM_MCP_SERVER_NAME}`))) {
    return { team: { available: false, reason: 'team-unavailable' } }
  }
  return { team: { available: true } }
}

function refusal(reason: CodeReviewRefusal, message: string): CodeReviewStartResult {
  return { ok: false, reason, message }
}

function refusalFromError(error: unknown): CodeReviewStartResult {
  const message = error instanceof Error ? error.message : String(error)
  if (isGitError(error)) {
    if (error.code === 'GIT_NOT_A_REPOSITORY') return refusal('not-a-repository', message)
    if (error.code === 'GIT_UNAVAILABLE') return refusal('git-unavailable', message)
  }
  return refusal('failed', message)
}

/** Titles are the renderer's wording; only their size is bounded here. */
const MAX_TITLE_CHARS = 200

export async function startReview(request: CodeReviewStartRequest): Promise<CodeReviewStartResult> {
  const { spaceId, variant, scope } = request
  if (variant === 'team' && !getReviewAvailability().team.available) {
    console.warn(`${LOG_TAG} Team review refused: team collaboration is not available (space=${spaceId})`)
    return refusal('team-unavailable', 'Team collaboration is not available')
  }

  let task: CodeReviewTask
  let reviewChanges: Pick<GitChangeList, 'files' | 'truncated'>
  let snapshot: GitSnapshot
  try {
    const repo = await resolveRepository(spaceId, request.repoRoot)
    // Taken together, so the snapshot (the base of "since last review" and of
    // staleness) is the working tree the change list describes.
    snapshot = await createSnapshot(spaceId, repo.root)
    const changes = await getChangeList(spaceId, repo.root, scope)
    reviewChanges = { files: changes.files, truncated: changes.truncated }
    task = {
      type: 'code-review',
      variant,
      repoRoot: repo.root,
      repoName: repo.name,
      scope,
      scopeLabel: request.scopeLabel,
      beforeRevision: changes.beforeRevision,
      fileCount: changes.truncated ? Math.max(request.fileCount, changes.files.length) : changes.files.length,
      language: request.language,
    }
  } catch (error) {
    console.warn(`${LOG_TAG} Review not started: reading the repository failed (space=${spaceId}, repo=${request.repoRoot}):`, error)
    return refusalFromError(error)
  }

  let conversationId: string
  try {
    const title = request.title.trim().slice(0, MAX_TITLE_CHARS) || `Review · ${task.repoName}`
    conversationId = createConversation(spaceId, title, undefined, { keepTitle: true }).id
  } catch (error) {
    console.error(`${LOG_TAG} Review not started: creating its conversation failed (space=${spaceId}):`, error)
    return refusalFromError(error)
  }

  // A quick review is one agent by definition; a team review needs the team tools.
  // Seeded before the first message, so the session it creates already has them.
  const toolsetScope = { spaceId, conversationId, workDir: getWorkingDir(spaceId) }
  const toolset = variant === 'team'
    ? openToolset(toolsetScope, TEAM_MCP_SERVER_NAME, 'system')
    : closeToolset(toolsetScope, TEAM_MCP_SERVER_NAME, 'system')
  if (!toolset.ok) {
    // The instructions fall back to a single reviewer and say so in the report.
    console.warn(`${LOG_TAG} Could not ${variant === 'team' ? 'open' : 'close'} team tools for review ${conversationId}: ${toolset.error}`)
  }

  const taskInstructions = buildCodeReviewInstructions(task, { workDir: toolsetScope.workDir, changes: reviewChanges })

  // The message is recorded before sendMessage first yields, so the review is
  // visible at once; the turn itself runs in the background and reports its own
  // failure on the conversation.
  sendMessage({ spaceId, conversationId, message: '', task, taskInstructions, thinkingEnabled: true })
    .catch((error: unknown) => console.error(`${LOG_TAG} Review ${conversationId} failed to start its turn:`, error))

  const record: GitReviewRecord = {
    repoRoot: task.repoRoot,
    conversationId,
    variant,
    scope,
    scopeLabel: task.scopeLabel,
    snapshot: snapshot.tree,
    fileCount: task.fileCount,
    startedAt: snapshot.createdAt,
  }
  try {
    saveLatestReview(spaceId, record)
  } catch (error) {
    // The review runs regardless; only "latest review" will not survive a restart.
    console.error(`${LOG_TAG} Review ${conversationId} started but could not be recorded:`, error)
  }

  console.log(`${LOG_TAG} Started ${variant} review ${conversationId}: space=${spaceId} repo=${task.repoName} scope=${scope.kind} files=${task.fileCount}`)
  return { ok: true, conversationId, record }
}
