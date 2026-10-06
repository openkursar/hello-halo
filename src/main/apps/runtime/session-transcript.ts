/**
 * Session Transcript Codec
 *
 * Turns the SDK stream events a session file stores (see session-store.ts)
 * into the shared `TranscriptMessage` shape the chat page renders, thoughts
 * included. Pure: no file access, no caching — session-store reads the file
 * and caches what this returns.
 */

import { jsonrepair } from 'jsonrepair'
import { isTransparentTool } from '../../services/agent/constants'
import type { TeamTriggerContext } from '../../../shared/apps/team-types'
import type { ImageAttachment, ImageMediaType } from '../../../shared/types/image-attachment'
import type { ContentReference } from '../../../shared/types/content-reference'
import type {
  Thought,
  TranscriptMessage,
  TokenUsage,
  TranscriptProvenanceMetadata,
  TranscriptSource,
} from '../../../shared/types/transcript'
import { roleForTranscriptSource, summarizeThoughts } from '../../../shared/transcript'

// ============================================
// Types
// ============================================

/** A serialized SDK stream event stored as a JSONL line */
export interface StoredEvent {
  /** Timestamp when the event was captured */
  _ts: string
  /** SDK event type (assistant, user, result, system, etc.) */
  type: string
  /** Whether this is a synthetic trigger message (not from SDK stream) */
  _isTrigger?: boolean
  _teamOrigin?: Pick<TeamTriggerContext, 'kind' | 'correlationId'>
  /** How a user-side record entered the conversation (absent = ordinary turn) */
  _source?: TranscriptSource
  /** Provenance details stored beside `_source` */
  _metadata?: TranscriptProvenanceMetadata
  /** Places the user pointed at with a trigger message, in the order they added them */
  _references?: ContentReference[]
  /** The SDK message payload */
  message?: {
    role?: string
    content?: unknown
  }
  [key: string]: unknown
}

// ============================================
// Event → Message Conversion
// ============================================

/** Create a thought ID generator scoped to a single convertEventsToMessages() call.
 *  Avoids module-level mutable state that could race under concurrent reads. */
function createThoughtIdGenerator(): () => string {
  let idx = 0
  return () => `session-thought-${++idx}`
}

// isTransparentTool imported from services/agent/constants — single source of truth.

/**
 * Convert stored SDK events into renderer-compatible messages with full thoughts.
 *
 * Strategy — deferred flush, merge per agent turn (aligned with main-space behavior):
 *
 * An automation run's agent loop produces many rounds of:
 *   assistant (thinking + tool_use) → user (tool_result) → assistant (text) → ...
 *
 * The main-space conversation shows each agent turn as a single message bubble
 * with one merged thought-process block. Previously, this function flushed on
 * every assistant text event, producing 5-8 fragmented messages per run.
 *
 * New strategy:
 * 1. Text does NOT trigger a flush. User messages, terminal results, new turn
 *    initialization, terminal checkpoints and end-of-events delimit turns.
 * 2. Intermediate text blocks are demoted to 'text' type thoughts visible in the
 *    collapsed thought process (same as stream-processor.ts:586).
 * 3. Text merging follows the main-space rule:
 *    - Consecutive text (no substantive tool in between) → concatenate.
 *    - Substantive tool in between → previous text demoted to thought, replaced.
 * 4. Tool-result user events merge into the corresponding tool_use thought.
 * 5. Non-tool user events (trigger, escalation) flush and start a new turn.
 *
 * Result: one agent turn = one collapsed thought-process block + one message bubble,
 * identical to the main-space rendering.
 *
 * Message ids are `session-msg-<line>`, where `line` is the file line of the
 * message's first event (the user event, or the first event that contributed to
 * an assistant turn). The file only grows, so that line never changes: a message
 * keeps its id while its turn is still in flight, and independently of how many
 * messages precede it. `lines[i]` is the line of `events[i]`; omitted, the
 * position in `events` stands in (1-based).
 */
