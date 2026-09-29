/**
 * sendMessage with a goal attached: a refused goal leaves no trace in the
 * conversation, a goal is set on the session receiving the turn, and a send
 * that fails before its goal was set does not keep claiming it on the message.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  addMessage: vi.fn((_s: string, _c: string, msg: Record<string, unknown>) => ({ id: 'msg-1', timestamp: 't', ...msg })),
  updateMessageById: vi.fn(),
  getConversation: vi.fn(() => ({ id: 'conv-1', sessionId: undefined as string | undefined })),
  prepareGoalInput: vi.fn((g: { objective: string; doneWhen?: string[] }) => ({ objective: g.objective.trim(), doneWhen: g.doneWhen ?? [] })),
  setGoalForTurn: vi.fn(),
  getOrCreateV2Session: vi.fn(),
}))

vi.mock('../../../../src/main/foundation/config.service', () => ({ getConfig: () => ({ agent: {} }) }))
vi.mock('../../../../src/main/services/conversation.service', () => ({
  addMessage: m.addMessage,
  updateMessageById: m.updateMessageById,
  getConversation: m.getConversation,
}))
vi.mock('../../../../src/main/services/agent/toolsets/broker', () => ({
  buildCreationTimeServers: vi.fn(() => ({})),
  openToolset: vi.fn(() => ({ ok: true })),
}))
vi.mock('../../../../src/main/services/agent/toolsets/capability-index', () => ({ buildToolsetSection: vi.fn(() => '') }))
vi.mock('../../../../src/main/services/agent/toolsets/state', () => ({ getOpenToolsets: vi.fn(() => new Set()) }))
vi.mock('../../../../src/main/services/api-ref', () => ({ HALO_API_TOOLSET_ID: 'halo-api-ref' }))
vi.mock('../../../../src/main/services/tlon', () => ({ getKBChatContext: vi.fn(() => null) }))
vi.mock('../../../../src/main/services/agent/knowledge-context', () => ({
  resolveConversationKnowledgeBases: vi.fn(() => []),
  resolveConversationKnowledgeBaseIds: vi.fn(() => []),
}))
vi.mock('../../../../src/main/services/agent/helpers', () => ({
  getHeadlessElectronPath: vi.fn(() => '/electron'),
  getWorkingDir: vi.fn(() => '/work'),
  getApiCredentialsForConversation: vi.fn(async () => ({ provider: 'anthropic', model: 'm' })),
  getDbMcpServers: vi.fn(() => null),
}))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  getOrCreateV2Session: m.getOrCreateV2Session,
  closeV2Session: vi.fn(),
  updateConsumerDisplayModel: vi.fn(),
  markTurnDispatched: vi.fn(),
}))
vi.mock('../../../../src/main/services/agent/message-utils', () => ({
  formatCanvasContext: vi.fn(() => ''),
  buildMessageContent: vi.fn((text: string) => text),
}))
vi.mock('../../../../src/main/services/agent/image-attachments', () => ({
  prepareNonVisionImageFallback: vi.fn(() => null),
  OCR_TOOLSET_ID: 'ocr',
}))
vi.mock('../../../../src/main/services/agent/sdk-config', () => ({
  resolveCredentialsForSdk: vi.fn(async () => ({ displayModel: 'm', capabilities: {} })),
  buildUserSessionSdkOptions: vi.fn(async () => ({})),
}))
vi.mock('../../../../src/main/services/agent/space-memory', () => ({
  resolveSpaceMemorySession: vi.fn(() => null),
  buildSpaceMemoryPreamble: vi.fn(async () => ''),
}))
vi.mock('../../../../src/main/services/agent/reasoning-effort', () => ({ applyReasoningEffort: vi.fn(() => 0) }))
vi.mock('../../../../src/main/services/agent/conversation-sink', () => ({ createConversationSink: vi.fn() }))
vi.mock('../../../../src/main/services/agent/goal', () => ({
  prepareGoalInput: m.prepareGoalInput,
  setGoalForTurn: m.setGoalForTurn,
}))
vi.mock('../../../../src/main/services/health', () => ({
  onAgentError: vi.fn(),
  runPpidScanAndCleanup: vi.fn(async () => {}),
}))
vi.mock('../../../../src/main/services/agent/stream-processor', () => ({ flushToolStats: vi.fn() }))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({ analytics: { track: vi.fn(async () => {}), trackErrorSurface: vi.fn() } }))

import { sendMessage } from '../../../../src/main/services/agent/send-message'

const request = { spaceId: 'space-1', conversationId: 'conv-1', message: 'go', goal: { objective: ' Ship ' } }

beforeEach(() => {
  vi.clearAllMocks()
  m.getConversation.mockReturnValue({ id: 'conv-1', sessionId: undefined })
})

describe('sendMessage with a goal', () => {
  it('refuses an invalid goal before recording the message', async () => {
    m.prepareGoalInput.mockImplementationOnce(() => { throw new TypeError('blank') })

    await expect(sendMessage({ ...request, goal: { objective: '' } })).rejects.toThrow('blank')
    expect(m.addMessage).not.toHaveBeenCalled()
  })

  it('records the goal on the message and sets it on the session receiving the turn', async () => {
    const session = { send: vi.fn(async () => {}) }
    m.getOrCreateV2Session.mockResolvedValueOnce(session)

    await sendMessage(request)

    expect(m.addMessage.mock.calls[0][2].metadata).toEqual({ goal: { objective: 'Ship', doneWhen: [] } })
    expect(m.setGoalForTurn).toHaveBeenCalledWith('space-1', 'conv-1', session, { objective: 'Ship', doneWhen: [] }, false)
    expect(m.updateMessageById).not.toHaveBeenCalled()
  })

  it('drops the goal from the message when the session cannot be created', async () => {
    m.getOrCreateV2Session.mockRejectedValueOnce(new Error('spawn failed'))

    await sendMessage(request)

    expect(m.setGoalForTurn).not.toHaveBeenCalled()
    expect(m.updateMessageById).toHaveBeenCalledWith('space-1', 'conv-1', 'msg-1', { metadata: {} })
  })
})
