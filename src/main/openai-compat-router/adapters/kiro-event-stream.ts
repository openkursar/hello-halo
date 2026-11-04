/**
 * Kiro response decoding: AWS event-stream frames → typed Kiro events.
 *
 * Wire format (application/vnd.amazon.eventstream), one frame per message:
 *   [total length u32][headers length u32][prelude CRC u32][headers][payload][message CRC u32]
 * Headers carry `:message-type` (event | exception | error), `:event-type`,
 * `:exception-type` / `:error-code`. Payloads are JSON.
 *
 * Does NOT know about Anthropic or Express; the adapter maps these events.
 */

import * as crypto from 'crypto'

/** Internal tool call accumulation state (OpenAI-style). */
export interface ParsedToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string // JSON string
  }
}

export interface KiroRefusal {
  category?: string
  explanation?: string
}

export type KiroStreamEvent =
  | { type: 'content'; data: string }
  | { type: 'reasoning'; data: string }
  | { type: 'usage'; data: unknown }
  | { type: 'context_usage'; data: unknown }
  | { type: 'stop'; stopReason?: string; refusal?: KiroRefusal }
  | { type: 'error'; name: string; message: string }

const PRELUDE_BYTES = 12
const MESSAGE_CRC_BYTES = 4
const MAX_FRAME_BYTES = 16 * 1024 * 1024

/** Events the service sends that carry nothing the Anthropic stream needs. */
const IGNORED_EVENT_TYPES = new Set([
  'initial-response',
  'followupPromptEvent',
  'codeReferenceEvent',
  'supplementaryWebLinksEvent',
  'citationEvent',
  'intentsEvent',
  'interactionComponentsEvent',
  'invalidStateEvent',
  'dryRunSucceedEvent'
])

function readHeaders(buf: Buffer): Record<string, string> {
  const headers: Record<string, string> = {}
  let pos = 0
  while (pos < buf.length) {
    const nameLen = buf.readUInt8(pos); pos += 1
    const name = buf.toString('utf8', pos, pos + nameLen); pos += nameLen
    const valueType = buf.readUInt8(pos); pos += 1
    switch (valueType) {
      case 0: headers[name] = 'true'; break
      case 1: headers[name] = 'false'; break
      case 2: pos += 1; break
      case 3: pos += 2; break
      case 4: pos += 4; break
      case 5: case 8: pos += 8; break
      case 9: pos += 16; break
      case 6: case 7: {
        const len = buf.readUInt16BE(pos); pos += 2
        if (valueType === 7) headers[name] = buf.toString('utf8', pos, pos + len)
        pos += len
        break
      }
      default:
        throw new Error(`unknown header value type ${valueType}`)
    }
  }
  return headers
}

/**
 * Remove duplicate tool calls.
 *   1. By id  — if duplicated, keep the one with more arguments (not "{}")
 *   2. By name+arguments — remove exact duplicates
 */
function deduplicateToolCalls(toolCalls: ParsedToolCall[]): ParsedToolCall[] {
  const byId = new Map<string, ParsedToolCall>()
  const withoutId: ParsedToolCall[] = []

  for (const tc of toolCalls) {
    if (!tc.id) { withoutId.push(tc); continue }

    const existing = byId.get(tc.id)
    if (!existing) {
      byId.set(tc.id, tc)
    } else {
      const existingArgs = existing.function.arguments
      const currentArgs = tc.function.arguments
      if (currentArgs !== '{}' && (existingArgs === '{}' || currentArgs.length > existingArgs.length)) {
        byId.set(tc.id, tc)
      }
    }
  }

  const seen = new Set<string>()
  const unique: ParsedToolCall[] = []

  for (const tc of Array.from(byId.values()).concat(withoutId)) {
    const key = `${tc.function.name}-${tc.function.arguments}`
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(tc)
    }
  }

  return unique
}

function readReasoningText(payload: Record<string, unknown>): string {
  const reasoningText = payload.reasoningText
  if (typeof reasoningText === 'string') return reasoningText
  if (reasoningText && typeof reasoningText === 'object') {
    const text = (reasoningText as { text?: unknown }).text
    if (typeof text === 'string') return text
  }
  return typeof payload.text === 'string' ? payload.text : ''
}

/**
 * Incremental decoder. Feed raw response chunks; tool calls are accumulated
 * and returned by getToolCalls() once the stream ends.
 */
export class AwsEventStreamParser {
  private buffer: Buffer = Buffer.alloc(0)
  private lastContent: string | null = null
  private currentToolCall: ParsedToolCall | null = null
  private toolCalls: ParsedToolCall[] = []
  private broken = false
  private droppedCount = 0
  private droppedTypes = new Set<string>()

  feed(chunk: Buffer): KiroStreamEvent[] {
    if (this.broken) return []
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk

    const events: KiroStreamEvent[] = []
    while (this.buffer.length >= PRELUDE_BYTES) {
      const totalLen = this.buffer.readUInt32BE(0)
      const headersLen = this.buffer.readUInt32BE(4)
      if (totalLen < PRELUDE_BYTES + MESSAGE_CRC_BYTES || totalLen > MAX_FRAME_BYTES ||
          headersLen > totalLen - PRELUDE_BYTES - MESSAGE_CRC_BYTES) {
        this.broken = true
        events.push({ type: 'error', name: 'MalformedEventStream', message: 'Kiro response is not a valid AWS event stream' })
        break
      }
      if (this.buffer.length < totalLen) break

      const frame = this.buffer.subarray(0, totalLen)
      this.buffer = this.buffer.subarray(totalLen)

      let headers: Record<string, string>
      try {
        headers = readHeaders(frame.subarray(PRELUDE_BYTES, PRELUDE_BYTES + headersLen))
      } catch {
        this.recordDropped('malformed-headers')
        continue
      }
      const payload = frame.subarray(PRELUDE_BYTES + headersLen, totalLen - MESSAGE_CRC_BYTES)
      const event = this.processFrame(headers, payload)
      if (event) events.push(event)
    }
    return events
  }

