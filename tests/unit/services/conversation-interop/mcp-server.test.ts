/**
 * Unit tests for conversation-interop/mcp-server — the `halo-conversations`
 * MCP server (`conversation_read` / `conversation_send`).
 *
 * The SDK's `tool()`/`createSdkMcpServer()` are mocked to expose the handler
 * directly (same pattern as `send-depth.test.ts`); `list-read`/`delivery`/
 * `circuit-breaker` are mocked too — this file only tests that mcp-server.ts
 * calls the right backend function and formats its result correctly, not the
 * backend logic itself (covered by list-read.test.ts/delivery.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema,
    handler,
  }),
  createSdkMcpServer: (options: { tools: Array<{ name: string }> }) => options,
}))

const listConversationsForInterop = vi.fn()
const readConversationForInterop = vi.fn()
vi.mock('../../../../src/main/services/conversation-interop/list-read', () => ({
  listConversationsForInterop: (...args: unknown[]) => listConversationsForInterop(...args),
  readConversationForInterop: (...args: unknown[]) => readConversationForInterop(...args),
}))

const deliverToConversation = vi.fn()
const deliverToConversationAndWait = vi.fn()
vi.mock('../../../../src/main/services/conversation-interop/delivery', () => ({
  deliverToConversation: (...args: unknown[]) => deliverToConversation(...args),
  deliverToConversationAndWait: (...args: unknown[]) => deliverToConversationAndWait(...args),
}))

const getInboundForwardDepth = vi.fn(() => 0)
vi.mock('../../../../src/main/services/conversation-interop/circuit-breaker', () => ({
  circuitBreaker: { getInboundForwardDepth: (...args: unknown[]) => getInboundForwardDepth(...args) },
  DEFAULT_CIRCUIT_LIMITS: { cooldownMs: 5 * 60_000 },
}))

// Pass-through by default (id resolves to itself) — matches every existing
// test's assumption that `target` reaches list-read/delivery unchanged.
// Tests that exercise resolution itself use `mockReturnValueOnce` so the
// override never leaks into a later, unrelated test.
const resolveConversationTarget = vi.fn((_spaceId: string, _callerId: string, target: string) => ({
  ok: true,
  conversationId: target,
}))
vi.mock('../../../../src/main/services/conversation-interop/target-resolution', () => ({
  resolveConversationTarget: (...args: unknown[]) => resolveConversationTarget(...(args as [string, string, string])),
}))

import { createConversationInteropMcpServer } from '../../../../src/main/services/conversation-interop/mcp-server'

interface ToolReply {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function getTool(server: { tools: Array<{ name: string; handler: (args: unknown) => Promise<ToolReply> }> }, name: string) {
  const found = server.tools.find((t) => t.name === name)
  if (!found) throw new Error(`tool not found: ${name}`)
  return found
}

const SCOPE = { spaceId: 'space-1', conversationId: 'self-1' }

describe('createConversationInteropMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getInboundForwardDepth.mockReturnValue(0)
  })

  it('builds both tools when includeSend is true, only conversation_read when false', () => {
    const withSend = createConversationInteropMcpServer(SCOPE, true)
    expect(withSend.tools.map((t) => t.name)).toEqual(['conversation_read', 'conversation_send'])

    const readOnly = createConversationInteropMcpServer(SCOPE, false)
    expect(readOnly.tools.map((t) => t.name)).toEqual(['conversation_read'])
  })

  describe('conversation_read', () => {
    it('list mode: formats items and omits the trailing note when nothing is withheld', async () => {
      listConversationsForInterop.mockReturnValue({
        ok: true,
        page: {
          items: [{ id: 'conv_1', title: 'Fix bug', updatedAt: new Date().toISOString(), messageCount: 34, running: true }],
          total: 1,
        },
      })
      const server = createConversationInteropMcpServer(SCOPE, true)
      const result = await getTool(server, 'conversation_read').handler({})

      expect(listConversationsForInterop).toHaveBeenCalledWith(SCOPE.spaceId, SCOPE.conversationId, undefined)
      expect(result.isError).toBeUndefined()
      expect(result.content[0].text).toContain('[conv_1] "Fix bug"')
      expect(result.content[0].text).toContain('running')
      expect(result.content[0].text).not.toContain('more exist')
    })

    it('list mode: appends the "more exist" note when a nextCursor is present', async () => {
      listConversationsForInterop.mockReturnValue({
        ok: true,
        page: {
          items: [{ id: 'conv_1', title: 'A', updatedAt: new Date().toISOString(), messageCount: 1, running: false }],
          total: 5,
          nextCursor: '1',
        },
      })
      const server = createConversationInteropMcpServer(SCOPE, true)
      const result = await getTool(server, 'conversation_read').handler({})
      expect(result.content[0].text).toContain('4 more exist')
      expect(result.content[0].text).toContain('cursor="1"')
    })

    it('list mode: reports an invalid cursor as isError', async () => {
      listConversationsForInterop.mockReturnValue({ ok: false, reason: 'invalid_cursor' })
      const server = createConversationInteropMcpServer(SCOPE, true)
      const result = await getTool(server, 'conversation_read').handler({ cursor: 'bogus' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('no longer valid')
    })

    it('read mode: formats the transcript and hidden-count note', async () => {
      readConversationForInterop.mockReturnValue({
        ok: true,
        page: {
          id: 'conv_1',
          title: 'Q3 pricing',
          running: false,
          updatedAt: new Date().toISOString(),
          lines: [{ role: 'user', content: 'hi', timestamp: '', source: undefined }],
          totalMessages: 10,
          hiddenBefore: 9,
          nextCursor: '1',
        },
      })
      const server = createConversationInteropMcpServer(SCOPE, true)
      const result = await getTool(server, 'conversation_read').handler({ target: 'conv_1' })

      expect(readConversationForInterop).toHaveBeenCalledWith(SCOPE.spaceId, 'conv_1', undefined)
      expect(result.content[0].text).toContain('[user] hi')
      expect(result.content[0].text).toContain('9 earlier messages are not shown')
      expect(result.content[0].text).toContain('cursor="1"')
    })

    it('read mode: not_found is a distinct isError message from an invalid cursor', async () => {
      readConversationForInterop.mockReturnValue({ ok: false, reason: 'not_found' })
      const server = createConversationInteropMcpServer(SCOPE, true)
      const result = await getTool(server, 'conversation_read').handler({ target: 'ghost' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('No conversation with id "ghost"')
    })
  })

  describe('conversation_send', () => {
    it('computes forwardDepth as inbound + 1 and passes it to deliverToConversation', async () => {
      getInboundForwardDepth.mockReturnValue(2)
      deliverToConversation.mockResolvedValue({ ok: true, status: 'delivered', messageId: 'm1' })
      const server = createConversationInteropMcpServer(SCOPE, true)

      await getTool(server, 'conversation_send').handler({ target: 'conv_2', message: 'hi', summary: 's' })

      expect(deliverToConversation).toHaveBeenCalledWith(
        expect.objectContaining({ fromConversationId: SCOPE.conversationId, toConversationId: 'conv_2', forwardDepth: 3 })
      )
    })

    it('reports queued vs delivered correctly for the default (non-waiting) path', async () => {
      deliverToConversation.mockResolvedValue({ ok: true, status: 'queued' })
      const server = createConversationInteropMcpServer(SCOPE, true)
      const queued = await getTool(server, 'conversation_send').handler({ target: 'conv_2', message: 'hi', summary: 's' })
      expect(queued.content[0].text).toContain('(status: queued)')

      deliverToConversation.mockResolvedValue({ ok: true, status: 'delivered', messageId: 'm1' })
      const delivered = await getTool(server, 'conversation_send').handler({ target: 'conv_2', message: 'hi', summary: 's' })
      expect(delivered.content[0].text).toContain('(status: delivered)')
    })

    it('reports resolved_pending_wait as a delivered reply, distinct from a normal delivery', async () => {
      deliverToConversation.mockResolvedValue({ ok: true, status: 'resolved_pending_wait' })
      const server = createConversationInteropMcpServer(SCOPE, true)
      const result = await getTool(server, 'conversation_send').handler({ target: 'conv_2', message: 'hi', summary: 's' })
      expect(result.content[0].text).toContain('as a reply to its pending question')
    })

    it('waitForReply=true calls deliverToConversationAndWait with the timeout in ms', async () => {
      deliverToConversationAndWait.mockResolvedValue({ ok: true, outcome: { status: 'replied', message: 'ack' } })
      const server = createConversationInteropMcpServer(SCOPE, true)

      const result = await getTool(server, 'conversation_send').handler({
        target: 'conv_2',
        message: 'hi',
        summary: 's',
        waitForReply: true,
        timeoutSec: 30,
      })

      expect(deliverToConversationAndWait).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30_000 }))
      expect(result.content[0].text).toContain('replied:')
      expect(result.content[0].text).toContain('ack')
    })

    it('waitForReply=true consumed as a reply says the wait was NOT honored, with a distinct status', async () => {
      // Lead's follow-up finding: the caller explicitly asked to wait for ITS
      // OWN answer. If this send instead got consumed as the reply someone
      // else needed, a plain "delivered" status reads as "sent, now
      // waiting" — the caller would wait forever on a reply that never
      // comes. The text and status must say the wait was dropped, not just
      // that something was delivered.
      deliverToConversationAndWait.mockResolvedValue({ ok: true, status: 'resolved_pending_wait' })
      const server = createConversationInteropMcpServer(SCOPE, true)

      const result = await getTool(server, 'conversation_send').handler({
        target: 'conv_2',
        message: 'hi',
        summary: 's',
        waitForReply: true,
      })

      expect(result.content[0].text).toContain('waitForReply was NOT honored')
      expect(result.content[0].text).toContain('(status: delivered_as_reply)')
      // Must not read like the ordinary success statuses — those are exactly
      // what would make the caller think its own wait is still live.
      expect(result.content[0].text).not.toContain('(status: delivered)')
      expect(result.content[0].text).not.toContain('(status: queued)')
    })

    it('formats no_reply and timeout wait outcomes distinctly', async () => {
      const server = createConversationInteropMcpServer(SCOPE, true)

      deliverToConversationAndWait.mockResolvedValue({ ok: true, outcome: { status: 'no_reply' } })
      const noReply = await getTool(server, 'conversation_send').handler({ target: 'conv_2', message: 'hi', summary: 's', waitForReply: true })
      expect(noReply.content[0].text).toContain('(status: no_reply)')

      deliverToConversationAndWait.mockResolvedValue({ ok: true, outcome: { status: 'timeout' } })
      const timedOut = await getTool(server, 'conversation_send').handler({ target: 'conv_2', message: 'hi', summary: 's', waitForReply: true, timeoutSec: 15 })
      expect(timedOut.content[0].text).toContain('after 15s')
      expect(timedOut.content[0].text).toContain('(status: timeout)')
    })

    it('maps every failure reason to a distinct isError message', async () => {
      const server = createConversationInteropMcpServer(SCOPE, true)
      const cases: Array<[string, string]> = [
        ['not_found', 'No conversation with id'],
        ['self_target', 'cannot deliver a message to yourself'],
        ['unreachable', 'status: unreachable'],
        ['circuit_open', 'status: circuit_open'],
        ['too_large', 'status: rejected'],
        ['queue_full', 'status: queue_full'],
        ['mutual_wait', 'reply to it first'],
      ]
      for (const [reason, expectedSubstring] of cases) {
        deliverToConversation.mockResolvedValue({ ok: false, reason })
        const result = await getTool(server, 'conversation_send').handler({ target: 'conv_2', message: 'hi', summary: 's' })
        expect(result.isError).toBe(true)
        expect(result.content[0].text).toContain(expectedSubstring)
      }
    })
  })

  describe('target resolution (id or title) — shared by both tools', () => {
    it('conversation_read: an unresolvable id/title short-circuits before reaching readConversationForInterop', async () => {
      resolveConversationTarget.mockReturnValueOnce({ ok: false, reason: 'not_found' })
      const server = createConversationInteropMcpServer(SCOPE, true)
      const result = await getTool(server, 'conversation_read').handler({ target: 'Nonexistent Title' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('No conversation with id or title "Nonexistent Title"')
      expect(readConversationForInterop).not.toHaveBeenCalled()
    })

    it('conversation_read: an ambiguous title lists every candidate by id and last activity, and never guesses', async () => {
      resolveConversationTarget.mockReturnValueOnce({
        ok: false,
        reason: 'ambiguous_title',
        candidates: [
          { id: 'conv_a', updatedAt: new Date().toISOString() },
          { id: 'conv_b', updatedAt: new Date(Date.now() - 3600_000).toISOString() },
        ],
      })
      const server = createConversationInteropMcpServer(SCOPE, true)
      const result = await getTool(server, 'conversation_read').handler({ target: 'Q3 Planning' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Multiple conversations in this space are titled "Q3 Planning"')
      expect(result.content[0].text).toContain('conv_a')
      expect(result.content[0].text).toContain('conv_b')
      expect(readConversationForInterop).not.toHaveBeenCalled()
    })

    it('conversation_read: a resolved title reaches readConversationForInterop by its RESOLVED id, not the raw title', async () => {
      resolveConversationTarget.mockReturnValueOnce({ ok: true, conversationId: 'conv_resolved' })
      readConversationForInterop.mockReturnValue({
        ok: true,
        page: {
          id: 'conv_resolved',
          title: 'Q3 pricing',
          running: false,
          updatedAt: new Date().toISOString(),
          lines: [],
          totalMessages: 0,
          hiddenBefore: 0,
        },
      })
      const server = createConversationInteropMcpServer(SCOPE, true)
      await getTool(server, 'conversation_read').handler({ target: 'Q3 pricing' })
      expect(readConversationForInterop).toHaveBeenCalledWith(SCOPE.spaceId, 'conv_resolved', undefined)
    })

    it('conversation_send: an ambiguous title is rejected before any delivery attempt', async () => {
      resolveConversationTarget.mockReturnValueOnce({
        ok: false,
        reason: 'ambiguous_title',
        candidates: [
          { id: 'conv_a', updatedAt: new Date().toISOString() },
          { id: 'conv_b', updatedAt: new Date().toISOString() },
        ],
      })
      const server = createConversationInteropMcpServer(SCOPE, true)
      const result = await getTool(server, 'conversation_send').handler({ target: 'Q3 Planning', message: 'hi', summary: 's' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Multiple conversations')
      expect(deliverToConversation).not.toHaveBeenCalled()
    })

    it(
      'self_target_title is reported distinctly from not_found — the conversation is not missing, it is THIS ' +
        'one, and the message must not claim it does not exist',
      async () => {
        resolveConversationTarget.mockReturnValueOnce({ ok: false, reason: 'self_target_title' })
        const server = createConversationInteropMcpServer(SCOPE, true)
        const result = await getTool(server, 'conversation_read').handler({ target: 'My own title' })
        expect(result.isError).toBe(true)
        expect(result.content[0].text).toContain('is the title of this very conversation')
        expect(result.content[0].text).not.toContain('No conversation with id or title')
      }
    )

    it('conversation_send: delivers to the RESOLVED id and reports it back, not the raw title the model typed', async () => {
      resolveConversationTarget.mockReturnValueOnce({ ok: true, conversationId: 'conv_resolved' })
      deliverToConversation.mockResolvedValue({ ok: true, status: 'delivered', messageId: 'm1' })
      const server = createConversationInteropMcpServer(SCOPE, true)
      const result = await getTool(server, 'conversation_send').handler({ target: 'Q3 pricing', message: 'hi', summary: 's' })
      expect(deliverToConversation).toHaveBeenCalledWith(expect.objectContaining({ toConversationId: 'conv_resolved' }))
      expect(result.content[0].text).toContain('[conv_resolved]')
    })
  })
})
