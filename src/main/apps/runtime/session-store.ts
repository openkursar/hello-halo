/**
 * Session Detail Storage
 *
 * Persists App run execution messages as JSONL for the "View process" drill-down.
 * Files are stored at: {spacePath}/.halo/apps/{appId}/runs/{runId}.jsonl
 *
 * Completely separate from the conversation storage system — no pollution
 * of the user's conversation list.
 *
 * Format: one JSON object per line (JSONL), each representing a SDK stream event.
 * On read, events are converted to the shared `TranscriptMessage` format —
 * including the `thoughts[]` array (thinking, tool_use, tool_result) — so that
 * the existing MessageItem component renders them identically to main-chat
 * messages. The file is append-only; every read rebuilds messages from it, so
 * a message id must be derived from file content (see convertEventsToMessages).
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, statSync } from 'fs'
import { join } from 'path'
import { jsonrepair } from 'jsonrepair'
import { isTransparentTool } from '../../services/agent/constants'
import type { TeamTriggerContext } from '../../../shared/apps/team-types'
import type { ImageAttachment, ImageMediaType } from '../../../shared/types/image-attachment'
import type {
  Thought,
  TranscriptMessage,
  TranscriptPage,
  TranscriptPageRequest,
  TranscriptProvenance,
  TranscriptProvenanceMetadata,
  TranscriptSource,
} from '../../../shared/types/transcript'
import { pageTranscript, roleForTranscriptSource, summarizeThoughts, withThoughtsUnloaded } from '../../../shared/transcript'
import { createStampedLru } from './stamped-lru'

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
  /** The SDK message payload */
  message?: {
    role?: string
    content?: unknown
  }
  [key: string]: unknown
}

// ============================================
// Writer
// ============================================

export interface SessionWriter {
  /** Append a raw SDK stream event */
  writeEvent(event: Record<string, unknown>): void
  /**
   * Write the initial trigger message (before stream starts). Images are
   * stored as base64 image blocks in the trigger content (same trade-off as
   * main-chat conversation JSON) so chat bubbles survive the JSONL reload.
   *
   * `provenance` marks a message that did not come from the owner typing into
   * this conversation (an injection, another conversation, ...). Write the text
   * to show, not any framed text the model was given.
   */
  writeTrigger(
    content: string,
    images?: ImageAttachment[],
    teamOrigin?: Pick<TeamTriggerContext, 'kind' | 'correlationId'>,
    provenance?: TranscriptProvenance
  ): void
}

/** Get the directory for run session files */
function getRunsDir(spacePath: string, appId: string): string {
  return join(spacePath, '.halo', 'apps', appId, 'runs')
}

/** Get the JSONL file path for a specific run */
function getSessionFilePath(spacePath: string, appId: string, runId: string): string {
  // Reject path traversal — both segments are joined into a filesystem path below.
  if (appId.includes('..') || runId.includes('..')) {
    throw new Error('Invalid path parameter')
  }
  return join(getRunsDir(spacePath, appId), `${runId}.jsonl`)
}

/**
 * Create a session writer that appends events to a JSONL file.
 * Automatically creates the runs directory if missing.
 */
export function openSessionWriter(spacePath: string, appId: string, runId: string): SessionWriter {
  const dir = getRunsDir(spacePath, appId)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const filePath = getSessionFilePath(spacePath, appId, runId)

  function appendLine(event: StoredEvent): void {
    try {
      appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf8')
    } catch (err) {
      console.error(`[SessionStore] Failed to write event to ${filePath}:`, err)
    }
  }

  return {
    writeEvent(event: Record<string, unknown>): void {
      appendLine({ _ts: new Date().toISOString(), ...event } as StoredEvent)
    },

    writeTrigger(content, images, teamOrigin, provenance): void {
      const blocks: Array<Record<string, unknown>> = [{ type: 'text', text: content }]
      for (const img of images ?? []) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data },
          ...(img.name ? { _name: img.name } : {}),
        })
      }
      appendLine({
        _ts: new Date().toISOString(),
        type: 'user',
        _isTrigger: true,
        ...(teamOrigin ? { _teamOrigin: teamOrigin } : {}),
        ...(provenance ? { _source: provenance.source } : {}),
        ...(provenance?.metadata ? { _metadata: provenance.metadata } : {}),
        message: { role: 'user', content: blocks },
      })
    },
  }
}

