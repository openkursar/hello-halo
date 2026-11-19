/**
 * Session Transcript Codec
 *
 * Turns the SDK stream events a session file stores (see session-store.ts)
 * into the shared `TranscriptMessage` shape the chat page renders, thoughts
 * included. Pure: no file access, no caching — session-store reads the file
 * and caches what this returns.
 */

import { jsonrepair } from 'jsonrepair'
import { join } from 'path'
import { isTransparentTool } from '../../services/agent/constants'
import type { TeamTriggerContext } from '../../../shared/apps/team-types'
import type { ImageAttachment, ImageMediaType } from '../../../shared/types/image-attachment'
import type { ContentReference } from '../../../shared/types/content-reference'
import type {
  ChatPushVia,
  Thought,
  TranscriptMessage,
  TokenUsage,
  TranscriptProvenanceMetadata,
  TranscriptSource,
} from '../../../shared/types/transcript'
import { roleForTranscriptSource, summarizeThoughts } from '../../../shared/transcript'
import { readSkillNotice, SKILL_NOTICE_TEXT } from '../../../shared/skill-notice'
import { TOOL_IMAGE_FILE_BLOCK } from '../../../shared/tool-result-images'

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
  /** What sent a `push` record */
  _pushVia?: ChatPushVia
  /** The digital human that sent a `push` record, when it is not the chat's own */
  _pushedBy?: { appId: string; name: string }
  /** A trigger record's own id, which a later `input_outcome` line refers to */
  _inputId?: string
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
function createThoughtIdGenerator(start = 0): { next: () => string; count: () => number } {
  let idx = start
  return { next: () => `session-thought-${++idx}`, count: () => idx }
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
 * 2. Intermediate text blocks become 'text' type thoughts visible in the
 *    collapsed thought process, in the place they arrived — before the tools
 *    they introduce (same as stream-processor.ts).
 * 3. Text merging follows the main-space rule:
 *    - Consecutive text (no substantive tool in between) → concatenate.
 *    - Substantive tool in between → the next text starts a new candidate; the
 *      last candidate of the turn is the bubble and leaves the thoughts.
 * 4. Tool-result user events merge into the corresponding tool_use thought.
 * 5. Non-tool user events (trigger, escalation) flush and start a new turn,
 *    except a teammate's or another conversation's message read while the turn
 *    ran (`inputMode: 'live'`): it joins that reply's process and is emitted
 *    right after the reply segment it arrived in, naming it in `inputReplyId`.
 * 6. A `push` is a message of its own at its arrival position. Like a user
 *    event it closes the visible reply segment, while tool ids remain linked
 *    across that boundary until the native result or next initialization.
 * 7. An `input_outcome` line marks an earlier trigger record (by `_inputId`),
 *    e.g. a person's addition a stop left unread.
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
  return convertEventsToTranscript(events, lines).messages
}

/** The open native turn's first message, when the file ends inside a turn that emitted one. */
export interface ConvertedTranscript {
  messages: TranscriptMessage[]
  openTurnFrom?: string
  /** With `track`: when each message and thought last changed. */
  changes?: TranscriptChanges
  /** With `checkpoints`: points between native turns, in order, for continuing from one later. */
  checkpoints?: TranscriptCheckpoint[]
  /**
   * Converting from a seed: lines of stop marks whose records came before the
   * events. Those earlier messages changed, which this conversion cannot show.
   */
  marksBeforeStart?: number[]
}

/**
 * The line of the last event that created or changed each message and thought
 * of a conversion (a thought also changes when it stops being the reply text
 * and joins the process). Whatever was last changed before a line is exactly
 * what a conversion of the events before that line produced, and stays at the
 * same place.
 */
export interface TranscriptChanges {
  lineOf(item: TranscriptMessage | Thought): number
}

