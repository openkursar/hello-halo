import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingQuestion } from '../../../src/renderer/types'

const { answerQuestion } = vi.hoisted(() => ({ answerQuestion: vi.fn() }))
vi.mock('../../../src/renderer/stores/chat/internal', () => ({
  api: { answerQuestion }, PULSE_READ_GRACE_PERIOD_MS: 1000, createEmptySessionState: () => ({})
}))
vi.mock('../../../src/renderer/stores/chat/backend', () => ({ conversationKind: () => 'space', backendFor: () => ({}) }))
vi.mock('../../../src/renderer/stores/chat/backend/cache', () => ({ shedBackgroundDetail: vi.fn() }))
vi.mock('../../../src/renderer/stores/chat/active', () => ({ selectViewedConversationId: () => null }))
vi.mock('../../../src/renderer/stores/chat/task-read', () => ({ readTransition: vi.fn() }))

import { createSessionSlice } from '../../../src/renderer/stores/chat/session'

function fixture() {
  let state = { sessions: new Map<string, { pendingQuestion?: PendingQuestion }>([['c', {
    pendingQuestion: { id: 'first', questions: [], status: 'active' }
  }]]) }
  const get = () => state
  const set = (update: (value: typeof state) => Partial<typeof state>) => { state = { ...state, ...update(state) } }
  const slice = createSessionSlice(set as never, get as never)
  return { get, submit: () => slice.answerQuestion('c', { 'Which scope?': 'DDL only' }),
    next: () => state.sessions.set('c', { pendingQuestion: { id: 'second', questions: [], status: 'active' } }) }
}

beforeEach(() => { answerQuestion.mockReset() })

describe('question submission', () => {
  it('accepts one successful submission and prevents repeated clicks while waiting or answered', async () => {
    let finish!: (value: unknown) => void
    answerQuestion.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const f = fixture()
    const pending = f.submit()
    expect(f.get().sessions.get('c')!.pendingQuestion?.submitting).toBe(true)
    await f.submit()
    expect(answerQuestion).toHaveBeenCalledTimes(1)
    finish({ success: true })
    await pending
    expect(f.get().sessions.get('c')!.pendingQuestion).toMatchObject({ id: 'first', status: 'answered', submitting: false })
    await f.submit()
    expect(answerQuestion).toHaveBeenCalledTimes(1)
  })

  it.each(['rejected', 'network'])('keeps a failed %s submission answerable and allows retry', async failure => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    if (failure === 'network') answerQuestion.mockRejectedValueOnce(new Error('offline'))
    else answerQuestion.mockResolvedValueOnce({ success: false, error: 'not accepted' })
    const f = fixture()
    await f.submit()
    expect(f.get().sessions.get('c')!.pendingQuestion).toMatchObject({ status: 'active', error: true, submitting: false })
    answerQuestion.mockResolvedValueOnce({ success: true })
    await f.submit()
    expect(f.get().sessions.get('c')!.pendingQuestion).toMatchObject({ status: 'answered', error: false })
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it.each([true, false])('never applies the previous submission outcome (%s) to a newer question', async success => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let finish!: (value: unknown) => void
    answerQuestion.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const f = fixture()
    const pending = f.submit()
    f.next()
    finish({ success })
    await pending
    expect(f.get().sessions.get('c')!.pendingQuestion).toEqual({ id: 'second', questions: [], status: 'active' })
    warn.mockRestore()
  })
})