export function convertEventsToMessages(events: StoredEvent[], lines?: readonly number[]): TranscriptMessage[] {
  const generateThoughtId = createThoughtIdGenerator()

  const messages: TranscriptMessage[] = []
  const lineOf = (index: number): number => lines?.[index] ?? index + 1
  const messageId = (line: number): string => `session-msg-${line}`

  // Map from SDK tool_use block id → Thought reference (for result merging)
  const toolUseMap = new Map<string, Thought>()

  // ── Accumulator: collects thoughts across multiple assistant events ──
  let pendingThoughts: Thought[] = []
  let lastThoughtTs = ''

  // ── Text merge state (mirrors stream-processor.ts logic) ──
  // lastText holds the candidate final text for the current turn.
  // hadSubstantiveTool tracks whether a non-transparent tool appeared since lastText was set.
  let teamMetadata: TranscriptMessage['metadata']
  let lastText = ''
  let lastTextTs = ''
  let hadSubstantiveTool = false

  // ── Terminal result fallback ──
  // Final text + timestamp from the `result` envelope; adopted as bubble
  // content when a turn reconstructed no assistant text.
  let pendingResultText = ''
  let pendingResultTs = ''
  let pendingError: string | undefined
  let snapshotUsage: TokenUsage | undefined

  // File line of the event that first put something into the pending assistant
  // turn; becomes the message id on flush.
  let turnFirstLine: number | null = null

  const streamBlocks = new Map<number, {
    type: 'text' | 'thinking' | 'tool_use'
    content: string
    toolName?: string
    toolId?: string
    initialToolInput?: Record<string, unknown>
    thought?: Thought
  }>()

  /** Flush accumulated thoughts + lastText into one assistant Message, then reset state. */
  function flush(): void {
    const content = lastText || pendingResultText
    if (pendingThoughts.length === 0 && !content && !pendingError) return

    const record: TranscriptMessage = {
      id: messageId(turnFirstLine ?? lineOf(events.length - 1)),
      role: 'assistant',
      ...(teamMetadata ? { metadata: teamMetadata } : {}),
      content,
      ...(pendingError ? { error: pendingError } : {}),
      ...(snapshotUsage ? { tokenUsage: snapshotUsage } : {}),
      timestamp: lastTextTs || lastThoughtTs || pendingResultTs || new Date().toISOString(),
    }

    if (pendingThoughts.length > 0) {
      record.thoughts = pendingThoughts
      record.thoughtsSummary = summarizeThoughts(pendingThoughts)
    }

    messages.push(record)

    // Reset all turn state
    pendingThoughts = []
    lastThoughtTs = ''
    lastText = ''
    lastTextTs = ''
    hadSubstantiveTool = false
    pendingResultText = ''
    pendingResultTs = ''
    pendingError = undefined
    snapshotUsage = undefined
    turnFirstLine = null
  }

  /** Called before each event: the previous one may have started the turn. */
  function noteTurnStart(previousIndex: number): void {
    if (turnFirstLine === null && (pendingThoughts.length > 0 || lastText || pendingResultText)) {
      turnFirstLine = lineOf(previousIndex)
    }
  }

  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    const ts = event._ts || new Date().toISOString()
    noteTurnStart(index - 1)

    if (event.type === 'system' && event.subtype === 'init') {
      flush()
      streamBlocks.clear()
      toolUseMap.clear()
      continue
    }

    // A terminal partial checkpoint replaces this turn's aggregates, not a new reply.
    if (event.type === 'turn_snapshot') {
      turnFirstLine ??= lineOf(index)
      lastText = typeof event.content === 'string' ? event.content : ''
      lastTextTs = ts
      pendingResultText = ''
      pendingThoughts = Array.isArray(event.thoughts) ? event.thoughts as Thought[] : []
      pendingError = typeof event.error === 'string' ? event.error : undefined
      snapshotUsage = event.tokenUsage as TokenUsage | undefined
      flush()
      streamBlocks.clear()
      toolUseMap.clear()
      continue
    }

    // ── User events ──
    if (event.type === 'user') {
      const content = event.message?.content
      const toolResults = extractToolResults(content)

      if (toolResults.length > 0) {
        // Tool-result user message: merge results into corresponding tool_use thoughts.
        // These are internal round-trip messages, not visible to the user.
        for (const tr of toolResults) {
          const toolThought = toolUseMap.get(tr.toolUseId)
          if (toolThought) {
            toolThought.toolResult = {
              output: tr.output,
              isError: tr.isError,
              timestamp: ts,
            }
          }
        }
      } else {
        // Normal user message (trigger or escalation response).
        // Flush the current turn before showing the user message.
        flush()
        teamMetadata = event._teamOrigin ? { teamTriggerKind: event._teamOrigin.kind ?? 'human_message', correlationId: event._teamOrigin.correlationId } : undefined
        const textContent = extractTextContent(content)
        const line = lineOf(index)
        // Image blocks become bubble attachments only for trigger records (our
        // own format) — SDK round-trip user events may carry image blocks that
        // are tool plumbing, not something the user attached.
        const images = event._isTrigger ? extractImageAttachments(content, line) : []
        // A message may be only the places the user pointed at.
        const references = event._isTrigger && Array.isArray(event._references) && event._references.length > 0
          ? event._references
          : undefined
        if (textContent || images.length > 0 || references) {
          const source = parseSource(event._source)
          const metadata = {
            ...teamMetadata,
            ...(source ? pickProvenanceMetadata(event._metadata) : {}),
            ...(references ? { references } : {}),
          }
          messages.push({
            id: messageId(line),
            role: roleForTranscriptSource(source),
            ...(source ? { source } : {}),
            ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
            content: textContent,
            timestamp: ts,
            ...(images.length > 0 ? { images } : {}),
          })
        }
      }
      continue
    }

    // ── Token-level stream events (LEGACY Codex adapter persistence) ──
    //
    // BACKWARD COMPATIBILITY ONLY. As of the engine-protocol unification
    // (codex/event-normalizer.ts → aggregateBlock), the Codex adapter emits
    // top-level `type: 'assistant'`/`type: 'user'` envelopes alongside its
    // stream_events, and `app-chat.ts` no longer persists stream_events to
    // JSONL for either engine. New runs therefore reconstruct entirely from
    // the assistant/user branches above.
    //
    // This branch handles JSONL files written BEFORE that change, where
    // Codex runs persisted stream_events as their sole record of assistant
    // content. Removing it would break "View process" replay for those
    // historical runs. Leave it; it is a no-op for new files.
    if (event.type === 'stream_event') {
      const streamEvent = event.event as any
      if (!streamEvent) continue
      const index = streamEvent.index ?? 0

      if (streamEvent.type === 'content_block_start') {
        const block = streamEvent.content_block
        if (block?.type === 'text') {
          streamBlocks.set(index, { type: 'text', content: block.text || '' })
        } else if (block?.type === 'thinking') {
          const thought: Thought = {
            id: generateThoughtId(),
            type: 'thinking',
            content: block.thinking || '',
            timestamp: ts,
          }
          pendingThoughts.push(thought)
          lastThoughtTs = ts
          streamBlocks.set(index, { type: 'thinking', content: thought.content, thought })
        } else if (block?.type === 'tool_use') {
          const thought: Thought = {
            id: generateThoughtId(),
            type: 'tool_use',
            content: '',
            timestamp: ts,
            toolName: block.name || '',
            toolInput: block.input || {},
          }
          pendingThoughts.push(thought)
          lastThoughtTs = ts
          if (!isTransparentTool(block.name || '')) {
            hadSubstantiveTool = true
          }
          if (block.id) {
            toolUseMap.set(block.id, thought)
          }
          streamBlocks.set(index, {
            type: 'tool_use',
            content: '',
            toolName: block.name || '',
            toolId: block.id,
            initialToolInput: block.input || {},
            thought,
          })
        }
        continue
      }

      if (streamEvent.type === 'content_block_delta') {
        const blockState = streamBlocks.get(index)
        if (!blockState) continue
        const delta = streamEvent.delta
        if (blockState.type === 'text' && delta?.type === 'text_delta') {
          blockState.content += delta.text || ''
        } else if (blockState.type === 'thinking' && delta?.type === 'thinking_delta') {
          blockState.content += delta.thinking || ''
          if (blockState.thought) blockState.thought.content = blockState.content
        } else if (blockState.type === 'tool_use' && delta?.type === 'input_json_delta') {
          blockState.content += delta.partial_json || ''
        }
        continue
      }

      if (streamEvent.type === 'content_block_stop') {
        const blockState = streamBlocks.get(index)
        if (!blockState) continue

        if (blockState.type === 'text' && blockState.content) {
          if (hadSubstantiveTool) {
            if (lastText) {
              pendingThoughts.push({
                id: generateThoughtId(),
                type: 'text',
                content: lastText,
                timestamp: lastTextTs,
              })
            }
            lastText = blockState.content
            lastTextTs = ts
            hadSubstantiveTool = false
          } else if (lastText) {
            lastText += '\n\n' + blockState.content
            lastTextTs = ts
          } else {
            lastText = blockState.content
            lastTextTs = ts
          }
        } else if (blockState.type === 'tool_use' && blockState.thought) {
          blockState.thought.toolInput = blockState.content
            ? parseToolInput(blockState.content)
            : (blockState.initialToolInput || {})
        }

        streamBlocks.delete(index)
        continue
      }

      continue
    }

    // ── Assistant events ──
    if (event.type === 'assistant') {
      const content = event.message?.content
      if (!Array.isArray(content)) continue

      // Extract thinking and tool_use blocks into the accumulator
      for (const block of content) {
        if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
          pendingThoughts.push({
            id: generateThoughtId(),
            type: 'thinking',
            content: block.thinking,
            timestamp: ts,
          })
          lastThoughtTs = ts
        }

        if (block.type === 'tool_use') {
          const thought: Thought = {
            id: generateThoughtId(),
            type: 'tool_use',
            content: '',
            timestamp: ts,
            toolName: block.name || '',
            toolInput: block.input || {},
          }
          pendingThoughts.push(thought)
          lastThoughtTs = ts

          // Mark substantive tool — breaks text continuity
          if (!isTransparentTool(block.name || '')) {
            hadSubstantiveTool = true
          }

          if (block.id) {
            toolUseMap.set(block.id, thought)
          }
        }
      }

      // Handle text output — deferred flush, merge into current turn
      const textContent = extractTextContent(content)
      if (textContent) {
        if (hadSubstantiveTool) {
          // A substantive tool occurred since last text — previous text was transitional.
          // Demote it to a 'text' type thought so it remains visible in the thought process.
          if (lastText) {
            pendingThoughts.push({
              id: generateThoughtId(),
              type: 'text',
              content: lastText,
              timestamp: lastTextTs,
            })
          }
          // Replace with current text
          lastText = textContent
          lastTextTs = ts
          hadSubstantiveTool = false
        } else {
          // Consecutive text (no substantive tool in between) — concatenate
          if (lastText) {
            lastText += '\n\n' + textContent
          } else {
            lastText = textContent
          }
          lastTextTs = ts
        }
      }

      continue
    }

    // ── Result events: final-text fallback for suppressed assistant text ──
    //
    // The Codex event normalizer suppresses the aggregate `assistant` text
    // envelope in live-UI mode (includePartialMessages=true) so the token-
    // level stream_event is the sole live bubble source and isn't double-
    // counted. Digital-human chat persists only the aggregate envelopes (not
    // stream_event), so such a turn lands in JSONL with thinking/tool
    // aggregates but no recoverable bubble text. The engine still reports the
    // turn's final text in `result.result`; adopt it when no text block was
    // reconstructed. Engine-agnostic: Claude carries text in assistant events,
    // so `lastText` is already set and this stays inert. Error results are
    // skipped — emitTerminalError already surfaces the message as assistant text.
    if (event.type === 'result') {
      if (event.is_error !== true) {
        const resultText = typeof event.result === 'string' ? event.result : ''
        if (resultText) {
          pendingResultText = resultText
          pendingResultTs = ts
        }
      }
      noteTurnStart(index)
      flush()
      streamBlocks.clear()
      toolUseMap.clear()
      continue
    }

    // Skip 'system' and other metadata events — not displayable messages
  }

  // Flush any remaining turn (the common case — most runs are a single turn).
  noteTurnStart(events.length - 1)
  flush()

  return messages
}

