/**
 * Agent Module - Message Utilities
 *
 * Utilities for building and parsing messages including:
 * - Multi-modal message construction (text + images)
 * - Canvas context formatting
 * - SDK message parsing into Thought objects
 */

import type { Thought, ImageAttachment, CanvasContext } from './types'

// ============================================
// Canvas Context Formatting
// ============================================

/**
 * Format Canvas Context for injection into user message
 * Returns empty string if no meaningful context to inject
 *
 * This provides AI awareness of what the user is currently viewing
 * in the content canvas (tabs, files, URLs, etc.)
 */
export function formatCanvasContext(canvasContext?: CanvasContext): string {
  if (!canvasContext?.isOpen || canvasContext.tabCount === 0) {
    return ''
  }

  const activeTab = canvasContext.activeTab
  const tabsSummary = canvasContext.tabs
    .map(t => `${t.isActive ? '▶ ' : '  '}${t.title} (${t.type})${t.path ? ` - ${t.path}` : ''}${t.url ? ` - ${t.url}` : ''}`)
    .join('\n')

  return `<halo_canvas>
Content canvas currently open in Halo:
- Total ${canvasContext.tabCount} tabs
- Active: ${activeTab ? `${activeTab.title} (${activeTab.type})` : 'None'}
${activeTab?.url ? `- URL: ${activeTab.url}` : ''}${activeTab?.path ? `- File path: ${activeTab.path}` : ''}

All tabs:
${tabsSummary}
</halo_canvas>

`
}

// ============================================
// Multi-Modal Message Building
// ============================================

/**
 * Build multi-modal message content for Claude API
 *
 * @param text - Text content of the message
 * @param images - Optional image attachments
 * @returns Plain text string or array of content blocks for multi-modal
 */
export function buildMessageContent(
  text: string,
  images?: ImageAttachment[]
): string | Array<{ type: string; [key: string]: unknown }> {
  // If no images, just return plain text
  if (!images || images.length === 0) {
    return text
  }

  // Build content blocks array for multi-modal message
  const contentBlocks: Array<{ type: string; [key: string]: unknown }> = []

  // Add text block first (if there's text)
  if (text.trim()) {
    contentBlocks.push({
      type: 'text',
      text: text
    })
  }

  // Add image blocks
  for (const image of images) {
    contentBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mediaType,
        data: image.data
      }
    })
  }

  return contentBlocks
}

// ============================================
// SDK Message Parsing
// ============================================

/**
 * Generate a unique thought ID
 */
