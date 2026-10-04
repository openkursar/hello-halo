/**
 * Code Review Controller - the review buttons of the changes view, behind the
 * IPC channels and the remote HTTP routes.
 *
 * Validates the shape of what a client sends; whether the repository belongs
 * to the space, and everything after, is the code-review service's call.
 */

import { getLatestReview, getReviewAvailability, startReview } from '../services/code-review'
import { assertCompareScope } from '../services/git'
import type { CodeReviewAvailability, CodeReviewStartRequest, CodeReviewStartResult } from '../../shared/types/code-review'
import type { GitReviewRecord } from '../../shared/types/git'

/** Longest conversation title kept; the view already writes a short one. */
const MAX_TITLE_CHARS = 200
const MAX_LABEL_CHARS = 200
const MAX_LANGUAGE_CHARS = 64
const MAX_ID_CHARS = 4096

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} is required`)
  if (value.length > max) throw new Error(`${field} is too long`)
  return value
}

/** A start request from a client, checked field by field. */
export function parseStartRequest(value: unknown): CodeReviewStartRequest {
  const request = value as Partial<Record<keyof CodeReviewStartRequest, unknown>> | null
  if (!request || typeof request !== 'object') throw new Error('A review request is required')
  if (request.variant !== 'quick' && request.variant !== 'team') throw new Error('variant must be quick or team')
  if (typeof request.fileCount !== 'number' || !Number.isInteger(request.fileCount) || request.fileCount < 0) {
    throw new Error('fileCount must be a non-negative integer')
  }
  const title = requireText(request.title, 'title', Number.MAX_SAFE_INTEGER).trim()
  return {
    spaceId: requireText(request.spaceId, 'spaceId', MAX_ID_CHARS),
    repoRoot: requireText(request.repoRoot, 'repoRoot', MAX_ID_CHARS),
    variant: request.variant,
    scope: assertCompareScope(request.scope),
    scopeLabel: requireText(request.scopeLabel, 'scopeLabel', MAX_LABEL_CHARS),
    fileCount: request.fileCount,
    language: requireText(request.language, 'language', MAX_LANGUAGE_CHARS),
    title: title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS) : title,
  }
}

export function startCodeReview(request: unknown): Promise<CodeReviewStartResult> {
  return startReview(parseStartRequest(request))
}

export function getLatestCodeReview(spaceId: unknown, repoRoot: unknown): GitReviewRecord | null {
  return getLatestReview(requireText(spaceId, 'spaceId', MAX_ID_CHARS), requireText(repoRoot, 'repoRoot', MAX_ID_CHARS))
}

export function getCodeReviewAvailability(): CodeReviewAvailability {
  return getReviewAvailability()
}
