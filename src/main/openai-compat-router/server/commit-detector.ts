/**
 * When a group member's reply becomes the engine's. Until it carries text,
 * reasoning or a tool call the next member may still take over; start-of-message
 * frames, pings and empty blocks are not content.
 */

export type StreamVerdict =
  | { kind: 'pending' }
  | { kind: 'content' }
  | { kind: 'error'; errorType?: string; message: string }

export type ReplyVerdict =
  | { kind: 'content' }
  | { kind: 'empty' }
  | { kind: 'error'; errorType?: string; message: string }

/** Block types whose start is already something the engine acts on. */
const PLAIN_BLOCK_TYPES = new Set(['text', 'thinking'])

/** The router pads an upstream reply that said nothing with a space; blank text says nothing either. */
const isWords = (text: string | undefined): boolean => !!text && text.trim().length > 0

interface SseEvent {
  type?: string
  error?: { type?: string; message?: string }
  content_block?: { type?: string; text?: string; thinking?: string }
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string }
}

function eventSays(event: SseEvent): StreamVerdict {
  switch (event.type) {
    case 'error':
      return { kind: 'error', errorType: event.error?.type, message: event.error?.message || 'The model reported an error' }
    case 'content_block_start': {
      const block = event.content_block
      if (!block?.type) return { kind: 'pending' }
      if (!PLAIN_BLOCK_TYPES.has(block.type)) return { kind: 'content' }
      return isWords(block.text) || isWords(block.thinking) ? { kind: 'content' } : { kind: 'pending' }
    }
    case 'content_block_delta': {
      const delta = event.delta
      if (!delta) return { kind: 'pending' }
      if (delta.type === 'text_delta' && isWords(delta.text)) return { kind: 'content' }
      if (delta.type === 'thinking_delta' && isWords(delta.thinking)) return { kind: 'content' }
      if (delta.type === 'input_json_delta' && delta.partial_json) return { kind: 'content' }
      return { kind: 'pending' }
    }
    default:
      return { kind: 'pending' }
  }
}

/**
 * Reads an SSE stream as it arrives and settles on the first verdict. Once it
 * has settled it ignores further input, so a committed stream costs nothing.
 */
export class StreamCommitDetector {
  private decoder = new TextDecoder()
  private buffer = ''
  private settled: StreamVerdict = { kind: 'pending' }

  push(chunk: string | Uint8Array): StreamVerdict {
    if (this.settled.kind !== 'pending') return this.settled
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true })
    // Events end at a blank line; both line-ending styles occur.
    const events = this.buffer.split(/\r?\n\r?\n/)
    this.buffer = events.pop() ?? ''
    for (const raw of events) {
      const verdict = eventSays(parseEvent(raw))
      if (verdict.kind !== 'pending') {
        this.settled = verdict
        this.buffer = ''
        return verdict
      }
    }
    return this.settled
  }

  /** What is known so far. */
  get verdict(): StreamVerdict {
    return this.settled
  }
}

function parseEvent(raw: string): SseEvent {
  const dataLines: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0) return {}
  try {
    const parsed = JSON.parse(dataLines.join('\n')) as unknown
    return parsed && typeof parsed === 'object' ? parsed as SseEvent : {}
  } catch {
    return {}
  }
}

interface MessageReply {
  type?: string
  error?: { type?: string; message?: string }
  content?: unknown
}

/**
 * Judge a complete non-streaming reply (a 2xx body). A reply that is an error
 * object, has no content, or is not a message at all is not a reply the engine
 * can use.
 */
export function judgeMessageReply(body: string): ReplyVerdict {
  let parsed: MessageReply
  try {
    parsed = JSON.parse(body) as MessageReply
  } catch {
    return { kind: 'empty' }
  }
  if (!parsed || typeof parsed !== 'object') return { kind: 'empty' }
  if (parsed.type === 'error' || (parsed.error && typeof parsed.error === 'object' && parsed.content === undefined)) {
    return { kind: 'error', errorType: parsed.error?.type, message: parsed.error?.message || 'The model reported an error' }
  }
  if (parsed.type !== 'message' || !Array.isArray(parsed.content)) return { kind: 'empty' }
  const hasContent = parsed.content.some((block: { type?: string; text?: string; thinking?: string }) => {
    if (!block?.type) return false
    if (!PLAIN_BLOCK_TYPES.has(block.type)) return true
    return isWords(block.text) || isWords(block.thinking)
  })
  return hasContent ? { kind: 'content' } : { kind: 'empty' }
}