/** Conversion state that outlives a native-turn boundary. */
export interface TranscriptSeed {
  /** Thought ids generated before; ids continue after it. */
  thoughtIds: number
  /** Provenance of the user event the next replies answer. */
  teamMetadata?: TranscriptMessage['metadata']
  /** A native turn was started (`system` init) and has not ended. */
  turnOpen: boolean
  /** Inputs marked stopped so far; a mark can be read before its record. */
  stoppedInputs?: string[]
}

/**
 * A boundary between native turns: a native turn's start, or a stopped turn's
 * snapshot. Converting the events after it from `seed` yields exactly the
 * messages a whole conversion has from `messageCount` on. Later events change
 * an earlier message only by marking a person's stopped input
 * (`marksBeforeStart`).
 */
export interface TranscriptCheckpoint {
  /** Index in the converted events of the first event after the boundary. */
  eventIndex: number
  /** Messages before the boundary. */
  messageCount: number
  /** Id of the last message before the boundary. */
  lastMessageId?: string
  seed: TranscriptSeed
}

export interface ConvertOptions {
  track?: boolean
  /** Report boundaries: all of them, or only the latest `latest`. */
  checkpoints?: boolean | { latest: number }
  /** Continue from a checkpoint: the events start right after it. */
  seed?: TranscriptSeed
  /**
   * The folder beside the transcript that holds its saved tool images. Their
   * references are read relative to it, so a copied or moved transcript shows
   * its own copies.
   */
  imagesDir?: string
}

