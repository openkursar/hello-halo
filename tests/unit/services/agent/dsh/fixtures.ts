/**
 * Synthetic dsh notification sequences.
 *
 * Built from the harness's own type definitions — `SessionEventMap` in
 * `@deepseek-ai/dsh-session`, `StreamChunk`/`ContentBlock` in
 * `@deepseek-ai/dsh-llm`, and the notification payloads in
 * `@deepseek-ai/dsh-sdk-protocol` — and ordered the way `dsh-agent-loop`
 * appends them: `turn/start` → `step/start` → `user/message` → chunks →
 * `assistant/message` → `tool/call` → `tool/result` → `step/end` → `turn/end`.
 */

import type { DshNotification } from '../../../../../src/main/services/agent/dsh/types'

let seq = 0

function nextSeq(): number {
  return ++seq
}

export function sessionEvent(sessionId: string, type: string, data: Record<string, unknown> = {}): DshNotification {
  return {
    method: 'session.event',
    payload: { sessionId, event: { type, seq: nextSeq(), time: 0, data } },
  }
}

export function sessionStatus(sessionId: string, status: 'idle' | 'running'): DshNotification {
  return { method: 'session.status', payload: { sessionId, status } }
}

export function inboxReceipt(sessionId: string, messageId: string): DshNotification {
  return sessionEvent(sessionId, 'agent/inbox/spliced', {
    target: 'next-turn',
    start: 0,
    inserted: [{ id: messageId, role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
  })
}

export function subagentStarted(parentSessionId: string, childSessionId: string): DshNotification {
  return { method: 'subagent.started', payload: { parentSessionId, childSessionId } }
}

export function subagentFinished(
  parentSessionId: string,
  childSessionId: string,
  status: 'ok' | 'error' = 'ok',
  stopReason = 'completed',
): DshNotification {
  return {
    method: 'subagent.finished',
    payload: { provider: 'local', agentId: childSessionId, parentSessionId, childSessionId, status, stopReason },
  }
}

export function chunk(sessionId: string, turn: number, step: number, value: Record<string, unknown>): DshNotification {
  return sessionEvent(sessionId, 'assistant/chunk', { turn, step, chunk: value })
}

export function assistantMessage(
  sessionId: string,
  turn: number,
  step: number,
  content: unknown[],
  usage?: Record<string, number>,
): DshNotification {
  return sessionEvent(sessionId, 'assistant/message', {
    turn,
    step,
    message: { id: `m-${turn}-${step}`, role: 'assistant', content, source: { kind: 'model' } },
    ...(usage ? { usage } : {}),
  })
}

export function toolCall(
  sessionId: string,
  turn: number,
  step: number,
  callId: string,
  name: string,
  args: string,
): DshNotification {
  return sessionEvent(sessionId, 'tool/call', { turn, step, callId, name, arguments: args })
}

export function toolResult(
  sessionId: string,
  turn: number,
  step: number,
  callId: string,
  text: string,
  isError = false,
): DshNotification {
  return sessionEvent(sessionId, 'tool/result', {
    turn,
    step,
    message: {
      id: `r-${callId}`,
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }],
      source: { kind: 'tool', callId },
    },
    ...(isError ? { error: { name: 'ToolError', code: 'FAILED' } } : {}),
  })
}

/** One text-only model call, streamed token by token. */
export function textTurn(sessionId: string): DshNotification[] {
  return [
    sessionEvent(sessionId, 'turn/start', { turn: 1 }),
    sessionEvent(sessionId, 'step/start', { turn: 1, step: 1 }),
    chunk(sessionId, 1, 1, { type: 'block-start', index: 0, blockType: 'text' }),
    chunk(sessionId, 1, 1, { type: 'text-delta', index: 0, text: 'Hello' }),
    chunk(sessionId, 1, 1, { type: 'text-delta', index: 0, text: ' world' }),
    chunk(sessionId, 1, 1, { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } }),
    chunk(sessionId, 1, 1, { type: 'usage', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 } }),
    chunk(sessionId, 1, 1, { type: 'finish', reason: { kind: 'stop' } }),
    assistantMessage(sessionId, 1, 1, [{ type: 'text', text: 'Hello world' }], {
      inputTokens: 10, outputTokens: 4, cacheReadTokens: 2,
    }),
    sessionEvent(sessionId, 'step/end', { turn: 1, step: 1 }),
    sessionEvent(sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}

/** One model call that streams reasoning, then a tool call, then its result. */
export function toolTurn(sessionId: string, callId = 'call-1'): DshNotification[] {
  return [
    sessionEvent(sessionId, 'turn/start', { turn: 1 }),
    sessionEvent(sessionId, 'step/start', { turn: 1, step: 1 }),
    chunk(sessionId, 1, 1, { type: 'block-start', index: 0, blockType: 'reasoning' }),
    chunk(sessionId, 1, 1, { type: 'reasoning-delta', index: 0, text: 'need to list files' }),
    chunk(sessionId, 1, 1, { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'need to list files' } }),
    chunk(sessionId, 1, 1, { type: 'block-start', index: 1, blockType: 'tool-call' }),
    chunk(sessionId, 1, 1, { type: 'tool-call-delta', index: 1, id: callId, name: 'bash', argumentsDelta: '{"command"' }),
    chunk(sessionId, 1, 1, { type: 'tool-call-delta', index: 1, id: callId, argumentsDelta: ':"ls"}' }),
    chunk(sessionId, 1, 1, {
      type: 'block-end',
      index: 1,
      block: { type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"ls"}' },
    }),
    chunk(sessionId, 1, 1, { type: 'finish', reason: { kind: 'tool-calls' } }),
    assistantMessage(sessionId, 1, 1, [
      { type: 'reasoning', text: 'need to list files' },
      { type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"ls"}' },
    ]),
    toolCall(sessionId, 1, 1, callId, 'bash', '{"command":"ls"}'),
    toolResult(sessionId, 1, 1, callId, 'README.md'),
    sessionEvent(sessionId, 'step/end', { turn: 1, step: 1 }),
    sessionEvent(sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
}
