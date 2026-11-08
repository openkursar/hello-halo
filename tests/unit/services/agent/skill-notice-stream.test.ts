import { describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ emit: vi.fn() }))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: state.emit }))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({ analytics: { track: vi.fn() } }))
vi.mock('../../../../src/main/services/agent/mcp-manager', () => ({ broadcastMcpStatus: vi.fn() }))
vi.mock('../../../../src/main/services/agent/mcp-probe', () => ({ probeUnhealthyServers: vi.fn() }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))
vi.mock('../../../../src/main/foundation/logging', () => ({ isDeveloperMode: () => false }))
import { processStream } from '../../../../src/main/services/agent/stream-processor'
import { withSkillNotice } from '../../../../src/main/services/agent/skill-availability'
import type { SkillNotice } from '../../../../src/shared/types/skills'

describe('skill notice existing event path', () => {
  it.each<SkillNotice>(['catalog-unavailable'])('delivers %s as a system thought without replacing or failing the answer', async notice => {
    state.emit.mockClear()
    const native = {
      send: vi.fn(),
      async *stream() {
        yield { type: 'system', subtype: 'init', session_id: 'session' }
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'normal answer' }] } }
        yield { type: 'result', subtype: 'success', is_error: false, result: 'normal answer' }
      },
    }
    const onRawMessage = vi.fn()
    const result = await processStream({
      v2Session: withSkillNotice(native, notice),
      sessionState: { thoughts: [], spaceId: 'space', conversationId: 'chat', abortController: new AbortController() },
      spaceId: 'space', conversationId: 'chat', messageContent: 'hello', displayModel: 'model',
      abortController: new AbortController(), t0: Date.now(), callbacks: { onRawMessage },
    })
    expect(result.finalContent).toBe('normal answer')
    expect(result.hasErrorThought).toBe(false)
    expect(result.isInterrupted).toBe(false)
    expect(result.thoughts).toContainEqual(expect.objectContaining({ type: 'system', skillNotice: notice }))
    expect(state.emit).toHaveBeenCalledWith('agent:thought', 'space', 'chat', expect.objectContaining({ thought: expect.objectContaining({ type: 'system', skillNotice: notice }) }))
    expect(state.emit.mock.calls.some(call => call[0] === 'agent:error')).toBe(false)
    expect(onRawMessage).toHaveBeenCalledWith({ type: 'system', subtype: 'skill_notice', skillNotice: notice })
  })
})