export function convertEventsToTranscript(events: StoredEvent[], lines?: readonly number[], options: ConvertOptions = {}): ConvertedTranscript {
  const thoughtIds = createThoughtIdGenerator(options.seed?.thoughtIds ?? 0)
  const generateThoughtId = thoughtIds.next

  const messages: TranscriptMessage[] = []
  const lineOf = (index: number): number => lines?.[index] ?? index + 1
  const messageId = (line: number): string => `session-msg-${line}`

  // Change lines, kept only when asked for (see TranscriptChanges).
  const changedAt = options.track ? new WeakMap<object, number>() : null
  let currentLine = 0
  const touch = (item: object): void => { changedAt?.set(item, currentLine) }
  const checkpoints: Array<TranscriptCheckpoint & { stoppedCount: number }> | null = options.checkpoints ? [] : null
  const keepCheckpoints = typeof options.checkpoints === 'object' ? options.checkpoints.latest : Infinity

  // Map from SDK tool_use block id → Thought reference (for result merging)
  const toolUseMap = new Map<string, Thought>()

  // ── Accumulator: collects thoughts across multiple assistant events ──
  let pendingThoughts: Thought[] = []
  let lastThoughtTs = ''

  // ── Text merge state (mirrors stream-processor.ts logic) ──
  // The bubble candidate sits among the thoughts where it arrived, so narration
  // keeps its place before the tools it introduces; flush lifts the last one
  // out as the bubble. hadSubstantiveTool tracks whether a non-transparent tool
  // appeared since it was set.
  let teamMetadata: TranscriptMessage['metadata'] = options.seed?.teamMetadata
  let lastTextThought: Thought | undefined
  let hadSubstantiveTool = false

  // ── Terminal result fallback ──
  // Final text + timestamp from the `result` envelope; adopted as bubble
  // content when a turn reconstructed no assistant text.
  let pendingResultText = ''
  let pendingResultTs = ''
  let pendingError: string | undefined
  let pendingErrorTs = ''
  let snapshotUsage: TokenUsage | undefined

  // File line of the event that first put something into the pending assistant
  // turn; becomes the message id on flush.
  let turnFirstLine: number | null = null
  let nativeTurnStart = 0
  let lastFlushedAnswer = ''
  /** Index in `messages` where the native turn still running at the end began. */
  let openTurnStart: number | null = options.seed?.turnOpen ? 0 : null
  /** Live records waiting for the reply segment they arrived in. */
  let heldLive: TranscriptMessage[] = []
  /** Live records placed this native turn → as held, so a checkpoint replacing its segments can place them again. */
  const placedLive = new Map<TranscriptMessage, TranscriptMessage>()
  const inputIdOf = new WeakMap<TranscriptMessage, string>()
  const recordsByInputId = new Map<string, TranscriptMessage>()
  /** Outcomes by input id; a mark may be read before or after its record. Only ever added to. */
  const outcomes = new Map<string, 'stopped'>((options.seed?.stoppedInputs ?? []).map(inputId => [inputId, 'stopped']))
  /** Converting from a seed: marks read whose records are not among the events (yet), by line. */
  const marksWithoutRecord = options.seed ? new Map<string, number>() : null

  const streamBlocks = new Map<number, {
    type: 'text' | 'thinking' | 'tool_use'
    content: string
    toolName?: string
    toolId?: string
    initialToolInput?: Record<string, unknown>
    thought?: Thought
  }>()

  /** Text arrived: extend the bubble candidate, or start a new one after a substantive tool. */
  function appendText(text: string, ts: string, separator = '\n\n'): void {
    if (!text) return
    if (!lastTextThought || hadSubstantiveTool) {
      // The candidate it replaces now shows among the thoughts.
      if (lastTextThought) touch(lastTextThought)
      lastTextThought = { id: generateThoughtId(), type: 'text', content: text, timestamp: ts }
      pendingThoughts.push(lastTextThought)
    } else {
      lastTextThought.content += separator + text
      lastTextThought.timestamp = ts
    }
    touch(lastTextThought)
    hadSubstantiveTool = false
  }

  /** Flush accumulated thoughts and the final text into one assistant Message, then reset state. */
  function flush(): void {
    const content = lastTextThought?.content || pendingResultText
    if (pendingThoughts.length === 0 && !content && !pendingError) return

    const record: TranscriptMessage = {
      id: messageId(turnFirstLine ?? lineOf(events.length - 1)),
      role: 'assistant',
      ...(teamMetadata ? { metadata: teamMetadata } : {}),
      content,
      ...(pendingError ? { error: pendingError } : {}),
      ...(snapshotUsage ? { tokenUsage: snapshotUsage } : {}),
      timestamp: lastTextThought?.timestamp || lastThoughtTs || pendingResultTs || pendingErrorTs || new Date().toISOString(),
    }

    const thoughts = pendingThoughts.filter(thought => thought !== lastTextThought)
    if (thoughts.length > 0) {
      record.thoughts = thoughts
      record.thoughtsSummary = summarizeThoughts(thoughts)
    }

    touch(record)
    messages.push(record)
    if (content) lastFlushedAnswer = content
    releaseLive(record.id)

    // Reset all turn state
    pendingThoughts = []
    lastThoughtTs = ''
    lastTextThought = undefined
    hadSubstantiveTool = false
    pendingResultText = ''
    pendingResultTs = ''
    pendingError = undefined
    pendingErrorTs = ''
    snapshotUsage = undefined
    turnFirstLine = null
  }

  /** Keep a record findable by its input id, applying a mark already read. */
  function register(record: TranscriptMessage, inputId: string | undefined): TranscriptMessage {
    if (!inputId) return record
    inputIdOf.set(record, inputId)
    const outcome = outcomes.get(inputId)
    const marked = outcome ? { ...record, metadata: { ...record.metadata, inputOutcome: outcome } } : record
    if (marked !== record) {
      inputIdOf.set(marked, inputId)
      touch(marked)
    }
    recordsByInputId.set(inputId, marked)
    return marked
  }

  /** Emit held live records after the reply they arrived in, or on their own when the native turn produced none. */
  function releaseLive(replyId?: string): void {
    for (const live of heldLive) {
      const placed = register(replyId ? { ...live, metadata: { ...live.metadata, inputReplyId: replyId } } : live, inputIdOf.get(live))
      touch(placed)
      messages.push(placed)
      placedLive.set(placed, live)
    }
    heldLive = []
  }

  /** The native turn ended: nothing later can be the reply its held records arrived in. */
  function closeNativeTurn(): void {
    releaseLive()
    placedLive.clear()
    nativeTurnStart = messages.length
    lastFlushedAnswer = ''
  }

  /** Called before each event: the previous one may have started the turn. */
  function noteTurnStart(previousIndex: number): void {
    if (turnFirstLine === null && (pendingThoughts.length > 0 || lastTextThought || pendingResultText)) {
      turnFirstLine = lineOf(previousIndex)
    }
  }

  /** The state after a native-turn boundary, from which the rest can be converted on its own. */
  function markCheckpoint(index: number): void {
    if (!checkpoints) return
    checkpoints.push({
      eventIndex: index + 1,
      messageCount: messages.length,
      ...(messages.length ? { lastMessageId: messages[messages.length - 1].id } : {}),
      // The stopped inputs so far are the first `stoppedCount` keys; listed once the latest boundaries are known.
      stoppedCount: outcomes.size,
      seed: {
        thoughtIds: thoughtIds.count(),
        ...(teamMetadata ? { teamMetadata } : {}),
        turnOpen: openTurnStart !== null,
      },
    })
    if (checkpoints.length > keepCheckpoints) checkpoints.shift()
  }

  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    const ts = event._ts || new Date().toISOString()
    noteTurnStart(index - 1)
    currentLine = lineOf(index)

    if (event.type === 'system' && event.subtype === 'init') {
      flush()
      closeNativeTurn()
      streamBlocks.clear()
      toolUseMap.clear()
      openTurnStart = messages.length
      markCheckpoint(index)
      continue
    }

    const skillNotice = readSkillNotice(event)
    if (skillNotice) {
      turnFirstLine ??= lineOf(index)
      const notice: Thought = { id: generateThoughtId(), type: 'system', content: SKILL_NOTICE_TEXT[skillNotice], skillNotice, timestamp: ts }
      touch(notice)
      pendingThoughts.push(notice)
      continue
    }

    if (event.type === 'input_outcome') {
      const inputId = typeof event._inputId === 'string' ? event._inputId : undefined
      if (inputId && event.outcome === 'stopped') {
        outcomes.set(inputId, 'stopped')
        const record = recordsByInputId.get(inputId)
        const at = record ? messages.lastIndexOf(record) : -1
        if (at >= 0) messages[at] = register(record!, inputId)
        else marksWithoutRecord?.set(inputId, lineOf(index))
      }
      continue
    }

    // A terminal partial checkpoint replaces this turn's aggregates, not a new reply.
    if (event.type === 'turn_snapshot') {
      const replaced: TranscriptMessage[] = []
      // The owner's additions follow the reply they joined; with the replies merged, that is the checkpoint.
      const additions: TranscriptMessage[] = []
      for (let at = messages.length - 1; at >= nativeTurnStart; at--) {
        const held = placedLive.get(messages[at])
        if (held) {
          replaced.unshift(held)
          messages.splice(at, 1)
        } else if (messages[at].source === 'injection') {
          additions.unshift(messages[at])
          messages.splice(at, 1)
        } else if (messages[at].role === 'assistant' && messages[at].source !== 'push') messages.splice(at, 1)
      }
      heldLive = [...replaced, ...heldLive]
      // What stayed in place from this native turn moved up.
      for (let at = nativeTurnStart; at < messages.length; at++) touch(messages[at])
      turnFirstLine ??= lineOf(index)
      pendingThoughts = Array.isArray(event.thoughts) ? withSavedImagesIn(event.thoughts as Thought[], options.imagesDir) : []
      for (const thought of pendingThoughts) touch(thought)
      // The checkpoint's text is the bubble, not one of its thoughts.
      lastTextThought = { id: generateThoughtId(), type: 'text', content: typeof event.content === 'string' ? event.content : '', timestamp: ts }
      pendingResultText = ''
      pendingError = typeof event.error === 'string' ? event.error : undefined
      snapshotUsage = event.tokenUsage as TokenUsage | undefined
      flush()
      for (const addition of additions) touch(addition)
      messages.push(...additions)
      closeNativeTurn()
      streamBlocks.clear()
      toolUseMap.clear()
      openTurnStart = null
      markCheckpoint(index)
      continue
    }

    // ── A message the digital human pushed to this chat ──
    if (event.type === 'push') {
      flush()
      const content = extractTextContent(event.message?.content)
      if (content) {
        const by = parsePushedBy(event._pushedBy)
        const pushed: TranscriptMessage = {
          id: messageId(lineOf(index)),
          role: 'assistant',
          source: 'push',
          content,
          timestamp: ts,
          metadata: {
            pushVia: parsePushVia(event._pushVia),
            ...(by ? { pushedByAppId: by.appId, pushedByName: by.name } : {}),
          },
        }
        touch(pushed)
        messages.push(pushed)
      }
      continue
    }

    // ── User events ──
    if (event.type === 'user') {
      const content = event.message?.content
      const toolResults = extractToolResults(content, options.imagesDir)

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
            touch(toolThought)
          }
        }
      } else {
        // Normal user message (trigger or escalation response).
        const source = parseSource(event._source)
        const provenance = source ? pickProvenanceMetadata(event._metadata) : {}
        const live = event._isTrigger === true && provenance.inputMode === 'live'
          && (source === 'team-message' || source === 'cross-conversation')
        const origin = event._teamOrigin ? { teamTriggerKind: event._teamOrigin.kind ?? 'human_message', correlationId: event._teamOrigin.correlationId } : undefined
        // Anything else ends the reply segment before it; the reply keeps
        // answering the input that opened its turn.
        if (!live) {
          flush()
          teamMetadata = origin
        }
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
          const metadata = {
            ...origin,
            ...provenance,
            ...(references ? { references } : {}),
          }
          const record: TranscriptMessage = {
            id: messageId(line),
            role: roleForTranscriptSource(source),
            ...(source ? { source } : {}),
            ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
            content: textContent,
            timestamp: ts,
            ...(images.length > 0 ? { images } : {}),
          }
          const inputId = typeof event._inputId === 'string' ? event._inputId : undefined
          if (live) {
            if (inputId) inputIdOf.set(record, inputId)
            heldLive.push(record)
          } else {
            const registered = register(record, inputId)
            touch(registered)
            messages.push(registered)
          }
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
          touch(thought)
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
          touch(thought)
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
          if (blockState.thought) {
            blockState.thought.content = blockState.content
            touch(blockState.thought)
          }
        } else if (blockState.type === 'tool_use' && delta?.type === 'input_json_delta') {
          blockState.content += delta.partial_json || ''
        }
        continue
      }

      if (streamEvent.type === 'content_block_stop') {
        const blockState = streamBlocks.get(index)
        if (!blockState) continue

        if (blockState.type === 'text' && blockState.content) {
          appendText(blockState.content, ts)
        } else if (blockState.type === 'tool_use' && blockState.thought) {
          blockState.thought.toolInput = blockState.content
            ? parseToolInput(blockState.content)
            : (blockState.initialToolInput || {})
          touch(blockState.thought)
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

      // A failed model request the engine told as an assistant message carrying
      // `error`: the turn's error, never its answer. A sub-agent's reaches the
      // turn through the result of the tool that ran it.
      if (typeof event.error === 'string' && event.error) {
        const reason = extractTextContent(content)
        if (reason && event.parent_tool_use_id == null) {
          turnFirstLine ??= lineOf(index)
          pendingError = reason
          pendingErrorTs = ts
        }
        continue
      }

      // Blocks join the accumulator in their order; text blocks within one
      // envelope concatenate without a separator.
      let textSeparator = '\n\n'
      for (const block of content) {
        if (block.type === 'text') {
          const text = extractTextContent([block])
          if (text) {
            appendText(text, ts, textSeparator)
            textSeparator = ''
          }
        }

        if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
          const thinking: Thought = {
            id: generateThoughtId(),
            type: 'thinking',
            content: block.thinking,
            timestamp: ts,
          }
          touch(thinking)
          pendingThoughts.push(thinking)
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
          touch(thought)
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
    // so `lastTextThought` is already set and this stays inert. Some engines
    // report failures only in the result; preserve those without treating a
    // step limit or the SDK's cancellation acknowledgement as a provider error.
    if (event.type === 'result') {
      if (event.is_error !== true) {
        const resultText = typeof event.result === 'string' ? event.result : ''
        if (resultText && (pendingThoughts.length > 0 || resultText !== lastFlushedAnswer)) {
          pendingResultText = resultText
          pendingResultTs = ts
        }
      } else if (event.subtype !== 'error_max_turns' && event.parent_tool_use_id == null) {
        const expectedAbort = event.subtype === 'error_during_execution' && event.result === 'Operation was aborted'
          && Array.isArray(event.errors) && event.errors.length === 1 && event.errors[0] === 'Operation was aborted'
        const errorText = typeof event.result === 'string' && event.result
          ? event.result : Array.isArray(event.errors) ? event.errors.filter(error => typeof error === 'string').join('\n') : ''
        if (!expectedAbort && errorText && !pendingError) {
          turnFirstLine ??= lineOf(index)
          pendingError = errorText
          pendingErrorTs = ts
        }
      }
      noteTurnStart(index)
      flush()
      closeNativeTurn()
      streamBlocks.clear()
      toolUseMap.clear()
      openTurnStart = null
      continue
    }

    // Skip 'system' and other metadata events — not displayable messages
  }

  // Flush any remaining turn (the common case — most runs are a single turn).
  noteTurnStart(events.length - 1)
  flush()
  releaseLive()

  const openTurnFrom = openTurnStart !== null && openTurnStart < messages.length ? messages[openTurnStart].id : undefined
  const changes = changedAt ? changesOf(messages, changedAt) : undefined
  const stoppedInputs = checkpoints?.length && outcomes.size ? [...outcomes.keys()] : []
  const placed = checkpoints?.map(({ stoppedCount, ...checkpoint }): TranscriptCheckpoint => stoppedCount
    ? { ...checkpoint, seed: { ...checkpoint.seed, stoppedInputs: stoppedInputs.slice(0, stoppedCount) } }
    : checkpoint)
  const marksBeforeStart = marksWithoutRecord
    ? [...marksWithoutRecord].flatMap(([inputId, line]) => recordsByInputId.has(inputId) ? [] : [line])
    : []
  return {
    messages,
    ...(openTurnFrom ? { openTurnFrom } : {}),
    ...(changes ? { changes } : {}),
    ...(placed ? { checkpoints: placed } : {}),
    ...(marksBeforeStart.length ? { marksBeforeStart } : {}),
  }
}

/** A message changes with any of its thoughts, which may be updated after it was emitted. */
function changesOf(messages: TranscriptMessage[], changedAt: WeakMap<object, number>): TranscriptChanges {
  for (const message of messages) {
    let line = changedAt.get(message) ?? 0
    for (const thought of message.thoughts ?? []) line = Math.max(line, changedAt.get(thought) ?? 0)
    changedAt.set(message, line)
  }
  return { lineOf: item => changedAt.get(item) ?? 0 }
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
  'continuity-notice',
  'environment-notice',
  'workspace-notice',
])

