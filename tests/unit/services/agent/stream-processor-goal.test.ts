/**
 * stream-processor forwards the engine's `system` / `goal_updated` frames to
 * the renderer as `agent:goal-updated`, the only way a change the model makes
 * through its Goal tool reaches the UI.
 */

import { describe, it, expect, vi } from 'vitest'

const { emitAgentEvent } = vi.hoisted(() => ({ emitAgentEvent: vi.fn() }))

vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent }))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('../../../../src/main/services/agent/mcp-manager', () => ({ broadcastMcpStatus: vi.fn() }))
vi.mock('../../../../src/main/services/agent/mcp-probe', () => ({ probeUnhealthyServers: vi.fn() }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../../../../src/main/foundation/logging', () => ({ isDeveloperMode: () => false }))

import { processStream } from '../../../../src/main/services/agent/stream-processor'
import type { SessionState } from '../../../../src/main/services/agent/types'

function run(messages: unknown[]) {
  return processStream({
    v2Session: {
      send: vi.fn(),
      stream: () => (async function* () { for (const m of messages) yield m })(),
    },
    sessionState: { sessionId: 's', thoughts: [] } as unknown as SessionState,
    spaceId: 'space-1',
    conversationId: 'conv-1',
    messageContent: 'Hi',
    displayModel: 'm',
    abortController: new AbortController(),
    t0: Date.now(),
    callbacks: {},
  } as unknown as Parameters<typeof processStream>[0])
}

const goal = { objective: 'o', doneWhen: ['c'], status: 'active', updatedBy: 'agent', updatedAt: 't' }

describe('goal_updated forwarding', () => {
  it('emits agent:goal-updated with the goal and its source', async () => {
    await run([
      { type: 'system', subtype: 'init', session_id: 'sess-1', tools: [], mcp_servers: [] },
      { type: 'system', subtype: 'goal_updated', goal, source: 'agent', session_id: 'sess-1' },
      { type: 'system', subtype: 'goal_updated', goal: null, source: 'user', session_id: 'sess-1' },
      { type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'sess-1' },
    ])

    const goalEvents = emitAgentEvent.mock.calls.filter(([channel]) => channel === 'agent:goal-updated')
    expect(goalEvents).toEqual([
      ['agent:goal-updated', 'space-1', 'conv-1', { goal, source: 'agent', seenByModel: true }],
      ['agent:goal-updated', 'space-1', 'conv-1', { goal: null, source: 'user', seenByModel: true }],
    ])
  })
})