// ============================================
// Reader
// ============================================

/**
 * A session file parsed into messages, thoughts included. Cached per file
 * (see `parsedSessions`) so paging and on-demand thought loads do not re-parse a
 * long transcript on every call. Treat as immutable — it is shared.
 */
interface ParsedSession {
  messages: TranscriptMessage[]
}

// Bounded by file bytes; parsed messages cost 2-3x that on the heap.
const parsedSessions = createStampedLru<ParsedSession>({ maxEntries: 8, maxWeight: 32 * 1024 * 1024 })

function parseSessionFile(filePath: string): ParsedSession | null {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return null
  }

  // Physical line numbers (blank and malformed lines included) are what message
  // ids derive from, so they must not shift when a line is skipped.
  const events: StoredEvent[] = []
  const lines: number[] = []
  const rawLines = raw.split('\n')
  let lastNonBlank = rawLines.length - 1
  while (lastNonBlank > 0 && !rawLines[lastNonBlank].trim()) lastNonBlank--
  const corrupt: number[] = []
  for (let i = 0; i < rawLines.length; i++) {
    if (!rawLines[i].trim()) continue
    try {
      events.push(JSON.parse(rawLines[i]))
      lines.push(i + 1)
    } catch {
      // A torn final line is a write still in progress; anywhere else it is damage.
      if (i !== lastNonBlank) corrupt.push(i + 1)
    }
  }
  if (corrupt.length > 0) {
    console.warn(`[SessionStore] Skipped ${corrupt.length} unreadable line(s) in ${filePath} (first: line ${corrupt[0]})`)
  }
  return { messages: convertEventsToMessages(events, lines) }
}

function loadParsedSession(spacePath: string, appId: string, runId: string): ParsedSession | null {
  const filePath = getSessionFilePath(spacePath, appId, runId)
  return parsedSessions.get(filePath, () => parseSessionFile(filePath))
}

/**
 * Read a run's session JSONL and convert to renderer-compatible messages, each
 * with its full thought process.
 *
 * Returns an empty array if the file doesn't exist or is unreadable.
 */
export function readSessionMessages(spacePath: string, appId: string, runId: string): TranscriptMessage[] {
  return [...(loadParsedSession(spacePath, appId, runId)?.messages ?? [])]
}

/**
 * One page of a session's transcript, newest first (see `pageTranscript`).
 * Messages carry `thoughts: null` plus `thoughtsSummary`; load a message's
 * thought process with `readSessionMessageThoughts`.
 */
export function readSessionTranscript(
  spacePath: string,
  appId: string,
  runId: string,
  request: TranscriptPageRequest = {}
): TranscriptPage {
  const page = pageTranscript(loadParsedSession(spacePath, appId, runId)?.messages ?? [], request)
  return { ...page, messages: page.messages.map(withThoughtsUnloaded) }
}

/** The thought process of one message; empty when the message is unknown or has none. */
export function readSessionMessageThoughts(
  spacePath: string,
  appId: string,
  runId: string,
  messageId: string
): Thought[] {
  const message = loadParsedSession(spacePath, appId, runId)?.messages.find(m => m.id === messageId)
  return message?.thoughts ? [...message.thoughts] : []
}

/**
 * Check if a session file exists for a given run.
 */
export function sessionExists(spacePath: string, appId: string, runId: string): boolean {
  return existsSync(getSessionFilePath(spacePath, appId, runId))
}

/**
 * Resolve the on-disk transcript path for a run, or undefined when no
 * transcript exists yet.
 *
 * This is the only sanctioned way for other modules to obtain a transcript
 * location — the directory layout is this module's private rule. Callers must
 * resolve at use time, never persist the returned path.
 */
export function resolveTranscriptPath(
  spacePath: string,
  appId: string,
  runId: string
): string | undefined {
  try {
    const filePath = getSessionFilePath(spacePath, appId, runId)
    return existsSync(filePath) ? filePath : undefined
  } catch {
    // Invalid path parameters — treat as no transcript
    return undefined
  }
}

