/**
 * sendMessage with references and a built-in task: the transcript keeps the
 * records, the model reads them expanded ahead of the text, in a fixed order.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  addMessage: vi.fn((_s: string, _c: string, msg: Record<string, unknown>) => ({ id: 'msg-1', timestamp: 't', ...msg })),
  getConversation: vi.fn(() => ({ id: 'conv-1', sessionId: undefined as string | undefined })),
  getOrCreateV2Session: vi.fn(),
  prepareNonVisionImageFallback: vi.fn(() => null as null | { contextBlock: string; filePaths: string[] }),
}))

vi.mock('../../../../src/main/foundation/config.service', () => ({ getConfig: () => ({ agent: {} }) }))
vi.mock('../../../../src/main/services/conversation.service', () => ({
  addMessage: m.addMessage,
  updateMessageById: vi.fn(),
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
  formatCanvasContext: vi.fn(() => '<halo_canvas>c</halo_canvas>\n\n'),
  buildMessageContent: vi.fn((text: string) => text),
}))
vi.mock('../../../../src/main/services/agent/image-attachments', () => ({
  prepareNonVisionImageFallback: m.prepareNonVisionImageFallback,
  OCR_TOOLSET_ID: 'ocr',
}))
vi.mock('../../../../src/main/services/agent/sdk-config', () => ({
  resolveCredentialsForSdk: vi.fn(async () => ({ displayModel: 'm', capabilities: {} })),
  buildUserSessionSdkOptions: vi.fn(async () => ({})),
}))
vi.mock('../../../../src/main/services/agent/space-memory', () => ({
  resolveSpaceMemorySession: vi.fn(() => ({ layout: {}, contextKey: 'k' })),
  buildSpaceMemoryPreamble: vi.fn(async () => '<memory/>\n\n'),
}))
vi.mock('../../../../src/main/services/agent/reasoning-effort', () => ({ applyReasoningEffort: vi.fn(() => 0), pickReasoningEffort: vi.fn(() => undefined) }))
vi.mock('../../../../src/main/services/agent/conversation-sink', () => ({ createConversationSink: vi.fn() }))
vi.mock('../../../../src/main/services/agent/goal', () => ({ prepareGoalInput: vi.fn(), setGoalForTurn: vi.fn() }))
vi.mock('../../../../src/main/services/health', () => ({ onAgentError: vi.fn(), runPpidScanAndCleanup: vi.fn(async () => {}) }))
vi.mock('../../../../src/main/services/agent/stream-processor', () => ({ flushToolStats: vi.fn() }))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({ analytics: { track: vi.fn(async () => {}), trackErrorSurface: vi.fn() } }))

import { sendMessage } from '../../../../src/main/services/agent/send-message'
import type { ContentReference } from '../../../../src/shared/types/content-reference'
import type { CodeReviewTask } from '../../../../src/shared/types/message-task'

const references: ContentReference[] = [
  { id: 'r1', source: { kind: 'file', path: '/work/src/a.ts', precision: 'lines' }, range: { startLine: 2, endLine: 3 }, note: 'Why?' },
]
const task: CodeReviewTask = {
  type: 'code-review', variant: 'quick', repoRoot: '/work', repoName: 'work', scope: { kind: 'uncommitted' },
  scopeLabel: 'Uncommitted changes', beforeRevision: 'abc1234', fileCount: 1, language: 'en',
}

let session: { send: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.clearAllMocks()
  session = { send: vi.fn() }
  m.getOrCreateV2Session.mockResolvedValue(session)
  m.getConversation.mockReturnValue({ id: 'conv-1', sessionId: undefined })
})

describe('sendMessage with references and a task', () => {
  it('records references and task on the user message, text as typed', async () => {
    await sendMessage({ spaceId: 's', conversationId: 'conv-1', message: 'Look', references, task })
    const recorded = m.addMessage.mock.calls[0][2]
    expect(recorded.content).toBe('Look')
    expect(recorded.metadata).toEqual({ references, task })
  })

  it('sends memory, canvas, references, task, image fallback, then the text', async () => {
    m.prepareNonVisionImageFallback.mockReturnValueOnce({ contextBlock: '<halo_attachments/>\n\n', filePaths: [] })
    await sendMessage({
      spaceId: 's', conversationId: 'conv-1', message: 'Look', references, task,
      images: [{ id: 'i', type: 'image', mediaType: 'image/png', data: 'x' }],
      taskInstructions: 'Review the changes: M src/a.ts  (+1 -0)',
    })
    const sent: string = session.send.mock.calls[0][0]
    const order = ['<memory/>', '<halo_canvas>', '<halo_references>', '<halo_task type="code-review" variant="quick">', '<halo_attachments/>', 'Look']
      .map(marker => sent.indexOf(marker))
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(sent).toContain('[1] src/a.ts, lines 2-3\nNote: Why?')
    expect(sent).toContain('M src/a.ts  (+1 -0)')
    expect(sent.endsWith('Look')).toBe(true)
  })

  it('sends a message of cards alone and stores no empty metadata otherwise', async () => {
    await sendMessage({ spaceId: 's', conversationId: 'conv-1', message: '', references })
    expect(session.send.mock.calls[0][0]).toMatch(/<\/halo_references>\n\n$/)

    await sendMessage({ spaceId: 's', conversationId: 'conv-1', message: 'plain' })
    expect(m.addMessage.mock.calls[1][2]).not.toHaveProperty('metadata')
  })
})