/** A stored `_source`, or undefined when absent or unrecognised (read as an ordinary turn). */
function parseSource(raw: unknown): TranscriptSource | undefined {
  return typeof raw === 'string' && TRANSCRIPT_SOURCES.has(raw) ? (raw as TranscriptSource) : undefined
}

/** A stored `_pushVia`; unrecognised reads as a plain message. */
function parsePushVia(raw: unknown): ChatPushVia {
  return raw === 'result' || raw === 'question' ? raw : 'message'
}

/** A stored `_pushedBy`, when it names a digital human. */
function parsePushedBy(raw: unknown): { appId: string; name: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { appId, name } = raw as Record<string, unknown>
  return typeof appId === 'string' && appId && typeof name === 'string' && name ? { appId, name } : undefined
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
  if (source.inputMode === 'live' || source.inputMode === 'turn') picked.inputMode = source.inputMode
  return picked
}

function extractToolResults(content: unknown, imagesDir?: string): Array<{ toolUseId: string; output: string; isError: boolean }> {
  if (!Array.isArray(content)) return []
  return content
    .filter((b: any) => b.type === 'tool_result')
    .map((b: any) => ({
      toolUseId: b.tool_use_id || '',
      output: typeof b.content === 'string'
        ? b.content
        : Array.isArray(b.content)
          ? toolOutputOfBlocks(b.content, imagesDir)
          : JSON.stringify(b.content ?? ''),
      isError: !!b.is_error,
    }))
}

