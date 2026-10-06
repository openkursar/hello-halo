/**
 * A space chat whose working directory is gone: the error event names the
 * folder and the space, which the chat shows with a change-folder button.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  addMessage: vi.fn((_s: string, _c: string, msg: Record<string, unknown>) => ({ id: 'msg-1', timestamp: 't', ...msg })),
  updateMessageById: vi.fn(),
  getConversation: vi.fn(() => ({ id: 'conv-1', sessionId: undefined as string | undefined })),
  prepareGoalInput: vi.fn((g: { objective: string; doneWhen?: string[] }) => ({ objective: g.objective.trim(), doneWhen: g.doneWhen ?? [] })),
  setGoalForTurn: vi.fn(),
  acquireV2Session: vi.fn(),
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
  acquireV2Session: m.acquireV2Session,
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
vi.mock('../../../../src/main/services/agent/reasoning-effort', () => ({ applyReasoningEffort: vi.fn(() => 0), pickReasoningEffort: vi.fn(() => undefined) }))
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
import { emitAgentEvent } from '../../../../src/main/services/agent/events'
import { WorkingDirectoryUnavailableError } from '../../../../src/main/services/agent/working-dir'

const request = { spaceId: 'space-1', conversationId: 'conv-1', message: 'go' }

beforeEach(() => {
  vi.clearAllMocks()
  m.getConversation.mockReturnValue({ id: 'conv-1', sessionId: undefined })
})

describe('sendMessage in a workspace whose folder is gone', () => {
  it('reports the folder with the error so the chat can offer to change it', async () => {
    m.acquireV2Session.mockRejectedValueOnce(new WorkingDirectoryUnavailableError('/Users/me/Desktop/Halo folder', 'space-1'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await sendMessage(request)

    expect(emitAgentEvent).toHaveBeenCalledWith('agent:error', 'space-1', 'conv-1', expect.objectContaining({
      type: 'error',
      errorType: 'working_dir_unavailable',
      workDirIssue: { spaceId: 'space-1', workDir: '/Users/me/Desktop/Halo folder' },
    }))
  })

  it('adds nothing to any other failure', async () => {
    m.acquireV2Session.mockRejectedValueOnce(new Error('spawn failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await sendMessage(request)

    const [, , , data] = vi.mocked(emitAgentEvent).mock.calls.find(([channel]) => channel === 'agent:error')!
    expect(data).not.toHaveProperty('errorType')
    expect(data).not.toHaveProperty('workDirIssue')
  })
})