// ============================================
// Content Block Extractors
// ============================================

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text || '')
    .join('')
}

/**
 * Rebuild image attachments from base64 image blocks in a trigger record.
 *
 * `line` seeds the attachment id — the stored block has no id of its own, and
 * the message's file line keeps it stable across reads.
 */
function extractImageAttachments(content: unknown, line: number): ImageAttachment[] {
  if (!Array.isArray(content)) return []
  return content
    .filter((b: any) => b.type === 'image' && b.source?.type === 'base64' && b.source.data)
    .map((b: any, i: number) => ({
      id: `session-img-${line}-${i}`,
      type: 'image' as const,
      mediaType: (b.source.media_type || 'image/png') as ImageMediaType,
      data: b.source.data,
      ...(b._name ? { name: b._name } : {}),
    }))
}

const TRANSCRIPT_SOURCES: ReadonlySet<string> = new Set<TranscriptSource>([
  'injection',
  'cross-conversation',
  'cross-conversation-notice',
  'team-message',
])

/** A stored `_source`, or undefined when absent or unrecognised (read as an ordinary turn). */
function parseSource(raw: unknown): TranscriptSource | undefined {
  return typeof raw === 'string' && TRANSCRIPT_SOURCES.has(raw) ? (raw as TranscriptSource) : undefined
}

