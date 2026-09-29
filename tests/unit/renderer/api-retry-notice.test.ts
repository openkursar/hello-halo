/**
 * The retry notice in the renderer: the chat store mirrors main's retry state
 * with a deadline on this client's clock and drops it whenever the turn stops
 * waiting; the notice explains the failure and offers the stop.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create } from 'zustand'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../../../src/renderer/api', () => ({ api: {} }))
vi.mock('../../../src/renderer/services/canvas-lifecycle', () => ({ canvasLifecycle: {} }))
vi.mock('../../../src/renderer/stores/team.store', () => ({ isRemoteMemberAppId: () => false }))
vi.mock('../../../src/renderer/i18n', () => ({
  useTranslation: () => ({
    t: (text: string, params?: Record<string, unknown>) =>
      text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(params?.[key] ?? '')),
  }),
}))

import { createAgentEventsSlice } from '../../../src/renderer/stores/chat/agent-events'
import { createSessionSlice } from '../../../src/renderer/stores/chat/session'
import { createEmptySessionState, type ChatState } from '../../../src/renderer/stores/chat/internal'
import { ApiRetryNotice } from '../../../src/renderer/components/chat/ApiRetryNotice'
import type { ApiRetryState } from '../../../src/shared/types/api-retry'

const retry: ApiRetryState = {
  attempt: 3,
  maxRetries: 10,
  delayMs: 12_000,
  errorStatus: 429,
  errorKind: 'rate_limit',
  errorMessage: 'Go usage limit exceeded',
}

function makeStore() {
  return create<ChatState>((set, get) => ({
    sessions: new Map([['c', { ...createEmptySessionState(), isGenerating: true, isThinking: true }]]),
    ...createAgentEventsSlice(set as never, get as never),
    ...createSessionSlice(set as never, get as never),
  }) as unknown as ChatState)
}

describe('chat store retry state', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fixes the deadline on this client clock when the notice arrives', () => {
    const store = makeStore()
    store.getState().handleAgentApiRetry({ spaceId: 's', conversationId: 'c', retry })
    expect(store.getState().sessions.get('c')!.apiRetry).toEqual({ ...retry, retryAt: 1_012_000 })
  })

  it('clears when requests go through again', () => {
    const store = makeStore()
    store.getState().handleAgentApiRetry({ spaceId: 's', conversationId: 'c', retry })
    store.getState().handleAgentApiRetry({ spaceId: 's', conversationId: 'c', retry: null })
    expect(store.getState().sessions.get('c')!.apiRetry).toBeNull()
  })

  it('leaves the store untouched for a clear with nothing pending', () => {
    const store = makeStore()
    const before = store.getState().sessions
    store.getState().handleAgentApiRetry({ spaceId: 's', conversationId: 'c', retry: null })
    expect(store.getState().sessions).toBe(before)
  })

  it('drops the notice when the turn errors or is stopped', () => {
    const store = makeStore()
    store.getState().handleAgentApiRetry({ spaceId: 's', conversationId: 'c', retry })
    store.getState().handleAgentError({ spaceId: 's', conversationId: 'c', error: 'Go usage limit exceeded' })
    expect(store.getState().sessions.get('c')!.apiRetry).toBeNull()

    store.getState().handleAgentApiRetry({ spaceId: 's', conversationId: 'c', retry })
    store.getState().markSessionStopped('c')
    expect(store.getState().sessions.get('c')!.apiRetry).toBeNull()
  })

  it('starts a new turn without the previous turn\'s notice', () => {
    const store = makeStore()
    store.getState().handleAgentApiRetry({ spaceId: 's', conversationId: 'c', retry })
    store.getState().handleAgentTurnStart({ spaceId: 's', conversationId: 'c' })
    expect(store.getState().sessions.get('c')!.apiRetry).toBeNull()
  })
})

describe('ApiRetryNotice', () => {
  const render = (overrides: Partial<ApiRetryState> = {}, onStop?: () => void) =>
    renderToStaticMarkup(createElement(ApiRetryNotice, {
      retry: { ...retry, ...overrides, retryAt: Date.now() + 12_000 },
      onStop,
    }))

  it('says what failed, why, how long until the next try and which try it is', () => {
    const html = render()
    expect(html).toContain('The model service is limiting requests')
    expect(html).toContain('HTTP 429')
    expect(html).toContain('Go usage limit exceeded')
    expect(html).toContain('Retrying in 12s')
    expect(html).toContain('Attempt 3 of 10')
    expect(html).toContain('role="status"')
  })

  it('names a connection failure as such, with no status badge', () => {
    const html = render({ errorStatus: null, errorKind: 'unknown', errorMessage: 'fetch failed (ECONNREFUSED)' })
    expect(html).toContain('Could not reach the model service')
    expect(html).not.toContain('HTTP ')
  })

  it('names an overloaded service', () => {
    expect(render({ errorStatus: 529, errorKind: 'server_error' })).toContain('The model service is overloaded')
  })

  it('offers Stop only where the surface can stop the turn', () => {
    expect(render({}, () => {})).toContain('>Stop<')
    expect(render()).not.toContain('>Stop<')
  })
})
