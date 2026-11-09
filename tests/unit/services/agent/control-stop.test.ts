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
  withdraw: vi.fn<[], Promise<void>>(),
}))

vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  v2Sessions: m.v2Sessions,
  activeSessions: m.activeSessions,
  closeV2Session: (id: string) => { m.order.push(`closeV2Session:${id}`); m.v2Sessions.delete(id) },
  getConsumerHandle: (id: string) => m.consumers.get(id),
  getRunningConsumerIds: () => [...m.consumers.keys()],
}))
vi.mock('../../../../src/main/services/agent/permission-handler', () => ({ getActivePendingQuestion: () => null }))
vi.mock('../../../../src/main/services/agent/live-turn', () => ({
  withdrawUnreadLiveInput: async (id: string) => { m.order.push(`withdraw:${id}`); await m.withdraw() },
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
  m.withdraw.mockReset()
})

describe('stopGeneration reasons', () => {
  it('does not interrupt a replacement assignment admitted while unread input is being withdrawn', async () => {
    let finishWithdrawal!: () => void
    m.withdraw.mockImplementationOnce(() => new Promise(resolve => { finishWithdrawal = resolve }))
    const session = liveSession('chat')
    const oldTurn = runningConsumer('chat')
    let current = true
    const stopped: string[] = []
    const listener = onUserStop(id => stopped.push(id))
    const stopping = stopGeneration('chat', { reason: 'controller', isCurrent: () => current })
    const newTurn = runningConsumer('chat')
    current = false
    finishWithdrawal()
    await stopping
    listener.dispose()
    expect(session.interrupt).not.toHaveBeenCalled()
    expect(oldTurn.signal.aborted).toBe(false)
    expect(newTurn.signal.aborted).toBe(false)
    expect(stopped).toEqual([])
    expect(m.order).toEqual(['withdraw:chat'])
  })

  it('refuses an outdated controller stop before touching unread input', async () => {
    liveSession('chat')
    const running = runningConsumer('chat')
    await stopGeneration('chat', { reason: 'controller', isCurrent: () => false })
    expect(m.order).toEqual([])
    expect(running.signal.aborted).toBe(false)
  })

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
    const turnAbort = runningConsumer('chat')
    const subs = [
      onUserStop(id => m.order.push(`userStop:${id}`)),
      onUserStopSettled(id => m.order.push(`settled:${id}`)),
    ]
    const stopping = stopGeneration('chat', { reason: 'internal' })
    expect(turnAbort.signal.reason).toBe('internal')
    await stopping
    subs.forEach(sub => sub.dispose())
    expect(m.order).toEqual(['interrupt:chat'])
  })

  it.each(['user', 'internal', 'controller'] as const)('fixes %s on the current turn before native interruption can finish it', async reason => {
    const session = liveSession('chat')
    const original = runningConsumer('chat')
    let replacement: AbortController | undefined
    let release!: () => void
    session.interrupt.mockImplementationOnce(async () => {
      expect(original.signal.aborted).toBe(true)
      expect(original.signal.reason).toBe(reason)
      replacement = runningConsumer('chat')
      await new Promise<void>(resolve => { release = resolve })
    })
    const stopping = stopGeneration('chat', { reason })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    expect(replacement!.signal.aborted).toBe(false)
    release()
    await stopping
    expect(replacement!.signal.aborted).toBe(false)
    expect(original.signal.reason).toBe(reason)
  })

  it('does not replace the original cause when another stop reaches the draining turn', async () => {
    liveSession('chat')
    const original = runningConsumer('chat')
    await stopGeneration('chat', { reason: 'user' })
    await stopGeneration('chat', { reason: 'internal' })
    expect(original.signal.reason).toBe('user')
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

  it('withdraws before interrupting a turn its caller drives itself', async () => {
    liveSession('run')
    const abortController = new AbortController()
    m.activeSessions.set('run', { abortController, thoughts: [] })
    await stopGeneration('run', { reason: 'user' })
    expect(m.order).toEqual(['withdraw:run', 'interrupt:run'])
    expect(abortController.signal.aborted).toBe(true)
    expect(abortController.signal.reason).toBe('user')
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
