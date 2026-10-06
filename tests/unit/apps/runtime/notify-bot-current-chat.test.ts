/**
 * Unit tests for one rule of `notify_bot` (apps/runtime/notify-tool) and the
 * IM prompt that goes with it (im-channels/im-prompt).
 *
 * The chat a turn answers receives the turn's reply anyway. A digital human
 * told by its own instructions to "answer with notify_bot" used to send the
 * answer twice: once through the tool, once as the reply. And since the reply
 * is the text after the turn's last tool call, an answer followed by
 * bookkeeping reached the chat as the bookkeeping's closing line.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../../src/main/services/notify-channels', () => ({ getEnabledChannels: () => [] }))
vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: vi.fn(() => ({})),
  onNetworkConfigChange: vi.fn(),
  onAgentConfigChange: vi.fn(),
}))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: vi.fn((name: string, description: string, schema: unknown, handler: unknown) => ({ name, description, schema, handler })),
  createSdkMcpServer: vi.fn((opts: { name: string; tools: unknown[] }) => ({ name: opts.name, tools: opts.tools })),
}))
const { pushToChat } = vi.hoisted(() => ({ pushToChat: vi.fn(() => true) }))
vi.mock('../../../../src/main/apps/runtime/im-channels', () => ({
  getActiveImChannelManager: () => ({
    getInstance: () => ({ isConnected: () => true, pushToChat }),
  }),
}))
vi.mock('../../../../src/main/apps/runtime/pending-relays', () => ({ getPendingRelayStore: () => null }))

import { createNotifyToolServer } from '../../../../src/main/apps/runtime/notify-tool'
import { buildImEntry } from '../../../../src/main/apps/runtime/im-channels/im-prompt'
import { FileExportGate } from '../../../../src/main/apps/runtime/file-export-gate'
import type { ImSessionRecord } from '../../../../src/shared/types/im-channel'

function session(chatId: string, chatType: 'direct' | 'group'): ImSessionRecord {
  return {
    appId: 'dh', channel: 'wecom-bot', source: 'im', instanceId: 'inst-1', chatId, chatType,
    displayName: chatId, proactive: false, lastActiveAt: 1,
  }
}

/** notify_bot of a turn answering the group "ops-group". */
function notifyBot() {
  const server = createNotifyToolServer({
    appId: 'dh', appName: 'Desk', runId: 'run-1',
    imSessions: [session('ops-group', 'group'), session('boss', 'direct'), { ...session('ops-group', 'group'), instanceId: 'inst-2' }],
    usesImPush: true,
    exportGate: new FileExportGate([]),
    relay: { sessionKey: 'app-chat:dh:wecom-bot:group:ops-group', contact: 'inst-1:ops-group', isOwner: true },
  }) as unknown as { tools: Array<{ name: string; handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }> }
  return server.tools.find(tool => tool.name === 'notify_bot')!.handler
}

beforeEach(() => pushToChat.mockClear())

describe('notify_bot and the chat a turn is answering', () => {
  it('does not send to that chat, and says to write it as the reply', async () => {
    const result = await notifyBot()({ to: 'inst-1:ops-group', message: 'Here is the answer' })

    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('Write the message as your reply instead')
    expect(pushToChat).not.toHaveBeenCalled()
  })

  it('still sends to the same group through another bot', async () => {
    // Another bot in the group is another chat: this turn's reply does not go there.
    const result = await notifyBot()({ to: 'inst-2:ops-group', message: 'Cross-posted for the other bot' })

    expect(result.isError).toBeUndefined()
    expect(pushToChat).toHaveBeenCalledWith('ops-group', 'Cross-posted for the other bot', 'group')
  })

  it('still sends to any other chat', async () => {
    const result = await notifyBot()({ to: 'inst-1:boss', message: 'FYI: the ops group asked about the release' })

    expect(result.isError).toBeUndefined()
    expect(pushToChat).toHaveBeenCalledWith('boss', 'FYI: the ops group asked about the release', 'direct')
  })
})

describe('the IM prompt says which text is the reply', () => {
  const NOTE = 'Only the text you write after your last tool call is delivered'

  it('in a group chat and in a direct chat alike', () => {
    const group = buildImEntry({ channel: 'wecom-bot', chatType: 'group', displayName: 'Ops', sessionId: 'inst-1:ops-group' })
    const direct = buildImEntry({ channel: 'wecom-bot', chatType: 'direct', displayName: 'Boss', sessionId: 'inst-1:boss' })

    for (const entry of [group, direct]) {
      expect(entry).toContain(NOTE)
      expect(entry).toContain('Do finishing work')
    }
  })
})