/**
 * Copy a run's JSONL transcript to a new runId.
 *
 * Used when forking a session into a new native client session so the forked
 * window shows the full prior history immediately. Copies the raw JSONL bytes
 * verbatim (no re-serialization) — the display messages are reconstructed on
 * read via convertEventsToMessages. No-op (returns false) when the source file
 * is absent or the copy fails; the caller treats an empty transcript as a
 * fresh window, which is an acceptable degradation.
 *
 * @returns true if the transcript was copied, false otherwise
 */
export function copySessionJsonl(
  spacePath: string,
  appId: string,
  fromRunId: string,
  toRunId: string
): boolean {
  const fromPath = getSessionFilePath(spacePath, appId, fromRunId)
  if (!existsSync(fromPath)) return false
  const toPath = getSessionFilePath(spacePath, appId, toRunId)
  try {
    const dir = getRunsDir(spacePath, appId)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(toPath, readFileSync(fromPath, 'utf8'), 'utf8')
    return true
  } catch (err) {
    console.error(`[SessionStore] Failed to copy transcript ${fromRunId} → ${toRunId}:`, err)
    return false
  }
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
 * 1. Text does NOT trigger a flush. Only a user message (new conversation turn)
 *    or end-of-events triggers a flush.
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
    if (pendingThoughts.length === 0 && !content) return

    const record: TranscriptMessage = {
      id: messageId(turnFirstLine ?? lineOf(events.length - 1)),
      role: 'assistant',
      ...(teamMetadata ? { metadata: teamMetadata } : {}),
      content,
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
        if (textContent || images.length > 0) {
          const source = parseSource(event._source)
          const metadata = { ...teamMetadata, ...(source ? pickProvenanceMetadata(event._metadata) : {}) }
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
// Chat Session ID Persistence
// ============================================

/**
 * Persists Claude SDK session IDs for app-chat conversations.
 *
 * When a V2 session is rebuilt (idle timeout, process crash, config change),
 * the saved sessionId allows the SDK to restore conversation history from
 * its on-disk session file — same mechanism as the main conversation
 * (conversation.service.saveSessionId).
 *
 * Storage: {spacePath}/.halo/apps/{appId}/runs/_session-ids.json
 * Format: { [runId]: sessionId }
 */

/** Path to the session-id map file for an app */
function getSessionIdMapPath(spacePath: string, appId: string): string {
  return join(getRunsDir(spacePath, appId), '_session-ids.json')
}

/** Read the full session-id map. Returns empty object on missing/corrupt file. */
function readSessionIdMap(spacePath: string, appId: string): Record<string, string> {
  const filePath = getSessionIdMapPath(spacePath, appId)
  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
  } catch {
    // File missing or corrupt — start fresh
  }
  return {}
}

/** Write the full session-id map to disk. */
function writeSessionIdMap(spacePath: string, appId: string, map: Record<string, string>): void {
  const dir = getRunsDir(spacePath, appId)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const filePath = getSessionIdMapPath(spacePath, appId)
  try {
    writeFileSync(filePath, JSON.stringify(map), 'utf8')
  } catch (err) {
    console.error(`[SessionStore] Failed to write session-id map:`, err)
  }
}

/**
 * Save a Claude SDK sessionId for a chat session.
 * Called after stream completion to enable session resume on V2 rebuild.
 */
export function saveChatSessionId(spacePath: string, appId: string, runId: string, sessionId: string): void {
  const map = readSessionIdMap(spacePath, appId)
  map[runId] = sessionId
  writeSessionIdMap(spacePath, appId, map)
}

/**
 * Load a previously saved Claude SDK sessionId.
 * Returns undefined if no sessionId is saved for this chat session.
 */
export function loadChatSessionId(spacePath: string, appId: string, runId: string): string | undefined {
  const map = readSessionIdMap(spacePath, appId)
  return map[runId]
}

/**
 * Delete a saved sessionId for a chat session.
 * Called when clearing chat history to ensure a truly fresh start.
 */
export function deleteChatSessionId(spacePath: string, appId: string, runId: string): void {
  const map = readSessionIdMap(spacePath, appId)
  if (!(runId in map)) return
  delete map[runId]
  writeSessionIdMap(spacePath, appId, map)
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
