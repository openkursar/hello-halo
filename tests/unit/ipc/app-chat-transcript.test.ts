/**
 * app:chat-transcript / app:chat-message-thoughts: the desktop entry to the
 * paged digital-human transcript. The runtime loaders are stubbed; what is
 * checked is space resolution, the default-session fallback and the envelope.
 */

import { beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: any[]) => Promise<any>>,
  loadChatTranscriptForConversation: vi.fn(),
  loadChatMessageThoughts: vi.fn(),
  respondToEscalation: vi.fn(),
  space: { id: 'space-a', path: '/spaces/a' } as { id: string; path: string } | null,
}))

vi.mock('electron', () => ({ shell: {} }))
vi.mock('../../../src/main/apps/manager', () => ({ getAppManager: () => null }))
vi.mock('../../../src/main/apps/manager/errors', () => ({ AppAlreadyInstalledError: class extends Error {}, McpCommandBlockedError: class extends Error {} }))
vi.mock('../../../src/main/services/security-policy', () => ({ MCP_COMMAND_BLOCKED_MESSAGE: '' }))
vi.mock('../../../src/main/apps/manager/skill-sync', () => ({ getSkillDir: vi.fn() }))
vi.mock('../../../src/main/apps/spec/skill-identity', () => ({ deriveSkillCommandName: vi.fn() }))
vi.mock('../../../src/main/apps/skill-discovery', () => ({ listAvailableSkills: vi.fn() }))
vi.mock('../../../src/main/apps/runtime', async () => ({
  EscalationAnswerValidationError: (await import('../../../src/main/apps/runtime/errors')).EscalationAnswerValidationError,
  getAppRuntime: () => ({ respondToEscalation: env.respondToEscalation }),
  getAppChatConversationId: (appId: string) => `app-chat:${appId}`,
  loadChatTranscriptForConversation: (...args: unknown[]) => env.loadChatTranscriptForConversation(...args),
  loadChatMessageThoughts: (...args: unknown[]) => env.loadChatMessageThoughts(...args),
}))
vi.mock('../../../src/main/services/space.service', () => ({ getSpace: () => env.space }))
vi.mock('../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../src/main/controllers/app.controller', () => ({}))
vi.mock('../../../src/main/services/analytics/analytics.service', () => ({ analytics: {} }))
vi.mock('../../../src/main/ipc/rpc', () => ({ registerRawRpcHandlers: (_c: unknown, impl: any) => { env.handlers = impl } }))

import { registerAppHandlers } from '../../../src/main/ipc/app'
import { EscalationAnswerValidationError } from '../../../src/main/apps/runtime/errors'

const EMPTY = { messages: [], hasMoreBefore: false, cursor: null, total: 0 }

beforeEach(() => {
  env.space = { id: 'space-a', path: '/spaces/a' }
  env.loadChatTranscriptForConversation.mockReset().mockReturnValue({ messages: [{ id: 'session-msg-1' }], hasMoreBefore: false, cursor: 'session-msg-1', total: 1 })
  env.loadChatMessageThoughts.mockReset().mockReturnValue([{ id: 't' }])
  env.respondToEscalation.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  registerAppHandlers()
})

it('reads the default session when no conversationId is given, passing the paging request', async () => {
  const res = await env.handlers.appChatTranscript({ appId: 'a1', spaceId: 'space-a', before: 'session-msg-9', limit: 20 })
  expect(res.success).toBe(true)
  expect(res.data.messages).toHaveLength(1)
  expect(env.loadChatTranscriptForConversation).toHaveBeenCalledWith('/spaces/a', 'a1', 'app-chat:a1', { before: 'session-msg-9', limit: 20 })
})

it('reads a specific session when addressed', async () => {
  await env.handlers.appChatTranscript({ appId: 'a1', spaceId: 'space-a', conversationId: 'app-chat:a1:local:direct:x' })
  expect(env.loadChatTranscriptForConversation.mock.calls[0][2]).toBe('app-chat:a1:local:direct:x')
})

it('answers an empty page when the space is unknown', async () => {
  env.space = null
  expect(await env.handlers.appChatTranscript({ appId: 'a1', spaceId: 'gone' })).toEqual({ success: true, data: EMPTY })
  expect(env.loadChatTranscriptForConversation).not.toHaveBeenCalled()
})

it('reports a reader failure in the envelope', async () => {
  env.loadChatTranscriptForConversation.mockImplementation(() => { throw new Error('boom') })
  expect(await env.handlers.appChatTranscript({ appId: 'a1', spaceId: 'space-a' })).toEqual({ success: false, error: 'boom' })
})

it('loads one message thought process, defaulting to the default session', async () => {
  const res = await env.handlers.appChatMessageThoughts({ appId: 'a1', spaceId: 'space-a', messageId: 'session-msg-4' })
  expect(res).toEqual({ success: true, data: [{ id: 't' }] })
  expect(env.loadChatMessageThoughts).toHaveBeenCalledWith('/spaces/a', 'a1', 'app-chat:a1', 'session-msg-4')
})

it('answers no thoughts when the space is unknown', async () => {
  env.space = null
  expect(await env.handlers.appChatMessageThoughts({ appId: 'a1', spaceId: 'gone', messageId: 'm' })).toEqual({ success: true, data: [] })
})

it('returns an already-logged decision validation refusal without logging it twice', async () => {
  env.respondToEscalation.mockRejectedValue(new EscalationAnswerValidationError('Answer every question before submitting'))
  const response = { ts: 1, text: '' }
  expect(await env.handlers.appRespondEscalation({ appId: 'a1', escalationId: 'q1', response })).toEqual({
    success: false, error: 'Answer every question before submitting',
  })
  expect(env.respondToEscalation).toHaveBeenCalledWith('a1', 'q1', response)
  expect(console.error).not.toHaveBeenCalled()
})

it('logs other decision failures with the app and entry, without the submitted answer', async () => {
  env.respondToEscalation.mockRejectedValue(new Error('Database unavailable'))
  expect(await env.handlers.appRespondEscalation({ appId: 'a1', escalationId: 'q1', response: { ts: 1, text: 'private-answer' } })).toEqual({
    success: false, error: 'Database unavailable',
  })
  expect(console.error).toHaveBeenCalledTimes(1)
  expect(console.error).toHaveBeenCalledWith(
    '[AppIPC] app:respond-escalation error: appId=a1, entryId=q1', 'Database unavailable',
  )
})
