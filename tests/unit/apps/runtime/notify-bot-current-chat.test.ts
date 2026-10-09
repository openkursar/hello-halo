/**
 * Unit tests for one rule of `notify_bot` (apps/runtime/notify-tool) and the
 * IM prompt that goes with it (im-channels/im-prompt), and for what it keeps of
 * a message it sent.
 *
 * The chat a turn answers receives the turn's reply anyway. A digital human
 * told by its own instructions to "answer with notify_bot" used to send the
 * answer twice: once through the tool, once as the reply. And since the reply
 * is the text after the turn's last tool call, an answer followed by
 * bookkeeping reached the chat as the bookkeeping's closing line.
 *
 * A message it sent went out on the platform and nowhere else: the chat's
 * record in Halo showed the person's reply to it with nothing before it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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
const {
  pushToChat, sendFile, recordChatPush, appendRelay, sessions, configs, available, teamState,
  ensureConversationEpoch, findSession, setTeamContext,
} = vi.hoisted(() => ({
  pushToChat: vi.fn(() => true),
  sendFile: vi.fn(async () => true),
  recordChatPush: vi.fn(),
  appendRelay: vi.fn(),
  sessions: [] as ImSessionRecord[],
  configs: new Map<string, ImChannelInstanceConfig>(),
  available: { manager: true, registry: true, instance: true, connected: true, spool: true },
  teamState: { store: true, runtime: true, exists: true, member: true, remote: false },
  ensureConversationEpoch: vi.fn(),
  findSession: vi.fn(),
  setTeamContext: vi.fn(),
}))
vi.mock('../../../../src/main/apps/runtime/im-channels', () => ({
  getActiveImChannelManager: () => available.manager ? {
    getInstance: () => available.instance ? { isConnected: () => available.connected, pushToChat, fileCapability: { sendFile } } : undefined,
    getInstanceConfig: (id: string) => configs.get(id),
    getAuthorizationRevision: (id: string) => configs.get(id),
  } : null,
}))
vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: () => available.registry ? {
    findSession, setTeamContext,
    getSessionRevision: (appId: string, channel: string, chatId: string) => sessions.find(s => s.appId === appId && s.channel === channel && s.chatId === chatId),
  } : null,
}))
vi.mock('../../../../src/main/apps/team', () => ({
  getTeamStore: () => teamState.store ? {
    getTeamById: () => teamState.exists ? { id: 'team-1' } : null,
    getMember: () => teamState.member ? { origin: teamState.remote ? 'remote' : 'local', ownerNodeId: 'other-node' } : null,
  } : null,
}))
vi.mock('../../../../src/main/apps/runtime/team', () => ({
  getActiveTeamRuntime: () => teamState.runtime ? { ensureConversationEpoch } : null,
}))
vi.mock('../../../../src/main/apps/runtime/pending-relays', () => ({
  getPendingRelayStore: () => available.spool ? { append: appendRelay } : null,
}))
vi.mock('../../../../src/main/apps/runtime/chat-push', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/apps/runtime/chat-push')>()),
  recordChatPush,
}))

import { createNotifyToolServer } from '../../../../src/main/apps/runtime/notify-tool'
import { buildImEntry } from '../../../../src/main/apps/runtime/im-channels/im-prompt'
import { FileExportGate } from '../../../../src/main/apps/runtime/file-export-gate'
import type { ImChannelInstanceConfig, ImSessionRecord } from '../../../../src/shared/types/im-channel'
import { buildImSessionKey, buildTeamSessionKey } from '../../../../src/shared/apps/im-keys'
import { chatPushConversationId } from '../../../../src/main/apps/runtime/chat-push'
import { resolveImPushConversation } from '../../../../src/main/apps/runtime/im-team-session'

function session(chatId: string, chatType: 'direct' | 'group'): ImSessionRecord {
  return {
    appId: 'dh', channel: 'wecom-bot', source: 'im', instanceId: 'inst-1', chatId, chatType,
    displayName: chatId, proactive: false, lastActiveAt: 1,
  }
}

/** notify_bot of a turn answering the group "ops-group". */
function notifyBot(exportGate = new FileExportGate([])) {
  const server = createNotifyToolServer({
    appId: 'dh', appName: 'Desk', runId: 'run-1',
    imSessions: sessions.map(s => ({ ...s, teamContext: s.teamContext && { ...s.teamContext } })),
    usesImPush: true,
    exportGate,
    relay: { sessionKey: 'app-chat:dh:wecom-bot:group:ops-group', contact: 'inst-1:ops-group', isOwner: true },
  }) as unknown as { tools: Array<{ name: string; handler: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }> }
  return server.tools.find(tool => tool.name === 'notify_bot')!.handler
}

