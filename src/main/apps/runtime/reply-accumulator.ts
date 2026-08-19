/**
 * apps/runtime -- Reply Text Accumulator
 *
 * Stateful accumulator that reconstructs the text an IM channel should deliver
 * as the final reply, by reading raw SDK `assistant` messages in order.
 *
 * A multi-step agent flow emits content blocks like:
 *   text → tool_use → text → text
 * The trailing run of consecutive text blocks is the answer. Text that precedes
 * a tool_use is intermediate narration ("let me check X…"). Keeping only the
 * last assistant message drops earlier segments of a multi-part answer;
 * keeping every text block pollutes the reply with intermediate narration.
 * This accumulator keeps the last contiguous run of assistant text — a tool_use
 * resets the run, consecutive text extends it.
 *
 * Reading directly from SDK `assistant` messages (rather than processStream's
 * lastTextContent) avoids the dual-path state pollution documented in
 * stream-processor.ts.
 *
 * Create one instance per sendAppChatMessage call.
 */

/** Blank line between segments preserves paragraph separation across turns. */
const SEGMENT_SEPARATOR = '\n\n'

export class ReplyTextAccumulator {
  private segments: string[] = []

  /**
   * Feed one raw SDK message. Only `assistant` messages are inspected.
   * Non-empty text blocks extend the current run; a tool_use block resets it.
   * Other block kinds (e.g. thinking) are ignored — they neither extend nor
   * reset the run, so a thinking block preceding the answer does not discard it.
   */
  feed(sdkMessage: any): void {
    if (sdkMessage?.type !== 'assistant') return
    const content = sdkMessage.message?.content
    if (!Array.isArray(content)) return

    for (const block of content) {
      if (block?.type === 'text') {
        const text = typeof block.text === 'string' ? block.text.trim() : ''
        if (text) this.segments.push(text)
      } else if (block?.type === 'tool_use') {
        this.segments = []
      }
    }
  }

  /**
   * The final reply: the last contiguous run of assistant text, joined with a
   * blank line. Returns empty string when the run holds no text — including the
   * whitespace-only case, since blank blocks are never pushed — so the caller's
   * `getReply() || streamResult.finalContent` fallback engages correctly.
   */
  getReply(): string {
    return this.segments.join(SEGMENT_SEPARATOR)
  }
}
