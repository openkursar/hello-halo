/**
 * A person's stop withdraws unread live input before the turn is interrupted
 * (or its process closed); a system stop leaves it to run after the turn.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  order: [] as string[],
  v2Sessions: new Map<string, any>(),
  activeSessions: new Map<string, any>(),
  consumers: new Map<string, any>(),
  teamActive: false,
}))

vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  v2Sessions: m.v2Sessions,
  activeSessions: m.activeSessions,
  closeV2Session: (id: string) => { m.order.push(`closeV2Session:${id}`); m.v2Sessions.delete(id) },
  getConsumerHandle: (id: string) => m.consumers.get(id),
  getRunningConsumerIds: () => [...m.consumers.keys()],
}))
vi.mock('../../../../src/main/services/agent/subagent-handler', () => ({ hasActiveTeamTasks: () => m.teamActive }))
vi.mock('../../../../src/main/services/agent/permission-handler', () => ({ getActivePendingQuestion: () => null }))
vi.mock('../../../../src/main/services/agent/live-turn', () => ({
  withdrawUnreadLiveInput: async (id: string) => { m.order.push(`withdraw:${id}`) },
}))

import { onUserStop, onUserStopSettled, stopGeneration } from '../../../../src/main/services/agent/control'

function liveSession(id: string) {
  const session = {
    interrupt: vi.fn(async () => { m.order.push(`interrupt:${id}`) }),
    close: vi.fn(() => { m.order.push(`close:${id}`) }),
  }
  m.v2Sessions.set(id, { session })
  return session
}

function runningConsumer(id: string) {
  const abortController = new AbortController()
  m.consumers.set(id, {
    isRunning: true,
    getActiveSessionState: () => ({ thoughts: [], abortController }),
    getTeamLifecycleThoughts: () => [],
  })
  return abortController
}

beforeEach(() => {
  m.order = []
  m.v2Sessions.clear()
  m.activeSessions.clear()
  m.consumers.clear()
  m.teamActive = false
})

describe('stopGeneration reasons', () => {
  it('announces a person stop, withdraws unread input, interrupts, then reports it settled', async () => {
    liveSession('chat')
    const turnAbort = runningConsumer('chat')
    const subs = [
      onUserStop(id => m.order.push(`userStop:${id}`)),
      onUserStopSettled(id => m.order.push(`settled:${id}`)),
    ]
    await stopGeneration('chat', { reason: 'user' })
    subs.forEach(sub => sub.dispose())
    expect(m.order).toEqual(['userStop:chat', 'withdraw:chat', 'interrupt:chat', 'settled:chat'])
    expect(turnAbort.signal.aborted).toBe(true)
  })

  it('leaves unread input to run after a system stop', async () => {
    liveSession('chat')
    runningConsumer('chat')
    const subs = [
      onUserStop(id => m.order.push(`userStop:${id}`)),
      onUserStopSettled(id => m.order.push(`settled:${id}`)),
    ]
    await stopGeneration('chat', { reason: 'internal' })
    subs.forEach(sub => sub.dispose())
    expect(m.order).toEqual(['interrupt:chat'])
  })

  it('reports a person stop settled even when interrupting fails', async () => {
    const session = liveSession('chat')
    session.interrupt.mockRejectedValueOnce(new Error('transport gone'))
    runningConsumer('chat')
    const settled: string[] = []
    const sub = onUserStopSettled(id => settled.push(id))
    await stopGeneration('chat', { reason: 'user' })
    sub.dispose()
    expect(settled).toEqual(['chat'])
  })

  it('withdraws before closing the process of a turn with team agents', async () => {
    liveSession('lead')
    runningConsumer('lead')
    m.teamActive = true
    await stopGeneration('lead', { reason: 'user' })
    expect(m.order).toEqual(['withdraw:lead', 'close:lead', 'closeV2Session:lead'])
  })

  it('withdraws before interrupting a turn its caller drives itself', async () => {
    liveSession('run')
    const abortController = new AbortController()
    m.activeSessions.set('run', { abortController, thoughts: [] })
    await stopGeneration('run', { reason: 'user' })
    expect(m.order).toEqual(['withdraw:run', 'interrupt:run'])
    expect(abortController.signal.aborted).toBe(true)
  })

  it('announces and withdraws every conversation when stopping all', async () => {
    liveSession('a')
    m.activeSessions.set('b', { abortController: new AbortController(), thoughts: [] })
    const stopped: string[] = []
    const settled: string[] = []
    const subs = [onUserStop(id => stopped.push(id)), onUserStopSettled(id => settled.push(id))]
    await stopGeneration(undefined, { reason: 'user' })
    subs.forEach(sub => sub.dispose())
    expect(stopped.sort()).toEqual(['a', 'b'])
    expect(settled.sort()).toEqual(['a', 'b'])
    expect(m.order.filter(step => step.startsWith('withdraw:')).sort()).toEqual(['withdraw:a', 'withdraw:b'])
    expect(m.order.indexOf('withdraw:a')).toBeLessThan(m.order.indexOf('closeV2Session:a'))
  })

  it('announces a person stop even when the engine holds nothing for the conversation', async () => {
    const stopped: string[] = []
    const sub = onUserStop(id => stopped.push(id))
    await stopGeneration('idle-chat', { reason: 'user' })
    sub.dispose()
    expect(stopped).toEqual(['idle-chat'])
  })
})
