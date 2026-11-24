import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  sessions: new Map<string, any>(), active: new Map<string, any>(),
  running: true, pending: false, addMessage: vi.fn(), updateMessageById: vi.fn(), emit: vi.fn(),
}))
vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  v2Sessions: state.sessions, activeSessions: state.active,
  getConsumerHandle: () => ({ isRunning: state.running, getActiveSessionState: () => state.running ? {} : null }),
  hasPendingSessionInput: () => state.pending,
}))
vi.mock('../../../../src/main/services/conversation.service', () => ({ addMessage: state.addMessage, updateMessageById: state.updateMessageById }))
vi.mock('../../../../src/main/services/agent/helpers', () => ({ getWorkingDir: () => '/tmp' }))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: state.emit }))
import { hasLiveTurn, sendIntoLiveTurn, withdrawUnreadLiveInput } from '../../../../src/main/services/agent/live-turn'
import { injectMessage } from '../../../../src/main/services/agent/inject-message'

const keep = { onWithdrawn: () => {} }

beforeEach(() => {
  state.sessions.clear()
  state.active.clear()
  state.running = true
  state.pending = false
  state.addMessage.mockReset()
  state.updateMessageById.mockReset()
  state.emit.mockReset()
})

describe('live input acceptance', () => {
  it('joins the running turn even while a rebuild is deferred to the turn end', () => {
    const send = vi.fn((_message: any, _options: any) => true)
    state.sessions.set('chat', { session: { sendIntoLiveTurn: send } })
    expect(sendIntoLiveTurn('chat', 'message', undefined, keep)).toBe(true)
    expect(send).toHaveBeenCalledWith('message', { onWithdrawn: expect.any(Function) })
  })

  it('keeps a pending continuation live between consumer turns', () => {
    state.running = false
    state.pending = true
    expect(hasLiveTurn('chat')).toBe(true)
  })

  it('preserves images in the accepted SDK message', () => {
    const send = vi.fn((_message: any, _options: any) => true)
    state.sessions.set('chat', { session: { sendIntoLiveTurn: send } })
    expect(sendIntoLiveTurn('chat', 'look', [{ id: 'image', mediaType: 'image/png', data: 'aW1hZ2U=' }] as any, keep)).toBe(true)
    expect(send.mock.calls[0][0].message.content).toEqual([
      { type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
    ])
  })

  it('keeps success after native acceptance when recording fails, avoiding duplicate fallback', () => {
    const send = vi.fn((_message: any, _options: any) => true)
    state.sessions.set('chat', { spaceId: 'space', session: { sendIntoLiveTurn: send } })
    state.addMessage.mockImplementationOnce(() => { throw new Error('disk unavailable') })
    expect(() => injectMessage('chat', 'accepted')).not.toThrow()
    expect(send).toHaveBeenCalledOnce()
  })

  it('does not persist a refused UI injection, so its normal-send fallback records it once', () => {
    state.sessions.set('chat', { spaceId: 'space', session: { sendIntoLiveTurn: () => false } })
    expect(() => injectMessage('chat', 'late')).toThrow('normal send entry')
    expect(state.addMessage).not.toHaveBeenCalled()
  })
})

describe('live input withdrawal', () => {
  /** A session whose withdrawal takes back every input accepted so far. */
  function withdrawingSession() {
    const accepted: Array<{ onWithdrawn?: () => void }> = []
    const session = {
      sendIntoLiveTurn: (_message: unknown, options?: { onWithdrawn?: () => void }) => { accepted.push(options ?? {}); return true },
      withdrawUnreadInput: vi.fn(async () => {
        const taken = accepted.splice(0)
        for (const input of taken) input.onWithdrawn?.()
        return taken.length
      }),
    }
    return session
  }

  it("calls the sender's handler when a stop withdraws its input", async () => {
    const session = withdrawingSession()
    state.sessions.set('chat', { spaceId: 'space', session })
    const onWithdrawn = vi.fn()
    sendIntoLiveTurn('chat', 'stopped', undefined, { onWithdrawn })
    await withdrawUnreadLiveInput('chat')
    expect(session.withdrawUnreadInput).toHaveBeenCalledOnce()
    expect(onWithdrawn).toHaveBeenCalledOnce()
  })

  it('isolates a failing handler from the rest of the stop', async () => {
    const session = withdrawingSession()
    state.sessions.set('chat', { spaceId: 'space', session })
    const second = vi.fn()
    sendIntoLiveTurn('chat', 'first', undefined, { onWithdrawn: () => { throw new Error('handler broke') } })
    sendIntoLiveTurn('chat', 'second', undefined, { onWithdrawn: second })
    await expect(withdrawUnreadLiveInput('chat')).resolves.toBeUndefined()
    expect(second).toHaveBeenCalledOnce()
  })

  it('tolerates an engine without withdrawal and a withdrawal that fails', async () => {
    state.sessions.set('plain', { session: { sendIntoLiveTurn: () => true } })
    await expect(withdrawUnreadLiveInput('plain')).resolves.toBeUndefined()
    state.sessions.set('broken', { session: { withdrawUnreadInput: async () => { throw new Error('transport gone') } } })
    await expect(withdrawUnreadLiveInput('broken')).resolves.toBeUndefined()
    await expect(withdrawUnreadLiveInput('missing')).resolves.toBeUndefined()
  })

  it("marks a person's withdrawn injection stopped and announces it", async () => {
    const session = withdrawingSession()
    state.sessions.set('chat', { spaceId: 'space', session })
    const recorded = { id: 'm1', role: 'user', content: 'wait', source: 'injection', timestamp: 't', metadata: { references: [] } }
    state.addMessage.mockReturnValueOnce(recorded)
    state.updateMessageById.mockImplementationOnce((_space, _chat, _id, patch) => ({ ...recorded, ...patch }))
    injectMessage('chat', 'wait')
    await withdrawUnreadLiveInput('chat')
    expect(state.updateMessageById).toHaveBeenCalledWith('space', 'chat', 'm1', { metadata: { references: [], inputOutcome: 'stopped' } })
    expect(state.emit).toHaveBeenLastCalledWith('agent:input-stopped', 'space', 'chat', {
      messages: [{ ...recorded, metadata: { references: [], inputOutcome: 'stopped' } }],
    })
  })

  it('skips the mark when the injection record is gone', async () => {
    const session = withdrawingSession()
    state.sessions.set('chat', { spaceId: 'space', session })
    state.addMessage.mockReturnValueOnce({ id: 'm1', role: 'user', content: 'wait', source: 'injection', timestamp: 't' })
    state.updateMessageById.mockReturnValueOnce(null)
    injectMessage('chat', 'wait')
    state.emit.mockClear()
    await withdrawUnreadLiveInput('chat')
    expect(state.emit).not.toHaveBeenCalled()
  })
})
