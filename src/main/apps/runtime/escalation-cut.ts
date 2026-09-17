/**
 * apps/runtime -- Ending the turn that asked the user a question
 *
 * A turn that raised an escalation is over at that point. The answer comes back
 * as its own wake, so anything the model does afterwards runs without the very
 * decision it just said it could not proceed without — and an irreversible step
 * taken there defeats the purpose of having asked. Ending the turn used to be
 * left to the model (the tool result asked it to stop); it frequently kept
 * working anyway.
 *
 * The cut waits for every tool call the turn has issued to have its result:
 * a call left without one is a transcript some engines refuse to resume, which
 * would cost the user the whole conversation the answer is meant to return to.
 * Waiting also costs nothing — the results are already on their way, and the
 * model's own continuation is what gets discarded.
 *
 * Both turn consumers apply the rule — automation runs read the SDK stream
 * directly, chat and team turns observe it through the app-chat sink — so the
 * rule and the reason for it live here rather than in either of them.
 */

interface SdkContentBlock {
  type?: string
  id?: string
  tool_use_id?: string
}

function contentBlocks(sdkMessage: unknown): SdkContentBlock[] {
  const content = (sdkMessage as { message?: { content?: unknown } } | null)?.message?.content
  return Array.isArray(content) ? (content as SdkContentBlock[]) : []
}

/**
 * Follows a turn's outstanding tool calls to find a point where it can be cut
 * without truncating the transcript mid-call.
 */
export class TurnCutPoint {
  private readonly outstanding = new Set<string>()

  /**
   * Feed every SDK message of the turn, in arrival order.
   *
   * @returns whether the turn may be cut immediately after this message. Only
   *   ever true on a tool result, which is the proof that the call that raised
   *   the escalation is complete — a `system` or `assistant` message could
   *   arrive while the escalation tool is still mid-flight and would otherwise
   *   look like an equally safe stopping point.
   */
  observe(sdkMessage: unknown): boolean {
    const type = (sdkMessage as { type?: string } | null | undefined)?.type

    if (type === 'assistant') {
      for (const block of contentBlocks(sdkMessage)) {
        if (block.type === 'tool_use' && block.id) this.outstanding.add(block.id)
      }
      return false
    }

    if (type !== 'user') return false

    for (const block of contentBlocks(sdkMessage)) {
      if (block.type === 'tool_result' && block.tool_use_id) this.outstanding.delete(block.tool_use_id)
    }
    return this.outstanding.size === 0
  }
}
