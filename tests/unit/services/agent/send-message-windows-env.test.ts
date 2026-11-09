/**
 * On Windows a failed send says the command environment is missing only when
 * Git really is; otherwise the user gets the real reason, as on macOS.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const m = vi.hoisted(() => ({
  addMessage: vi.fn((_s: string, _c: string, msg: Record<string, unknown>) => ({ id: 'msg-1', timestamp: 't', ...msg })),
  updateMessageById: vi.fn(),
  getConversation: vi.fn(() => ({ id: 'conv-1', sessionId: undefined as string | undefined })),
  prepareGoalInput: vi.fn((g: { objective: string; doneWhen?: string[] }) => ({ objective: g.objective.trim(), doneWhen: g.doneWhen ?? [] })),
  setGoalForTurn: vi.fn(),
  acquireV2Session: vi.fn(),
  detectGitBash: vi.fn(() => ({ found: false })),
  stderr: '',
}))

vi.mock('../../../../src/main/services/agent/engine-routing', () => ({
  resolveConversationEngine: async () => 'halo',
  prepareConversationContinuation: (_spaceId: string, _conversationId: string, conversation: { sessionId?: string }, _engine: unknown, options?: { legacySessionId?: string }) => ({ engineId: 'halo', engineState: {}, resumeSessionId: options?.legacySessionId ?? conversation?.sessionId }),
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
  getApiCredentialsForSelection: vi.fn(async () => ({ provider: 'anthropic', model: 'm' })),
  getDbMcpServers: vi.fn(() => null),
}))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitHumanRequest: vi.fn(), emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  getSessionEngineId: () => undefined, isSessionBusy: () => false,
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
  buildUserSessionSdkOptions: vi.fn(async (options: { stderrHandler: (data: string) => void }) => {
    if (m.stderr) options.stderrHandler(m.stderr)
    return {}
  }),
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

vi.mock('../../../../src/main/services/git-bash', () => ({ detectGitBash: m.detectGitBash }))


import { sendMessage } from '../../../../src/main/services/agent/send-message'
import { emitAgentEvent } from '../../../../src/main/services/agent/events'
import { COMMAND_ENVIRONMENT_NOT_INSTALLED_ERROR } from '../../../../src/shared/constants/agent-errors'

const request = { spaceId: 'space-1', conversationId: 'conv-1', message: 'go' }
const realPlatform = process.platform

beforeEach(() => {
  vi.clearAllMocks()
  m.stderr = ''
  m.getConversation.mockReturnValue({ id: 'conv-1', sessionId: undefined })
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform })
})

function reportedError(): unknown {
  const call = vi.mocked(emitAgentEvent).mock.calls.find(([channel]) => channel === 'agent:error')
  return (call?.[3] as { error?: string } | undefined)?.error
}

describe('sendMessage failing on Windows', () => {
  // Asserted right after sendMessage returns: a failure that arrives later
  // would land on the user's next send.
  it('says the command environment is not installed when Git is missing', async () => {
    m.detectGitBash.mockReturnValue({ found: false })
    m.acquireV2Session.mockRejectedValueOnce(new Error('spawn ENOENT'))

    await sendMessage(request)

    expect(reportedError()).toBe(COMMAND_ENVIRONMENT_NOT_INSTALLED_ERROR)
    expect(m.addMessage).toHaveBeenCalledWith('space-1', 'conv-1', expect.objectContaining({ role: 'assistant', error: COMMAND_ENVIRONMENT_NOT_INSTALLED_ERROR }))
    const channels = vi.mocked(emitAgentEvent).mock.calls.map(([channel]) => channel)
    expect(channels.indexOf('agent:error')).toBeLessThan(channels.indexOf('agent:complete'))
  })

  it('shows the real error when Git is present', async () => {
    m.detectGitBash.mockReturnValue({ found: true })
    m.acquireV2Session.mockRejectedValueOnce(new Error('process exited with code 1'))

    await sendMessage(request)

    expect(reportedError()).toBe('process exited with code 1')
    const channels = vi.mocked(emitAgentEvent).mock.calls.map(([channel]) => channel)
    expect(channels.indexOf('agent:error')).toBeLessThan(channels.indexOf('agent:complete'))
  })

  it('shows the invalid MCP configuration from stderr when Git is present', async () => {
    m.detectGitBash.mockReturnValue({ found: true })
    m.stderr = 'Error: Invalid MCP configuration: server "x" has no command\n    at parse (cli.js:1:1)'
    m.acquireV2Session.mockRejectedValueOnce(new Error('process exited with code 1'))

    await sendMessage(request)

    expect(reportedError()).toBe('Error: Invalid MCP configuration: server "x" has no command')
  })
})

describe('sendMessage failing on macOS', () => {
  it('shows the stderr reason without checking for Git', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    m.stderr = 'Error: Invalid MCP configuration: server "x" has no command'
    m.acquireV2Session.mockRejectedValueOnce(new Error('process exited with code 1'))

    await sendMessage(request)

    expect(reportedError()).toBe('Error: Invalid MCP configuration: server "x" has no command')
    expect(m.detectGitBash).not.toHaveBeenCalled()
  })
})
