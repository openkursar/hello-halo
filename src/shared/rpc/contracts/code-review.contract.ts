/**
 * Code review RPC contract: start an AI review of a repository's changes from
 * the changes view, read back the latest one, and whether a team review can
 * run. Remote clients reach the same operations under `/api/code-review/*`.
 */
import { rpcMethod } from '../define'
import type { CodeReviewAvailability, CodeReviewStartRequest, CodeReviewStartResult } from '../../types/code-review'
import type { GitReviewRecord } from '../../types/git'

export const codeReviewRpc = {
  codeReviewStart: rpcMethod<[request: CodeReviewStartRequest], CodeReviewStartResult>('code-review:start'),
  codeReviewGetLatest: rpcMethod<[spaceId: string, repoRoot: string], GitReviewRecord | null>('code-review:get-latest'),
  codeReviewAvailability: rpcMethod<[], CodeReviewAvailability>('code-review:availability'),
}
