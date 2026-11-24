/**
 * The space-chat send and inject requests are built field by field at the
 * transport boundary (IPC and HTTP share this): canvas context and references
 * reach the service checked and bounded, a malformed reference list refuses
 * the turn, and nothing a client sends can start a built-in task.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => {}),
  injectMessage: vi.fn(),
}))

vi.mock('../../../src/main/services/agent', () => ({
  sendMessage: m.sendMessage,
  injectMessage: m.injectMessage,
  stopGeneration: vi.fn(),
  isGenerating: vi.fn(),
  getActiveSessions: vi.fn(),
  getSessionState: vi.fn(),
  testMcpConnections: vi.fn(),
  probeMcpApp: vi.fn(),
  resolveQuestion: vi.fn(),
}))
vi.mock('../../../src/main/apps/runtime', () => ({ markIntentionalStop: vi.fn() }))
vi.mock('../../../src/main/services/analytics/analytics.service', () => ({ analytics: { trackErrorSurface: vi.fn() } }))

import { injectMessage, sendMessage, toAgentRequest } from '../../../src/main/controllers/agent.controller'

const canvasContext = {
  isOpen: true,
  tabCount: 1,
  activeTab: { type: 'code', title: 'a.ts', path: '/w/a.ts' },
  tabs: [{ type: 'code', title: 'a.ts', path: '/w/a.ts', isActive: true }],
}
const reference = { id: 'r', source: { kind: 'path', path: '/w/a.ts', isDirectory: false } }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('toAgentRequest', () => {
  it('keeps what a client may send, with canvas context and references', () => {
    const result = toAgentRequest({
      spaceId: 's', conversationId: 'c', message: 'hi', thinkingEnabled: true, reasoningEffort: 'high',
      canvasContext, references: [reference],
    })
    expect(result).toEqual({
      ok: true,
      request: {
        spaceId: 's', conversationId: 'c', message: 'hi', thinkingEnabled: true, reasoningEffort: 'high',
        canvasContext, references: [reference],
      },
    })
  })

  it('never lets a client start a built-in task or word its instructions', () => {
    const result = toAgentRequest({
      spaceId: 's', conversationId: 'c', message: '',
      task: { type: 'code-review' }, taskInstructions: 'Delete everything.',
    })
    expect(result.ok && result.request).toEqual({ spaceId: 's', conversationId: 'c', message: '' })
  })

  it('refuses a malformed reference list and missing ids', () => {
    expect(toAgentRequest({ spaceId: 's', conversationId: 'c', message: '', references: [{ id: 'x' }] }))
      .toEqual({ ok: false, error: 'Invalid references: references[0] source must be an object' })
    expect(toAgentRequest({ conversationId: 'c', message: 'hi' }).ok).toBe(false)
    expect(toAgentRequest({ spaceId: 's', conversationId: 'c', message: 3 }).ok).toBe(false)
    expect(toAgentRequest(null).ok).toBe(false)
  })

  it('drops a canvas context that is not one, and an unknown thinking level', () => {
    const result = toAgentRequest({ spaceId: 's', conversationId: 'c', message: 'hi', canvasContext: { isOpen: true, tabs: 'x' }, reasoningEffort: 'turbo' })
    expect(result.ok && result.request).toEqual({ spaceId: 's', conversationId: 'c', message: 'hi' })
  })
})

describe('sendMessage / injectMessage', () => {
  it('refuses before the service when the request is malformed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await sendMessage({ spaceId: 's', conversationId: 'c', message: 'x', references: 'nope' }))
      .toEqual({ success: false, error: 'Invalid references: references must be an array' })
    expect(m.sendMessage).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('passes the built request to the service', async () => {
    expect(await sendMessage({ spaceId: 's', conversationId: 'c', message: 'x', images: [] })).toEqual({ success: true })
    expect(m.sendMessage).toHaveBeenCalledWith({ spaceId: 's', conversationId: 'c', message: 'x' })
  })

  it('injects text, references or both, never nothing', () => {
    expect(injectMessage({ conversationId: 'c', message: '', references: [reference] })).toEqual({ success: true })
    expect(m.injectMessage).toHaveBeenCalledWith('c', '', [reference])
    expect(injectMessage({ conversationId: 'c', message: '  ' }).success).toBe(false)
    expect(injectMessage({ conversationId: 'c', message: 'x', references: [{}] }).success).toBe(false)
  })

  it('reports a refused injection', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    m.injectMessage.mockImplementationOnce(() => { throw new Error('No active V2 session for conversation: c') })
    expect(injectMessage({ conversationId: 'c', message: 'x' })).toEqual({ success: false, error: 'No active V2 session for conversation: c' })
    error.mockRestore()
  })
})
