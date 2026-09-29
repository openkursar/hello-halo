/**
 * useBrowserToolCalls - Shared hook for extracting browser tool calls from streaming thoughts.
 *
 * Replaces identical useMemo blocks duplicated across MessageList and ImChatView.
 */

import { useMemo } from 'react'
import { isBrowserTool } from '../tool/BrowserTaskCard'
import type { Thought } from '../../types'

export interface BrowserToolCall {
  id: string
  name: string
  status: 'running' | 'success' | 'error'
  input: Record<string, unknown>
}

export function useBrowserToolCalls(thoughts: Thought[]): BrowserToolCall[] {
  return useMemo(() => {
    return thoughts
      .filter(t => t.type === 'tool_use' && t.toolName && isBrowserTool(t.toolName))
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
