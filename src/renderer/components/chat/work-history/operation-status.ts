import type { Thought } from '../../../types'

export type OperationStatus = 'done' | 'generating' | 'running' | 'failed' | 'no-result'

/**
 * Where an operation stands. Saved steps can keep a stale streaming flag or
 * miss a result (a stopped turn), so in-progress states apply only while live.
 */
export function operationStatus(step: Thought, live: boolean): OperationStatus {
  switch (step.type) {
    case 'tool_use':
      if (live && step.isReady === false) return 'generating'
      if (step.toolResult) return step.toolResult.isError ? 'failed' : 'done'
      return live ? 'running' : 'no-result'
    case 'thinking':
      return live && step.isStreaming ? 'running' : 'done'
    case 'error':
      return 'failed'
    case 'tool_result':
      return step.isError ? 'failed' : 'done'
    default:
      return 'done'
  }
}