function generateThoughtId(): string {
  return `thought-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}


/**
 * Parse SDK message into a Thought object
 *
 * @param message - Raw SDK message
 * @param displayModel - The actual model name to display (user-configured model, not SDK's internal model)
 * @returns Thought object or null if message type is not relevant
 */
export function parseSDKMessage(message: any, displayModel?: string): Thought | null {
  const timestamp = new Date().toISOString()

  // System initialization
  if (message.type === 'system') {
    if (message.subtype === 'init') {
      // Use displayModel (user's configured model) instead of SDK's internal model
      // This ensures users see the actual model they configured, not the spoofed Claude model
      const modelName = displayModel || message.model || 'claude'
      return {
        id: generateThoughtId(),
        type: 'system',
        content: `Connected | Model: ${modelName}`,
        timestamp
      }
    }
    return null
  }

  // Assistant messages (thinking, tool_use, text blocks)
  if (message.type === 'assistant') {
    // When SDK reports an error on assistant message, skip it — the subsequent result message
    // (is_error=true) is the authoritative error source and will create the error thought.
    // This avoids duplicate error entries in the thinking timeline.
    if (message.error) {
      console.log(`[parseSDKMessage] SDK assistant error: ${message.error}, skipping (handled by result message)`)
      return null
    }

    const content = message.message?.content
    if (Array.isArray(content)) {
      for (const block of content) {
        // Thinking blocks - SKIP: handled by stream_event (content_block_start/delta/stop)
        // Streaming provides real-time incremental updates, complete message would duplicate
        if (block.type === 'thinking') {
          continue  // Skip - already sent via agent:thought + agent:thought-delta
        }
        // Tool use blocks - SKIP: handled by stream_event (content_block_start/delta/stop)
        // Streaming provides immediate tool name display and param updates
        if (block.type === 'tool_use') {
          continue  // Skip - already sent via agent:thought + agent:thought-delta
        }
        // Text blocks - send to timeline for AI intermediate responses display
        // Note: Message bubble is handled separately by agent:message via stream_event
        if (block.type === 'text' && block.text) {
          return {
            id: generateThoughtId(),
            type: 'text',
            content: block.text,
            timestamp
          }
        }
      }
    }
    return null
  }

  // User messages (tool results or command output)
  if (message.type === 'user') {
    const content = message.message?.content

    // Handle slash command output: <local-command-stdout>...</local-command-stdout>
    // These are returned as user messages with isReplay: true
    if (typeof content === 'string') {
      const match = content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)
      if (match) {
        return {
          id: generateThoughtId(),
          type: 'text',  // Render as text block (will show in assistant bubble)
          content: match[1].trim(),
          timestamp
        }
      }
    }

    // Handle tool results (array content)
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result') {
          const isError = block.is_error || false
          const resultContent = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content)

          return {
            id: block.tool_use_id || generateThoughtId(),
            type: 'tool_result',
            content: isError ? `Tool execution failed` : `Tool execution succeeded`,
            timestamp,
            toolOutput: resultContent,
            isError
          }
        }
      }
    }
    return null
  }

  // Final result
  // Simple approach: always use message.result regardless of is_error
  // The result field contains the actual content (success message or error details)
  if (message.type === 'result') {
    const resultContent = message.message?.result || message.result || ''
    const isError = message.is_error || false

    if (isError) {
      console.log(`[parseSDKMessage] SDK result error: subtype=${message.subtype}, result=${resultContent.substring(0, 200)}`)
    }

    return {
      id: generateThoughtId(),
      type: isError ? 'error' : 'result',
      content: resultContent,
      timestamp,
      isError,
      errorCode: isError ? message.subtype : undefined,
      duration: message.duration_ms
    }
  }

  return null
}

// ============================================
// Token Usage Extraction
// ============================================

/**
 * Extract single API call usage from assistant message
 */
export function extractSingleUsage(assistantMsg: any): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
} | null {
  const msgUsage = assistantMsg.message?.usage
  if (!msgUsage) return null

  return {
    inputTokens: msgUsage.input_tokens || 0,
    outputTokens: msgUsage.output_tokens || 0,
    cacheReadTokens: msgUsage.cache_read_input_tokens || 0,
    cacheCreationTokens: msgUsage.cache_creation_input_tokens || 0
  }
}

/**
 * Extract token usage from result message
 */
export function extractResultUsage(resultMsg: any, lastSingleUsage: ReturnType<typeof extractSingleUsage>): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCostUsd: number
  contextWindow: number
} | null {
  const modelUsage = resultMsg.modelUsage as Record<string, { contextWindow?: number }> | undefined
  const totalCostUsd = resultMsg.total_cost_usd as number | undefined

  // Get context window from first model in modelUsage (usually only one model)
  let contextWindow = 200000  // Default to 200K
  if (modelUsage) {
    const firstModel = Object.values(modelUsage)[0]
    if (firstModel?.contextWindow) {
      contextWindow = firstModel.contextWindow
    }
  }

  // Use last API call usage (single) + cumulative cost
  if (lastSingleUsage) {
    return {
      ...lastSingleUsage,
      totalCostUsd: totalCostUsd || 0,
      contextWindow
    }
  }

  // Fallback: If no assistant message, use result.usage (cumulative, less accurate but has data)
  const usage = resultMsg.usage as {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  } | undefined

  if (usage) {
    return {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      totalCostUsd: totalCostUsd || 0,
      contextWindow
    }
  }

  return null
}
