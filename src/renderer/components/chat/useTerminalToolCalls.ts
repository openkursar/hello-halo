/**
 * useTerminalToolCalls - Extract terminal tool calls from streaming thoughts.
 * Mirrors useBrowserToolCalls for the AI Terminal toolset.
 */

import { useMemo } from 'react'
import { isTerminalTool } from '../tool/TerminalTaskCard'
import type { Thought } from '../../types'

export interface TerminalToolCall {
  id: string
  name: string
  status: 'running' | 'success' | 'error'
  input: Record<string, unknown>
}

export function useTerminalToolCalls(thoughts: Thought[]): TerminalToolCall[] {
  return useMemo(() => {
    return thoughts
      .filter(t => t.type === 'tool_use' && t.toolName && isTerminalTool(t.toolName))
      .map(t => ({
        id: t.id,
        name: t.toolName!,
        status: t.toolResult
          ? (t.toolResult.isError ? 'error' as const : 'success' as const)
          : 'running' as const,
        input: t.toolInput || {},
      }))
  }, [thoughts])
}
