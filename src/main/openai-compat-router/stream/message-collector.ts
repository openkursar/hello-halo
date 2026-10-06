/**
 * Anthropic Message Collector
 *
 * Folds the Anthropic SSE a stream handler writes into the one message it
 * describes. Used when the client asked for a non-streaming reply but the
 * upstream only streams: the client then expects a JSON message, and Claude
 * Code's non-streaming fallback reads `usage` straight off it.
 *
 * Running the same stream handlers as the streaming path keeps every repair
 * they apply (tool JSON, empty turns, usage fallback) in the collected reply.
 */

import type { Response as ExpressResponse } from 'express'
import type { AnthropicContentBlock, AnthropicMessageResponse, AnthropicStopReason, AnthropicUsage } from '../types'
import { safeJsonParse } from '../utils'

export type CollectedMessage =
  | { message: AnthropicMessageResponse }
  | { error: { type: string; message: string } }

interface CollectedBlock {
  block: AnthropicContentBlock
  /** Streamed tool input, parsed once the message is complete. */
  inputJson?: string
}

/**
 * Run a stream handler against a stand-in response and return the message
 * its events describe, or the error it reported.
 */
export async function collectAnthropicMessage(
  run: (sink: ExpressResponse) => Promise<void>
): Promise<CollectedMessage> {
  const collector = new MessageCollector()
  await run(collector.sink())
  return collector.result()
}

class MessageCollector {
  private buffer = ''
  private started = false
  private id = ''
  private model = ''
  private stopReason: AnthropicStopReason = 'end_turn'
  private stopSequence: string | null = null
  private usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 }
  private blocks: CollectedBlock[] = []
  // Handlers reuse an index once its block has stopped (thinking, then text
  // at the same index), so an index names the latest block started there.
  private blockAt = new Map<number, CollectedBlock>()
  private error: { type: string; message: string } | null = null

  /** The subset of an Express response that SSEWriter writes to. */
  sink(): ExpressResponse {
    const sink = {
      write: (chunk: unknown) => {
        this.feed(String(chunk))
        return true
      },
      end: () => sink,
      status: () => sink,
      json: (body: { error?: { type?: string; message?: string } }) => {
        this.error = {
          type: body?.error?.type || 'api_error',
          message: body?.error?.message || 'Upstream stream failed'
        }
        return sink
      }
    }
    return sink as unknown as ExpressResponse
  }

  result(): CollectedMessage {
    if (this.error) return { error: this.error }
    if (!this.started) {
      return { error: { type: 'api_error', message: 'Empty stream from provider' } }
    }
    return {
      message: {
        id: this.id,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: this.blocks.map(finalizeBlock),
        stop_reason: this.stopReason,
        stop_sequence: this.stopSequence,
        usage: this.usage
      }
    }
  }

  private feed(text: string): void {
    this.buffer += text
    const events = this.buffer.split('\n\n')
    this.buffer = events.pop() ?? ''
    for (const event of events) {
      const dataLine = event.split('\n').find((line) => line.startsWith('data:'))
      const data = dataLine && safeJsonParse<any>(dataLine.slice(5).trim())
      if (data) this.apply(data)
    }
  }

  private apply(event: any): void {
    switch (event.type) {
      case 'message_start':
        this.started = true
        this.id = event.message?.id ?? ''
        this.model = event.message?.model ?? ''
        Object.assign(this.usage, event.message?.usage)
        break

      case 'content_block_start': {
        const collected: CollectedBlock = { block: { ...event.content_block } }
        if (collected.block.type === 'tool_use') collected.inputJson = ''
        this.blocks.push(collected)
        this.blockAt.set(event.index, collected)
        break
      }

      case 'content_block_delta': {
        // A delta may follow its block's stop: the Responses handler appends
        // repaired tool JSON after closing the call.
        const collected = this.blockAt.get(event.index)
        if (collected) applyDelta(collected, event.delta)
        break
      }

      case 'message_delta':
        if (event.delta?.stop_reason) this.stopReason = event.delta.stop_reason
        this.stopSequence = event.delta?.stop_sequence ?? null
        Object.assign(this.usage, event.usage)
        break

      case 'error': {
        // SSEWriter.writeError nests the detail under `message`.
        const detail = event.error ?? event.message
        this.error = {
          type: detail?.type || 'api_error',
          message: detail?.message || 'Upstream stream failed'
        }
        break
      }
    }
  }
}

function applyDelta(collected: CollectedBlock, delta: any): void {
  const block = collected.block
  switch (delta?.type) {
    case 'text_delta':
      if (block.type === 'text') block.text += delta.text ?? ''
      break
    case 'thinking_delta':
      if (block.type === 'thinking') block.thinking += delta.thinking ?? ''
      break
    case 'signature_delta':
      if (block.type === 'thinking') block.signature = delta.signature
      break
    case 'input_json_delta':
      if (collected.inputJson !== undefined) collected.inputJson += delta.partial_json ?? ''
      break
  }
}

/**
 * Tool input that is still not an object after the handler's repair is kept
 * as text, the same fallback the non-streaming converters use.
 */
function finalizeBlock(collected: CollectedBlock): AnthropicContentBlock {
  if (collected.block.type !== 'tool_use' || !collected.inputJson) return collected.block
  const input = safeJsonParse<unknown>(collected.inputJson)
  collected.block.input = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : { text: collected.inputJson }
  return collected.block
}
