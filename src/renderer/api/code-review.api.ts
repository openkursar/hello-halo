/**
 * codeReviewApi — the changes view's review buttons as a slice of the unified
 * api object: start a review, read the latest review of a repository, and
 * whether a team review can run. Desktop goes over IPC, remote and mobile over
 * `/api/code-review/*`.
 */
import { httpRequest, isElectron } from './_shared'
import type { ApiResponse } from './_shared'
import type { CodeReviewAvailability, CodeReviewStartRequest, CodeReviewStartResult } from '../../shared/types/code-review'
import type { GitReviewRecord } from '../../shared/types/git'

export const codeReviewApi = {
  codeReviewStart: async (request: CodeReviewStartRequest): Promise<ApiResponse<CodeReviewStartResult>> => {
    if (isElectron()) return window.halo.codeReviewStart(request)
    return httpRequest('POST', '/api/code-review/start', { ...request })
  },

  codeReviewGetLatest: async (spaceId: string, repoRoot: string): Promise<ApiResponse<GitReviewRecord | null>> => {
    if (isElectron()) return window.halo.codeReviewGetLatest(spaceId, repoRoot)
    const query = `spaceId=${encodeURIComponent(spaceId)}&repoRoot=${encodeURIComponent(repoRoot)}`
    return httpRequest('GET', `/api/code-review/latest?${query}`)
  },

  codeReviewAvailability: async (): Promise<ApiResponse<CodeReviewAvailability>> => {
    if (isElectron()) return window.halo.codeReviewAvailability()
    return httpRequest('GET', '/api/code-review/availability')
  },
}
