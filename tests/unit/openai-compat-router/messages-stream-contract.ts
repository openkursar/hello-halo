/**
 * The block lifecycle of an Anthropic Messages stream, as Anthropic itself
 * streams it, and the tool calls a client runs from it, for tests of the
 * router's stream handlers. Clients that validate the stream end the turn on
 * any violation — a reused index above all.
 */

type SSEEvent = { event: string; data: any }

const DELTA_BLOCK_TYPE: Record<string, string> = {
  text_delta: 'text',
  thinking_delta: 'thinking',
  signature_delta: 'thinking',
  input_json_delta: 'tool_use'
}

/** `type@index` of every block start, in order. */
export function blockStarts(events: SSEEvent[]): string[] {
  return events
    .filter(e => e.event === 'content_block_start')
    .map(e => `${e.data.content_block?.type}@${e.data.index}`)
}

/**
 * Blocks take indices 0, 1, 2… in order, one is open at a time, every delta
 * goes to the open block and matches its type, and every block stops before
 * message_delta. Returns what breaks that, empty when nothing does.
 */
export function blockLifecycleViolations(events: SSEEvent[]): string[] {
  const violations: string[] = []
  let nextIndex = 0
  let open: { index: number; type: string } | null = null
  let settled = false

  for (const { event, data } of events) {
    if (event === 'content_block_start') {
      if (settled) violations.push(`block ${data.index} starts after message_delta`)
      if (open) violations.push(`block ${data.index} starts while block ${open.index} is open`)
      if (data.index !== nextIndex) violations.push(`block starts at index ${data.index}, expected ${nextIndex}`)
      nextIndex = data.index + 1
      open = { index: data.index, type: data.content_block?.type }
    } else if (event === 'content_block_delta') {
      const deltaType = data.delta?.type
      if (!open || open.index !== data.index) {
        violations.push(`${deltaType} for block ${data.index}, which is not open`)
      } else if (DELTA_BLOCK_TYPE[deltaType] !== open.type) {
        violations.push(`${deltaType} for ${open.type} block ${data.index}`)
      }
    } else if (event === 'content_block_stop') {
      if (!open || open.index !== data.index) {
        violations.push(`stop for block ${data.index}, which is not open`)
      } else {
        open = null
      }
    } else if (event === 'message_delta') {
      if (open) violations.push(`message_delta while block ${open.index} is open`)
      settled = true
    }
  }
  return violations
}

/**
 * Every tool call as a client that fixes a call's input at its block's stop
 * runs it — Claude Code does, and arguments sent after the stop never reach
 * the call. `input` is undefined when the JSON sent before the stop does not
 * parse: the call then runs with no input, which its tool refuses.
 */
export function toolCallsAtStop(events: SSEEvent[]): Array<{ name: string; input: unknown }> {
  const pending = new Map<number, { name: string; json: string }>()
  const calls: Array<{ name: string; input: unknown }> = []
  for (const { event, data } of events) {
    if (event === 'content_block_start' && data.content_block?.type === 'tool_use') {
      pending.set(data.index, { name: data.content_block.name, json: '' })
    } else if (event === 'content_block_delta' && data.delta?.type === 'input_json_delta') {
      const call = pending.get(data.index)
      if (call) call.json += data.delta.partial_json
    } else if (event === 'content_block_stop') {
      const call = pending.get(data.index)
      if (!call) continue
      pending.delete(data.index)
      let input: unknown
      try {
        input = JSON.parse(call.json)
      } catch {
        input = undefined
      }
      calls.push({ name: call.name, input })
    }
  }
  return calls
}
