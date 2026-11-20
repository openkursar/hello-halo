/**
 * apps/runtime -- Progress Formatter
 *
 * Stateful parser that converts raw SDK stream events to platform-agnostic
 * ProgressEvent objects. Accumulates tool input JSON and thinking text
 * across multiple content_block_delta events before emitting on
 * content_block_stop — ensuring rich, complete content in every event.
 *
 * Usage: create one ProgressEventParser per sendAppChatMessage call.
 *
 * Why stateful? The SDK streams tool input as incremental JSON deltas:
 *   content_block_start  → { type: 'tool_use', name: 'Bash', input: {} }  ← empty
 *   content_block_delta  → { input_json_delta: '{"command":"ls' }
 *   content_block_delta  → { input_json_delta: ' -la /tmp"}' }
 *   content_block_stop   → block complete — full input available here
 * Emitting on start produces "⚙️ Bash" with no command; emitting on stop
 * produces "⚙️ ls -la /tmp". Same applies to thinking text.
 */

import type { ProgressEvent, WorkProgressEvent } from '../../../shared/types/inbound-message'

interface WorkBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  tool_use_id?: string
  is_error?: boolean
}

/** Aggregate messages preserve block order and match parallel results by call ID. */
export function* readWorkProgress(raw: unknown): Iterable<WorkProgressEvent> {
  const message = raw as {
    type?: string
    parent_tool_use_id?: string | null
    isReplay?: boolean
    error?: unknown
    event?: { type?: string; content_block?: WorkBlock; delta?: WorkBlock }
    message?: { content?: WorkBlock[] }
  } | null
  if (!message || message.parent_tool_use_id || message.isReplay || message.error) return
  if (message.type === 'stream_event') {
    const event = message.event
    const block = event?.content_block
    if (event?.type === 'content_block_start' && block?.type === 'tool_use' &&
      typeof block.id === 'string' && typeof block.name === 'string') {
      yield { type: 'operation_started', id: block.id, tool: block.name }
    }
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
      yield { type: 'speech_delta', text: event.delta.text }
    }
    return
  }
  if (message.type !== 'assistant' && message.type !== 'user') return
  const blocks = message.message?.content
  if (!Array.isArray(blocks)) return

  for (const block of blocks) {
    if (message.type === 'assistant') {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        yield { type: 'speech', text: block.text }
      } else if (block?.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        yield { type: 'operation_started', id: block.id, tool: block.name }
      }
    } else if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      yield { type: 'operation_finished', id: block.tool_use_id, success: block.is_error !== true }
    }
  }
}

// ============================================
// Tool Summary Helpers
// ============================================

/** Truncate a string to maxLen, appending '...' if truncated. */
function truncate(str: string | undefined | null, maxLen: number): string {
  if (!str) return ''
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen) + '...'
}

/** Truncate a file path, keeping the rightmost portion after a path separator. */
function truncatePath(p: string | undefined | null, maxLen = 50): string {
  if (!p) return ''
  if (p.length <= maxLen) return p
  const tail = p.slice(-(maxLen - 3))
  const slashIdx = tail.indexOf('/')
  if (slashIdx !== -1) return '...' + tail.slice(slashIdx)
  return '...' + tail
}

/**
 * Produce a human-readable summary for a browser tool call.
 * `action` is the bare browser_* name (e.g. 'browser_navigate').
 */