const PROVENANCE_STRING_KEYS = [
  'fromConversationId',
  'fromConversationTitle',
  'summary',
  'correlationId',
  'teamId',
  'epochId',
  'teamName',
  'teamTriggerKind',
] as const

/** Copy only the provenance fields we know, with the types we expect. */
function pickProvenanceMetadata(raw: unknown): TranscriptProvenanceMetadata {
  if (!raw || typeof raw !== 'object') return {}
  const source = raw as Record<string, unknown>
  const picked: TranscriptProvenanceMetadata = {}
  for (const key of PROVENANCE_STRING_KEYS) {
    if (typeof source[key] === 'string') picked[key] = source[key] as string
  }
  if (typeof source.forwardDepth === 'number') picked.forwardDepth = source.forwardDepth
  if (source.fromMemberName === null || typeof source.fromMemberName === 'string') {
    picked.fromMemberName = source.fromMemberName as string | null
  }
  return picked
}

function extractToolResults(content: unknown): Array<{ toolUseId: string; output: string; isError: boolean }> {
  if (!Array.isArray(content)) return []
  return content
    .filter((b: any) => b.type === 'tool_result')
    .map((b: any) => ({
      toolUseId: b.tool_use_id || '',
      output: typeof b.content === 'string'
        ? b.content
        : Array.isArray(b.content)
          ? b.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
          : JSON.stringify(b.content ?? ''),
      isError: !!b.is_error,
    }))
}

function parseToolInput(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw)
  } catch {
    try {
      return JSON.parse(jsonrepair(raw))
    } catch {
      return { raw }
    }
  }
}
