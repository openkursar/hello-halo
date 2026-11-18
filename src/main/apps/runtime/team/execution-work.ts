/**
 * The application layer's side of an agent execution: what delegated work means
 * for each kind of entry (`services/agent/execution` asks, this answers).
 *
 * Registered once on `app-bridge`; entries never import it.
 */

import type { ExecutionWorkHost } from '../../../services/agent'
import { openConversationWork, openMemberWork } from './chat-work'
import type { TeamRuntime } from './index'
import { openRunWork } from './run-work'

export interface ExecutionWorkDeps {
  runtime(): TeamRuntime | null
}

export function createExecutionWorkHost(deps: ExecutionWorkDeps): ExecutionWorkHost {
  return {
    open(request) {
      const { source } = request
      switch (source.kind) {
        case 'run': return openRunWork(request, deps)
        case 'conversation': return openConversationWork(request, source)
        case 'member': return openMemberWork(request, source, deps)
      }
    },
  }
}