function summarizeBrowserAction(action: string, input: Record<string, unknown>): string {
  switch (action) {
    // --- Active tools (15) ---
    case 'browser_navigate':
      return truncate(input.url as string, 50) || 'Navigate'

    case 'browser_click':
      return input.dragTo ? 'Drag' : input.dblClick ? 'Double click' : 'Click'

    case 'browser_fill':
      if (input.elements) return 'Fill form'
      return truncate(input.value as string, 40) || 'Fill input'

    case 'browser_hover':
      return 'Hover'

    case 'browser_press_key':
      return `Key: ${input.key ?? '?'}`

    case 'browser_upload_file': {
      const fp = input.filePath
      if (Array.isArray(fp)) {
        return fp.length === 1
          ? truncatePath(fp[0] as string) || 'Upload file'
          : `Upload ${fp.length} files`
      }
      return truncatePath(fp as string) || 'Upload file'
    }

    case 'browser_wait_for':
      return truncate(input.text as string, 40) || 'Wait'

    case 'browser_snapshot':
      return 'Page snapshot'

    case 'browser_screenshot':
      return 'Screenshot'

    case 'browser_evaluate':
      return truncate(input.function as string, 40) || 'Evaluate JS'

    case 'browser_run':
      return 'Run script'

    case 'browser_tab':
      if (input.action === 'list') return 'List tabs'
      if (input.action === 'new') return truncate(input.url as string, 50) || 'Open tab'
      if (input.action === 'close') return 'Close tab'
      return `Select tab ${input.pageIdx ?? ''}`

    case 'browser_inspect':
      if (input.target === 'console') return 'Console messages'
      return 'Network requests'

    case 'browser_download':
      return truncate(input.url as string, 40) || 'Download'

    case 'browser_handle_dialog':
      return `Dialog: ${input.action ?? '?'}`

    // --- Retired tools (kept for backward compat with existing conversation history) ---
    case 'browser_new_page':
      return truncate(input.url as string, 50) || 'Open page'

    case 'browser_fill_form':
      return 'Fill form'

    case 'browser_drag':
      return 'Drag'

    case 'browser_select_page':
      return `Select page ${input.pageIdx ?? ''}`

    case 'browser_close_page':
      return 'Close page'

    case 'browser_list_pages':
      return 'List pages'

    case 'browser_console':
    case 'browser_console_message':
      return 'Console'

    case 'browser_network_requests':
    case 'browser_network_request':
      return 'Network'

    case 'browser_emulate':
      return 'Emulate'

    case 'browser_resize':
      return `Resize: ${input.width ?? '?'}×${input.height ?? '?'}`

    case 'browser_perf_start':
    case 'browser_perf_stop':
    case 'browser_perf_insight':
      return 'Performance'

    default:
      // Fallback: clean up underscores → readable label
      return action.replace('browser_', '').replace(/_/g, ' ')
  }
}

/**
 * Produce a short human-readable summary for any completed tool call.
 *
 * Strategy:
 * 1. Built-in SDK tools — explicit cases, extract the meaningful input field
 * 2. AI Browser MCP tools — strip `mcp__ai-browser__` prefix, delegate to summarizeBrowserAction
 * 3. Other MCP tools — strip the `mcp__{server}__` prefix, humanize the method name
 */
export function summarizeToolCall(toolName: string, input: Record<string, unknown>): string {
  // ── Built-in SDK tools ──────────────────────────────────────────
  switch (toolName) {
    case 'Read':
      return truncatePath(input.file_path as string)
    case 'Edit':
      return truncatePath(input.file_path as string)
    case 'Write':
      return truncatePath(input.file_path as string)
    case 'Bash':
      return truncate(input.command as string, 60)
    case 'Glob':
      return truncate(input.pattern as string, 50)
    case 'Grep':
      return `"${truncate(input.pattern as string, 30)}"`
    case 'Agent':
      return truncate((input.description as string) ?? 'Sub-agent task', 60)
    case 'Task':
      return truncate((input.description as string) ?? 'Task', 60)
    case 'WebFetch':
      return truncate(input.url as string, 60)
    case 'WebSearch':
      return truncate(input.query as string, 60)
    case 'TodoWrite':
    case 'TodoRead':
      return 'Update todo list'
    case 'NotebookEdit':
      return truncatePath(input.notebook_path as string)
    case 'ExitPlanMode':
      return 'Exit plan mode'
  }

  // ── AI Browser MCP tools ────────────────────────────────────────
  // All browser tools follow: mcp__ai-browser__browser_*
  const BROWSER_PREFIX = 'mcp__ai-browser__'
  if (toolName.startsWith(BROWSER_PREFIX)) {
    const action = toolName.slice(BROWSER_PREFIX.length) // e.g. 'browser_navigate'
    return summarizeBrowserAction(action, input)
  }

  // ── Other MCP tools ─────────────────────────────────────────────
  // Pattern: mcp__{server-name}__{method}
  // Extract just the method name and humanize it
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__')
    const method = parts[parts.length - 1] ?? toolName
    return method.replace(/_/g, ' ')
  }

  // Unknown tool — return as-is
  return toolName
}