beforeEach(() => {
  pushToChat.mockReset().mockReturnValue(true)
  sendFile.mockReset().mockResolvedValue(true)
  recordChatPush.mockReset()
  appendRelay.mockReset()
  sessions.splice(0, sessions.length,
    { ...session('ops-group', 'group'), instanceId: 'inst-2' },
    session('boss', 'direct'),
    { ...session('release-group', 'group'), appId: 'ops-dh', instanceId: 'inst-3' },
  )
  configs.clear()
  for (const s of sessions) {
    configs.set(s.instanceId, { id: s.instanceId, appId: s.appId, type: 'wecom-bot', enabled: true, config: {} })
  }
  Object.assign(available, { manager: true, registry: true, instance: true, connected: true, spool: true })
  Object.assign(teamState, { store: true, runtime: true, exists: true, member: true, remote: false })
  ensureConversationEpoch.mockReset().mockReturnValue({ id: 'current-epoch' })
  findSession.mockReset().mockImplementation((appId, channel, chatId) => {
    const current = sessions.find(s => s.appId === appId && s.channel === channel && s.chatId === chatId)
    return current ? { ...current } : undefined
  })
  setTeamContext.mockReset().mockImplementation((appId, channel, chatId, teamContext) => {
    const current = sessions.find(s => s.appId === appId && s.channel === channel && s.chatId === chatId)
    if (current) current.teamContext = teamContext
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

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

describe('what notify_bot sent, in the record of the chat it went to', () => {
  it('is kept as a message the digital human sent on its own', async () => {
    await notifyBot()({ to: 'inst-1:boss', message: 'FYI: the ops group asked about the release' })

    expect(recordChatPush).toHaveBeenCalledOnce()
    expect(recordChatPush).toHaveBeenCalledWith({
      appId: 'dh', channel: 'wecom-bot', chatType: 'direct', chatId: 'boss',
      text: 'FYI: the ops group asked about the release', via: 'message', pushedBy: 'dh', teamContext: null,
    })
  })

  it('is kept in the chat\'s own digital human\'s record when sent through a push link, naming who sent it', async () => {
    await notifyBot()({ to: 'inst-3:release-group', message: 'Release 3.0 is out' })

    expect(recordChatPush).toHaveBeenCalledWith(expect.objectContaining({ appId: 'ops-dh', chatId: 'release-group', pushedBy: 'dh' }))
  })

  it('names a file it sent, and keeps a message whose file did not go', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notify-bot-file-'))
    try {
      const file = join(dir, 'numbers.pdf')
      writeFileSync(file, 'numbers')

      await notifyBot(new FileExportGate([dir]))({ to: 'inst-1:boss', message: 'Weekly numbers', file, filename: 'Weekly.pdf' })
      sendFile.mockResolvedValueOnce(false)
      await notifyBot(new FileExportGate([dir]))({ to: 'inst-1:boss', message: 'Monthly numbers', file })

      expect(recordChatPush.mock.calls.map(([push]) => push.text)).toEqual(['Weekly numbers\n\n📎 Weekly.pdf', 'Monthly numbers'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is not kept when nothing was sent', async () => {
    await notifyBot()({ to: 'inst-1:ops-group', message: 'Here is the answer' })
    pushToChat.mockReturnValueOnce(false)
    await notifyBot()({ to: 'inst-1:boss', message: 'Lost on the way' })

    expect(recordChatPush).not.toHaveBeenCalled()
  })
})

describe('notify_bot resolves the current destination before sending', () => {
  it.each([
    { chatType: 'direct' as const, teamId: undefined },
    { chatType: 'group' as const, teamId: undefined },
    { chatType: 'direct' as const, teamId: 'team-1' },
    { chatType: 'group' as const, teamId: 'team-1' },
  ])('records and spools the same $chatType destination with team=$teamId', async ({ chatType, teamId }) => {
    sessions[1].chatType = chatType
    configs.get('inst-1')!.teamId = teamId
    const result = await notifyBot()({ to: 'inst-1:boss', message: 'A progress update' })

    const teamContext = teamId ? { teamId, epochId: 'current-epoch' } : null
    const conversationId = teamId
      ? buildTeamSessionKey('dh', teamId, 'current-epoch')
      : buildImSessionKey('dh', 'wecom-bot', chatType, 'boss')
    expect(result.isError).toBeUndefined()
    expect(findSession).toHaveBeenCalledWith('dh', 'wecom-bot', 'boss')
    expect(pushToChat).toHaveBeenCalledWith('boss', 'A progress update', chatType)
    expect(recordChatPush).toHaveBeenCalledOnce()
    expect(recordChatPush).toHaveBeenCalledWith(expect.objectContaining({ teamContext, chatType }))
    expect(appendRelay).toHaveBeenCalledOnce()
    expect(appendRelay).toHaveBeenCalledWith(conversationId, expect.objectContaining({ message: 'A progress update' }))
    const [push] = recordChatPush.mock.calls[0]
    expect(chatPushConversationId(push, { teamContext: push.teamContext ?? undefined })).toBe(conversationId)
    expect(setTeamContext).toHaveBeenCalledWith('dh', 'wecom-bot', 'boss', teamContext ?? undefined)
    if (teamId) {
      expect(ensureConversationEpoch).toHaveBeenCalledWith(teamId, `inst-1:${chatType}:boss`, undefined, undefined, 'dh')
    } else {
      expect(ensureConversationEpoch).not.toHaveBeenCalled()
    }
  })

  it('uses the new epoch after the directory and registry have retained a cleared one', async () => {
    sessions[1].teamContext = { teamId: 'team-1', epochId: 'cleared-epoch' }
    configs.get('inst-1')!.teamId = 'team-1'
    const notify = notifyBot()
    ensureConversationEpoch.mockReturnValue({ id: 'fresh-epoch' })

    await notify({ to: 'inst-1:boss', message: 'After clear' })

    const teamContext = { teamId: 'team-1', epochId: 'fresh-epoch' }
    expect(recordChatPush).toHaveBeenCalledWith(expect.objectContaining({ teamContext }))
    expect(appendRelay).toHaveBeenCalledWith(buildTeamSessionKey('dh', 'team-1', 'fresh-epoch'), expect.any(Object))
    expect(sessions[1].teamContext).toEqual(teamContext)
  })

  it('uses the current registry chat type rather than the directory snapshot', async () => {
    configs.get('inst-1')!.teamId = 'team-1'
    const notify = notifyBot()
    sessions[1].chatType = 'group'

    await notify({ to: 'inst-1:boss', message: 'Current chat' })

    expect(ensureConversationEpoch).toHaveBeenCalledWith('team-1', 'inst-1:group:boss', undefined, undefined, 'dh')
    expect(pushToChat).toHaveBeenCalledWith('boss', 'Current chat', 'group')
  })

  it('clears an old team address when the bot now serves an ordinary conversation', async () => {
    sessions[1].teamContext = { teamId: 'old-team', epochId: 'old-epoch' }
    configs.get('inst-1')!.teamId = 'old-team'
    const notify = notifyBot()
    delete configs.get('inst-1')!.teamId

    await notify({ to: 'inst-1:boss', message: 'Now standalone' })

    expect(ensureConversationEpoch).not.toHaveBeenCalled()
    expect(recordChatPush).toHaveBeenCalledWith(expect.objectContaining({ teamContext: null }))
    expect(appendRelay).toHaveBeenCalledWith(buildImSessionKey('dh', 'wecom-bot', 'direct', 'boss'), expect.any(Object))
    expect(setTeamContext).toHaveBeenCalledWith('dh', 'wecom-bot', 'boss', undefined)
    expect(sessions[1].teamContext).toBeUndefined()
  })

  it('resolves a replacement team instead of the cached team', async () => {
    sessions[1].teamContext = { teamId: 'old-team', epochId: 'old-epoch' }
    const notify = notifyBot()
    configs.get('inst-1')!.teamId = 'replacement-team'

    await notify({ to: 'inst-1:boss', message: 'New team' })

    expect(ensureConversationEpoch).toHaveBeenCalledWith('replacement-team', 'inst-1:direct:boss', undefined, undefined, 'dh')
    expect(appendRelay).toHaveBeenCalledWith(buildTeamSessionKey('dh', 'replacement-team', 'current-epoch'), expect.any(Object))
  })

  it.each([
    { patch: { appId: 'other-app' }, reason: 'bound app changed' },
    { patch: { appId: '' }, reason: 'bound app changed' },
    { patch: { enabled: false }, reason: 'instance disabled' },
    { patch: { id: 'replacement-instance' }, reason: 'instance changed' },
    { patch: { type: 'feishu-bot' }, reason: 'channel changed' },
  ])('refuses an obsolete binding once: $reason', async ({ patch, reason }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const notify = notifyBot()
    Object.assign(configs.get('inst-1')!, patch)

    const result = await notify({ to: 'inst-1:boss', message: 'Private message body' })

    expect(result.isError).toBe(true)
    expect(pushToChat).not.toHaveBeenCalled()
    expect(sendFile).not.toHaveBeenCalled()
    expect(recordChatPush).not.toHaveBeenCalled()
    expect(appendRelay).not.toHaveBeenCalled()
    expect(setTeamContext).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`instanceId=inst-1, chatId=boss, reason=${reason}`))
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Private message body')
  })

  it.each(['removed', 'instance changed'] as const)('refuses a directory entry whose current registry record is %s', async change => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const notify = notifyBot()
    if (change === 'removed') sessions.splice(1, 1)
    else sessions[1].instanceId = 'replacement-instance'

    const result = await notify({ to: 'inst-1:boss', message: 'Do not deliver' })

    expect(result.isError).toBe(true)
    expect(pushToChat).not.toHaveBeenCalled()
    expect(recordChatPush).not.toHaveBeenCalled()
    expect(appendRelay).not.toHaveBeenCalled()
    expect(setTeamContext).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`target=inst-1:boss, appId=dh, reason=session ${change}`))
  })

  it.each(['registry', 'manager', 'config'] as const)('fails closed when the current %s is unavailable', async missing => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const notify = notifyBot()
    if (missing === 'config') configs.delete('inst-1')
    else available[missing] = false

    const result = await notify({ to: 'inst-1:boss', message: 'Do not deliver' })

    expect(result.isError).toBe(true)
    expect(pushToChat).not.toHaveBeenCalled()
    expect(recordChatPush).not.toHaveBeenCalled()
    expect(appendRelay).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/target=inst-1:boss, reason=.+/))
  })

  it.each(['instance', 'connected'] as const)('does not open a team conversation when the channel is unavailable: %s', async missing => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    configs.get('inst-1')!.teamId = 'team-1'
    available[missing] = false

    const result = await notifyBot()({ to: 'inst-1:boss', message: 'Do not deliver' })

    expect(result.isError).toBe(true)
    expect(pushToChat).not.toHaveBeenCalled()
    expect(recordChatPush).not.toHaveBeenCalled()
    expect(appendRelay).not.toHaveBeenCalled()
    expect(ensureConversationEpoch).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/target=inst-1:boss, reason=IM channel/))
  })

  it.each(['store', 'runtime', 'exists', 'member', 'remote'] as const)('does not fall back to an ordinary chat for an unavailable team: %s', async missing => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    configs.get('inst-1')!.teamId = 'team-1'
    teamState[missing] = missing === 'remote'

    const result = await notifyBot()({ to: 'inst-1:boss', message: 'Do not deliver' })

    expect(result.isError).toBe(true)
    expect(pushToChat).not.toHaveBeenCalled()
    expect(recordChatPush).not.toHaveBeenCalled()
    expect(appendRelay).not.toHaveBeenCalled()
    expect(setTeamContext).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ImTeamSession.*inst-1:direct:boss.*teamId=team-1/))
  })

  it('logs a team resolution exception without exposing exception content', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    configs.get('inst-1')!.teamId = 'team-1'
    ensureConversationEpoch.mockImplementation(() => { throw new Error('Private provider payload') })

    const result = await notifyBot()({ to: 'inst-1:boss', message: 'Private message body' })

    expect(result.isError).toBe(true)
    expect(pushToChat).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('chat=inst-1:direct:boss, appId=dh, teamId=team-1, reason=team conversation resolution failed'))
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Private provider payload|Private message body/)
  })

  it('does not update the registry or record a rejected team push', async () => {
    configs.get('inst-1')!.teamId = 'team-1'
    sessions[1].teamContext = { teamId: 'team-1', epochId: 'old-epoch' }
    pushToChat.mockReturnValueOnce(false)

    const result = await notifyBot()({ to: 'inst-1:boss', message: 'Rejected' })

    expect(result.isError).toBe(true)
    expect(setTeamContext).not.toHaveBeenCalled()
    expect(sessions[1].teamContext?.epochId).toBe('old-epoch')
    expect(recordChatPush).not.toHaveBeenCalled()
    expect(appendRelay).not.toHaveBeenCalled()
  })

  it.each([true, false])('keeps the delivered record without restoring a changed destination after a file send (accepted=%s)', async fileAccepted => {
    const dir = mkdtempSync(join(tmpdir(), 'notify-bot-destination-'))
    try {
      const file = join(dir, 'numbers.pdf')
      writeFileSync(file, 'numbers')
      configs.get('inst-1')!.teamId = 'team-1'
      let finishFile!: (accepted: boolean) => void
      sendFile.mockImplementationOnce(() => new Promise(resolve => { finishFile = resolve }))
      const pending = notifyBot(new FileExportGate([dir]))({ to: 'inst-1:boss', message: 'Numbers', file })
      expect(sendFile).toHaveBeenCalledOnce()
      expect(recordChatPush).not.toHaveBeenCalled()
      expect(setTeamContext).not.toHaveBeenCalled()

      configs.set('inst-1', { ...configs.get('inst-1')!, teamId: 'later-team' })
      sessions[1] = { ...sessions[1], teamContext: { teamId: 'later-team', epochId: 'later-epoch' } }
      ensureConversationEpoch.mockReturnValue({ id: 'later-epoch' })
      finishFile(fileAccepted)
      const result = await pending

      expect(result.isError).toBe(fileAccepted ? undefined : true)
      expect(recordChatPush).toHaveBeenCalledOnce()
      const [push] = recordChatPush.mock.calls[0]
      expect(push.teamContext).toEqual({ teamId: 'team-1', epochId: 'current-epoch' })
      expect(push.sessionRevision).toBeNull()
      expect(appendRelay).not.toHaveBeenCalled()
      expect(chatPushConversationId(push, push)).toBe(buildTeamSessionKey('dh', 'team-1', 'current-epoch'))
      expect(push.text).toBe(fileAccepted ? 'Numbers\n\n📎 numbers.pdf' : 'Numbers')
      expect(setTeamContext).not.toHaveBeenCalled()
      expect(sessions[1].teamContext).toEqual({ teamId: 'later-team', epochId: 'later-epoch' })
      expect(ensureConversationEpoch).toHaveBeenCalledOnce()
      if (!fileAccepted) {
        expect(push.text).toBe('Numbers')
        expect(result.content[0].text).toContain('Message sent')
        expect(result.content[0].text).toContain('However')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each(['removed', 'recreated', 'cleared', 'rebound and restored'] as const)('does not recreate pending context when the chat was %s during file sending', async change => {
    const dir = mkdtempSync(join(tmpdir(), 'notify-bot-lifecycle-'))
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const file = join(dir, 'numbers.pdf')
      writeFileSync(file, 'numbers')
      configs.get('inst-1')!.teamId = 'team-1'
      let finishFile!: (accepted: boolean) => void
      sendFile.mockImplementationOnce(() => new Promise(resolve => { finishFile = resolve }))
      const pending = notifyBot(new FileExportGate([dir]))({ to: 'inst-1:boss', file })
      expect(sendFile).toHaveBeenCalledOnce()

      if (change === 'removed') sessions.splice(1, 1)
      else if (change === 'rebound and restored') configs.set('inst-1', { ...configs.get('inst-1')! })
      else sessions[1] = { ...sessions[1] }
      finishFile(true)
      const result = await pending

      expect(result.isError).toBeUndefined()
      expect(recordChatPush).toHaveBeenCalledWith(expect.objectContaining({
        text: '📎 numbers.pdf', teamContext: { teamId: 'team-1', epochId: 'current-epoch' }, sessionRevision: null,
      }))
      expect(setTeamContext).not.toHaveBeenCalled()
      expect(appendRelay).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledOnce()
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('reason=chat or authorization changed during delivery'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('records and spools an awaited delivery whose chat remains current', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notify-bot-current-'))
    try {
      const file = join(dir, 'numbers.pdf')
      writeFileSync(file, 'numbers')
      configs.get('inst-1')!.teamId = 'team-1'
      let finishFile!: (accepted: boolean) => void
      sendFile.mockImplementationOnce(() => new Promise(resolve => { finishFile = resolve }))
      const pending = notifyBot(new FileExportGate([dir]))({ to: 'inst-1:boss', file })
      finishFile(true)
      await pending

      expect(setTeamContext).toHaveBeenCalledWith('dh', 'wecom-bot', 'boss', { teamId: 'team-1', epochId: 'current-epoch' })
      expect(recordChatPush).toHaveBeenCalledOnce()
      expect(appendRelay).toHaveBeenCalledWith(buildTeamSessionKey('dh', 'team-1', 'current-epoch'), expect.objectContaining({ file: { name: 'numbers.pdf' } }))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps successful delivery when the relay spool is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    available.spool = false

    const result = await notifyBot()({ to: 'inst-1:boss', message: 'Still delivered' })

    expect(result.isError).toBeUndefined()
    expect(recordChatPush).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('target=app-chat:dh:wecom-bot:direct:boss, reason=relay spool unavailable'))
  })

  it('keeps successful delivery when relay recording throws without logging user content', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    appendRelay.mockImplementation(() => { throw new Error('Private message body') })

    const result = await notifyBot()({ to: 'inst-1:boss', message: 'Private message body' })

    expect(result.isError).toBeUndefined()
    expect(recordChatPush).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('target=app-chat:dh:wecom-bot:direct:boss, reason=relay recording failed'))
    expect(JSON.stringify(error.mock.calls)).not.toContain('Private message body')
  })

  it('returns an explicit non-team destination without consulting a cached team', () => {
    const record = { ...session('boss', 'direct'), teamContext: { teamId: 'stale-team', epochId: 'stale-epoch' } }
    const destination = resolveImPushConversation(record, configs.get('inst-1')!)

    expect(destination).toEqual({ conversationId: buildImSessionKey('dh', 'wecom-bot', 'direct', 'boss'), teamContext: null })
    expect(record.teamContext).toEqual({ teamId: 'stale-team', epochId: 'stale-epoch' })
    expect(ensureConversationEpoch).not.toHaveBeenCalled()
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
