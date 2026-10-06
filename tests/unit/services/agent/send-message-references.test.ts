/**
 * sendMessage with references and a built-in task: the transcript keeps the
 * records, the model reads them expanded ahead of the text, in a fixed order.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  addMessage: vi.fn((_s: string, _c: string, msg: Record<string, unknown>) => ({ id: 'msg-1', timestamp: 't', ...msg })),
  getConversation: vi.fn(() => ({ id: 'conv-1', sessionId: undefined as string | undefined })),
  acquireV2Session: vi.fn(),
  prepareNonVisionImageFallback: vi.fn(() => null as null | { contextBlock: string; filePaths: string[] }),
  memoryEnabled: true,
  buildMemorySnapshot: vi.fn(),
  ensureMemoryFile: vi.fn(async () => false),
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
  acquireV2Session: m.acquireV2Session,
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
vi.mock('../../../../src/main/services/space.service', () => ({
  isSpaceMemoryEnabled: () => m.memoryEnabled,
  getSpaceMemoryLayout: () => memoryLayout,
}))
vi.mock('../../../../src/main/platform/memory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/platform/memory')>()),
  buildMemorySnapshot: m.buildMemorySnapshot,
  ensureMemoryFile: m.ensureMemoryFile,
}))
vi.mock('../../../../src/main/services/agent/reasoning-effort', () => ({ applyReasoningEffort: vi.fn(() => 0), pickReasoningEffort: vi.fn(() => undefined) }))
vi.mock('../../../../src/main/services/agent/conversation-sink', () => ({ createConversationSink: vi.fn() }))
vi.mock('../../../../src/main/services/agent/goal', () => ({ prepareGoalInput: vi.fn(), setGoalForTurn: vi.fn() }))
vi.mock('../../../../src/main/services/health', () => ({ onAgentError: vi.fn(), runPpidScanAndCleanup: vi.fn(async () => {}) }))
vi.mock('../../../../src/main/services/agent/stream-processor', () => ({ flushToolStats: vi.fn() }))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({ analytics: { track: vi.fn(async () => {}), trackErrorSurface: vi.fn() } }))

import { sendMessage } from '../../../../src/main/services/agent/send-message'
import { buildUserSessionSdkOptions } from '../../../../src/main/services/agent/sdk-config'
import { resolveMemoryLayout, MEMORY_FILE_FORMAT, TOPIC_FILE_FORMAT } from '../../../../src/main/platform/memory'
import type { ContentReference } from '../../../../src/shared/types/content-reference'
import type { CodeReviewTask } from '../../../../src/shared/types/message-task'

const references: ContentReference[] = [
  { id: 'r1', source: { kind: 'file', path: '/work/src/a.ts', precision: 'lines' }, range: { startLine: 2, endLine: 3 }, note: 'Why?' },
]
const task: CodeReviewTask = {
  type: 'code-review', variant: 'quick', repoRoot: '/work', repoName: 'work', scope: { kind: 'uncommitted' },
  scopeLabel: 'Uncommitted changes', beforeRevision: 'abc1234', fileCount: 1, language: 'en',
}

const memoryLayout = resolveMemoryLayout({ type: 'user', spaceId: 's', spacePath: '/spaces/s' }, 'space')

let session: { send: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.clearAllMocks()
  session = { send: vi.fn() }
  m.acquireV2Session.mockResolvedValue({ session, isCurrent: true, send: session.send, close: vi.fn(), release: vi.fn() })
  m.getConversation.mockReturnValue({ id: 'conv-1', sessionId: undefined })
  m.memoryEnabled = true
  m.buildMemorySnapshot.mockResolvedValue({
    layout: memoryLayout, exists: true, blank: true, totalLines: 5, sizeBytes: 27, nowBytes: 14,
    firstSection: null, fullContent: '# now\n\n## State\n\n# History\n', headers: [],
    topics: { root: memoryLayout.topicsDir, children: [], topicCount: 0, totalBytes: 0, truncated: false },
    runTotalCount: 0, archiveCount: 0,
  })
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
    const order = ['## Memory', '<halo_canvas>', '<halo_references>', '<halo_task type="code-review" variant="quick">', '<halo_attachments/>', 'Look']
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

describe('space memory session context', () => {
  it('keeps the format, paths, author and native guard in setup, with a first-message-only snapshot', async () => {
    const conversationId = 'ab12-3456'
    await sendMessage({ spaceId: 's', conversationId, message: 'first' })
    expect(session.send.mock.calls[0][0]).toContain('## Memory snapshot (startup)')
    expect(m.addMessage.mock.calls[0][2].content).toBe('first')

    m.getConversation.mockReturnValue({ id: conversationId, sessionId: 'saved-session' })
    await sendMessage({ spaceId: 's', conversationId, message: 'second' })
    expect(session.send.mock.calls[1][0]).not.toContain('## Memory')
    expect(m.buildMemorySnapshot).toHaveBeenCalledTimes(1)
    expect(m.ensureMemoryFile).toHaveBeenCalledTimes(1)

    for (const [options] of vi.mocked(buildUserSessionSdkOptions).mock.calls) {
      expect(options.memoryInstructions).toContain(MEMORY_FILE_FORMAT)
      expect(options.memoryInstructions).toContain(TOPIC_FILE_FORMAT)
      expect(options.memoryInstructions).toContain(`Memory file: \`${memoryLayout.file}\``)
      expect(options.memoryInstructions).toContain('Your History author tag is `chat#ab12`')
      expect(options.memoryGuard).toMatchObject({ writable: [memoryLayout] })
    }
    expect(m.acquireV2Session.mock.calls.at(-1)?.[3]).toBe('saved-session')
    expect(m.acquireV2Session.mock.calls.at(-1)?.[9]).toEqual({ creationContext: `space-memory:${memoryLayout.file}` })
  })

  it('resuming another transcript uses the destination conversation author without repeating the snapshot', async () => {
    await sendMessage({ spaceId: 's', conversationId: 'cd34-7890', resumeSessionId: 'source-session', message: 'continue' })
    const options = vi.mocked(buildUserSessionSdkOptions).mock.calls[0][0]
    expect(options.memoryInstructions).toContain('Your History author tag is `chat#cd34`')
    expect(m.acquireV2Session.mock.calls[0][3]).toBe('source-session')
    expect(m.buildMemorySnapshot).not.toHaveBeenCalled()
    expect(m.ensureMemoryFile).not.toHaveBeenCalled()
    expect(session.send.mock.calls[0][0]).not.toMatch(/## Memory|Running right now|No other instance/)
  })

  it('disabled memory adds no instructions, guard, snapshot or initialization work', async () => {
    m.memoryEnabled = false
    await sendMessage({ spaceId: 's', conversationId: 'conv-1', message: 'plain' })
    const options = vi.mocked(buildUserSessionSdkOptions).mock.calls[0][0]
    expect(options.memoryInstructions).toBeUndefined()
    expect(options.memoryGuard).toBeUndefined()
    expect(m.buildMemorySnapshot).not.toHaveBeenCalled()
    expect(m.ensureMemoryFile).not.toHaveBeenCalled()
    expect(m.acquireV2Session.mock.calls[0][9]).toEqual({ creationContext: undefined })
    expect(session.send.mock.calls[0][0]).not.toMatch(/## Memory|Your History author tag|Running right now|No other instance/)
  })
})
