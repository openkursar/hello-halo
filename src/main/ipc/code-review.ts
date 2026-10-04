/**
 * IPC handlers for the changes view's review buttons.
 *
 * Channels come from `shared/rpc/contracts/code-review.contract`; arguments are
 * checked by the controller, which the `/api/code-review/*` routes share.
 */

import { codeReviewRpc } from '../../shared/rpc/contracts/code-review.contract'
import * as codeReviewController from '../controllers/code-review.controller'
import { registerRpcHandlers } from './rpc'

export function registerCodeReviewHandlers(): void {
  registerRpcHandlers(
    codeReviewRpc,
    {
      codeReviewStart: (request) => codeReviewController.startCodeReview(request),
      codeReviewGetLatest: (spaceId, repoRoot) => codeReviewController.getLatestCodeReview(spaceId, repoRoot),
      codeReviewAvailability: () => codeReviewController.getCodeReviewAvailability(),
    },
    'CodeReview',
  )
}