/** A saved image's file name: its content hash and extension. */
const SAVED_IMAGE_FILE = /([0-9a-f]{16}\.(?:png|jpg|gif|webp))$/

/** A saved image's path inside the transcript's own folder; other paths stay as they are. */
function reanchor(path: string, imagesDir: string | undefined): string {
  const name = imagesDir ? SAVED_IMAGE_FILE.exec(path)?.[1] : undefined
  return name ? join(imagesDir!, name) : path
}

/**
 * Text blocks read as their text. A result whose images were saved as files
 * keeps its blocks as JSON, the form the step's image view reads; images kept
 * inline (older lines) are left out as before.
 */
function toolOutputOfBlocks(blocks: any[], imagesDir?: string): string {
  if (blocks.some((c: any) => c?.type === TOOL_IMAGE_FILE_BLOCK)) {
    return JSON.stringify(blocks
      .filter((c: any) => c?.type === 'text' || c?.type === TOOL_IMAGE_FILE_BLOCK)
      .map((c: any) => c.type === TOOL_IMAGE_FILE_BLOCK && typeof c.path === 'string' ? { ...c, path: reanchor(c.path, imagesDir) } : c))
  }
  return blocks.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
}

/**
 * A stopped turn's checkpoint stores its live steps, whose outputs may refer
 * to saved images — on a step's result, or on a result kept as a step of its
 * own when its call was not seen; those are read relative to the transcript's
 * folder too. Returns the same array when nothing refers to an image.
 */