// ============================================
// Internal: Tool Result Parser
// ============================================

/** Parse a user message containing tool_result blocks into a ProgressEvent. */
function parseToolResult(sdkMessage: any): ProgressEvent | null {
  try {
    const content = sdkMessage?.message?.content
    if (!Array.isArray(content)) return null
    const toolResult = content.find((b: any) => b.type === 'tool_result')
    if (!toolResult) return null

    const isError = toolResult.is_error === true
    const resultContent = toolResult.content
    let summary = ''
    if (typeof resultContent === 'string') {
      summary = truncate(resultContent, 60)
    } else if (Array.isArray(resultContent)) {
      const text = resultContent.find((b: any) => b.type === 'text')?.text
      summary = truncate(text, 60)
    }

    return {
      type: 'tool_result',
      tool: '',
      summary: summary || (isError ? 'Error' : 'Done'),
      success: !isError,
    }
  } catch {
    return null
  }
}

// ============================================
// ProgressEventParser (Stateful)
// ============================================

type PendingBlock =
  | { kind: 'tool_use'; name: string; chunks: string[] }
  | { kind: 'thinking'; chunks: string[] }

/**
 * Stateful SDK stream parser.
 *
 * Accumulates content_block_delta events per block index, then emits a
 * complete ProgressEvent on content_block_stop — so tool summaries always
 * contain the full input and thinking events contain the full text.
 *
 * text_delta events (final answer) are emitted immediately since they
 * are meant to stream token-by-token to the user.
 *
 * Create one instance per sendAppChatMessage call.
 */
export class ProgressEventParser {
  private pending = new Map<number, PendingBlock>()

  /**
   * Feed one raw SDK message. Returns a ProgressEvent when a block is
   * complete, or null when the message is intermediate or irrelevant.
   */
  feed(sdkMessage: any): ProgressEvent | null {
    if (!sdkMessage) return null

    if (sdkMessage.type === 'stream_event') {
      const event = sdkMessage.event
      if (!event) return null

      const index: number = event.index ?? 0

      // Block start: register which kind of block is opening at this index
      if (event.type === 'content_block_start') {
        const block = event.content_block
        if (!block) return null

        if (block.type === 'tool_use') {
          this.pending.set(index, { kind: 'tool_use', name: block.name ?? 'unknown', chunks: [] })
        } else if (block.type === 'thinking') {
          this.pending.set(index, { kind: 'thinking', chunks: [] })
        }
        return null
      }

      // Block delta: accumulate into the pending block
      if (event.type === 'content_block_delta') {
        const delta = event.delta
        if (!delta) return null

        if (delta.type === 'input_json_delta') {
          const pb = this.pending.get(index)
          if (pb?.kind === 'tool_use') pb.chunks.push(delta.partial_json ?? '')
          return null
        }

        if (delta.type === 'thinking_delta') {
          const pb = this.pending.get(index)
          if (pb?.kind === 'thinking') pb.chunks.push(delta.thinking ?? '')
          return null
        }

        // text_delta: emit immediately — drives token-by-token answer streaming
        if (delta.type === 'text_delta') {
          const text: string = delta.text ?? ''
          return text ? { type: 'text_delta', text } : null
        }
      }

      // Block stop: assemble the complete event and emit
      if (event.type === 'content_block_stop') {
        const pb = this.pending.get(index)
        this.pending.delete(index)
        if (!pb) return null

        if (pb.kind === 'tool_use') {
          let input: Record<string, unknown> = {}
          try {
            const json = pb.chunks.join('')
            if (json) input = JSON.parse(json)
          } catch { /* malformed JSON — proceed with empty input */ }
          const summary = summarizeToolCall(pb.name, input)
          return { type: 'tool_call', tool: pb.name, summary }
        }

        if (pb.kind === 'thinking') {
          const text = truncate(pb.chunks.join(''), 80) || 'Thinking...'
          return { type: 'thinking', text }
        }
      }
    }

    // Tool results arrive as user messages
    if (sdkMessage.type === 'user') {
      return parseToolResult(sdkMessage)
    }

    return null
  }
}