  private processFrame(headers: Record<string, string>, payloadBytes: Buffer): KiroStreamEvent | null {
    const messageType = headers[':message-type'] ?? 'event'
    const payloadText = payloadBytes.toString('utf8')

    if (messageType === 'exception' || messageType === 'error') {
      let message = headers[':error-message'] ?? ''
      try {
        const parsed = JSON.parse(payloadText) as { message?: unknown; Message?: unknown }
        const value = parsed.message ?? parsed.Message
        if (typeof value === 'string') message = value
      } catch {
        if (!message) message = payloadText
      }
      const name = headers[':exception-type'] ?? headers[':error-code'] ?? 'UnknownException'
      return { type: 'error', name, message }
    }

    const eventType = headers[':event-type'] ?? 'unknown'
    if (IGNORED_EVENT_TYPES.has(eventType)) return null

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(payloadText) as Record<string, unknown>
    } catch {
      this.recordDropped(`${eventType}(malformed)`)
      return null
    }

    switch (eventType) {
      case 'assistantResponseEvent': return this.processContentEvent(payload)
      case 'reasoningContentEvent': {
        const text = readReasoningText(payload)
        return text ? { type: 'reasoning', data: text } : null
      }
      case 'toolUseEvent': this.processToolUseEvent(payload); return null
      case 'meteringEvent': return { type: 'usage', data: payload.usage ?? 0 }
      case 'contextUsageEvent': return { type: 'context_usage', data: payload.contextUsagePercentage ?? 0 }
      case 'metadataEvent':
      case 'messageMetadataEvent': {
        const stopDetails = payload.stopDetails as { refusal?: KiroRefusal } | undefined
        const stopReason = typeof payload.stopReason === 'string' ? payload.stopReason : undefined
        if (!stopDetails?.refusal && !stopReason) return null
        return { type: 'stop', stopReason, refusal: stopDetails?.refusal }
      }
      default:
        this.recordDropped(eventType)
        return null
    }
  }

  private recordDropped(key: string): void {
    this.droppedCount++
    this.droppedTypes.add(key)
  }

  private processContentEvent(payload: Record<string, unknown>): KiroStreamEvent | null {
    const content = typeof payload.content === 'string' ? payload.content : ''
    // Kiro sometimes sends the same chunk twice
    if (!content || content === this.lastContent) return null
    this.lastContent = content
    return { type: 'content', data: content }
  }

  private processToolUseEvent(payload: Record<string, unknown>): void {
    const toolUseId = payload.toolUseId as string | undefined
    if (toolUseId && (!this.currentToolCall || this.currentToolCall.id !== toolUseId)) {
      this.startToolCall(payload)
      return
    }
    if (!this.currentToolCall) return
    const inputData = payload.input
    if (typeof inputData === 'object' && inputData !== null) {
      this.currentToolCall.function.arguments += JSON.stringify(inputData)
    } else if (inputData != null) {
      this.currentToolCall.function.arguments += String(inputData)
    }
    if (payload.stop) this.finalizeToolCall()
  }

  private startToolCall(payload: Record<string, unknown>): void {
    if (this.currentToolCall) this.finalizeToolCall()

    const inputData = payload.input
    let inputStr = ''
    if (typeof inputData === 'object' && inputData !== null) {
      inputStr = JSON.stringify(inputData)
    } else if (inputData && String(inputData).trim()) {
      inputStr = String(inputData)
    }

    this.currentToolCall = {
      id: (payload.toolUseId as string) || `toolu_${crypto.randomBytes(12).toString('hex')}`,
      type: 'function',
      function: { name: (payload.name as string) || '', arguments: inputStr }
    }

    if (payload.stop) this.finalizeToolCall()
  }

  private finalizeToolCall(): void {
    if (!this.currentToolCall) return

    const args = this.currentToolCall.function.arguments
    if (args.trim()) {
      try {
        this.currentToolCall.function.arguments = JSON.stringify(JSON.parse(args))
      } catch {
        // Truncated or malformed — use empty object to avoid Kiro rejecting follow-up
        this.currentToolCall.function.arguments = '{}'
      }
    } else {
      // Empty arguments string (normal for duplicated tool calls from Kiro)
      this.currentToolCall.function.arguments = '{}'
    }

    this.toolCalls.push(this.currentToolCall)
    this.currentToolCall = null
  }

  /** All collected tool calls, finalizing any in-progress call. */
  getToolCalls(): ParsedToolCall[] {
    if (this.currentToolCall) this.finalizeToolCall()
    return deduplicateToolCalls(this.toolCalls)
  }

  /** Frames that were skipped because their type or payload was not understood. */
  getDropped(): { count: number; types: string[] } {
    return { count: this.droppedCount, types: Array.from(this.droppedTypes) }
  }
}