function withSavedImagesIn(thoughts: Thought[], imagesDir: string | undefined): Thought[] {
  if (!imagesDir) return thoughts
  let changed = false
  const next = thoughts.map((thought) => {
    let updated = thought
    const result = thought.toolResult && rebasedOutput(thought.toolResult.output, imagesDir)
    if (result !== undefined) updated = { ...updated, toolResult: { ...thought.toolResult!, output: result } }
    const standalone = rebasedOutput(thought.toolOutput, imagesDir)
    if (standalone !== undefined) updated = { ...updated, toolOutput: standalone }
    if (updated !== thought) changed = true
    return updated
  })
  return changed ? next : thoughts
}

/** An output's saved-image paths read relative to `imagesDir`; undefined when it refers to none. */
function rebasedOutput(output: string | undefined, imagesDir: string): string | undefined {
  if (!output?.startsWith('[') || !output.includes(`"type":"${TOOL_IMAGE_FILE_BLOCK}"`)) return undefined
  let blocks: unknown
  try {
    blocks = JSON.parse(output)
  } catch {
    return undefined
  }
  if (!Array.isArray(blocks)) return undefined
  return JSON.stringify(blocks.map((c: any) => c?.type === TOOL_IMAGE_FILE_BLOCK && typeof c.path === 'string' ? { ...c, path: reanchor(c.path, imagesDir) } : c))
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
