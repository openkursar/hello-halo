/**
 * The consumer tracks CC tasks between task_started and task_notification, so a
 * session whose background work has not reported back is not evicted.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../../src/main/services/agent/stream-processor', () => ({ processStream: vi.fn() }))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  createSessionState: vi.fn(),
  consumePendingRebuild: vi.fn(() => false),
  markTurnInitReceived: vi.fn(),
}))

const { trackTaskLifecycle } = await import('../../../../src/main/services/agent/session-consumer')

const started = (taskId: string) => ({ type: 'system', subtype: 'task_started', task_id: taskId })
const notified = (taskId: string, status = 'completed') => ({ type: 'system', subtype: 'task_notification', task_id: taskId, status })

describe('trackTaskLifecycle', () => {
  it('holds a task from task_started until its task_notification, whatever the status', () => {
    const running = new Set<string>()
    trackTaskLifecycle(running, started('a'))
    trackTaskLifecycle(running, started('b'))
    expect([...running]).toEqual(['a', 'b'])

    trackTaskLifecycle(running, notified('a', 'failed'))
    trackTaskLifecycle(running, notified('b', 'stopped'))
    expect(running.size).toBe(0)
  })

  it('ignores progress, other messages and malformed input', () => {
    const running = new Set<string>()
    trackTaskLifecycle(running, { type: 'system', subtype: 'task_progress', task_id: 'a' })
    trackTaskLifecycle(running, { type: 'assistant', subtype: 'task_started', task_id: 'a' })
    trackTaskLifecycle(running, { type: 'system', subtype: 'task_started' })
    trackTaskLifecycle(running, null)
    expect(running.size).toBe(0)
  })

  it('tolerates a notification for a task it never saw start', () => {
    const running = new Set<string>(['a'])
    trackTaskLifecycle(running, notified('unknown'))
    expect([...running]).toEqual(['a'])
  })
})
