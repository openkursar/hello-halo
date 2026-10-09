import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { config, registrySessions, instances, epochs, recordChatPush, appendRelay, available, teamState, ensureConversationEpoch, setTeamContext } = vi.hoisted(() => ({
  config: { imChannels: { instances: [] as Array<Record<string, unknown>> } },
  registrySessions: [] as Array<Record<string, unknown>>,
  instances: new Map<string, { providerType?: string; isConnected: () => boolean; pushToChat: (chatId: string, text: string, chatType: 'direct' | 'group') => boolean }>(),
  epochs: new Map<string, { chatKey?: string }>(),
  recordChatPush: vi.fn(),
  appendRelay: vi.fn(),
  available: { manager: true, registry: true, spool: true },
  teamState: { store: true, runtime: true, exists: true, member: true, remote: false },
  ensureConversationEpoch: vi.fn(),
  setTeamContext: vi.fn(),
}))

vi.mock('../../../../src/main/foundation/config.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConfig: () => config,
}))
vi.mock('../../../../src/main/apps/runtime/im-channels', () => ({
  getActiveImChannelManager: () => available.manager ? { getInstance: (id: string) => instances.get(id) } : null,
}))
vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: () => available.registry ? { listAll: () => registrySessions.map(s => ({ ...s })), setTeamContext } : null,
}))
vi.mock('../../../../src/main/apps/team', () => ({
  getTeamStore: () => teamState.store ? {
    getEpochById: (id: string) => epochs.get(id) ?? null,
    getTeamById: (id: string) => teamState.exists ? { id, name: 'Release Team' } : null,
    getMember: () => teamState.member ? { memberName: 'Lead', origin: teamState.remote ? 'remote' : 'local', ownerNodeId: 'other-machine' } : null,
  } : null,
}))
vi.mock('../../../../src/main/apps/runtime/team', () => ({
  getActiveTeamRuntime: () => teamState.runtime ? { ensureConversationEpoch } : null,
}))
vi.mock('../../../../src/main/apps/runtime/chat-push', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/main/apps/runtime/chat-push')>()),
  recordChatPush,
}))
vi.mock('../../../../src/main/apps/runtime/pending-relays', () => ({
  getPendingRelayStore: () => available.spool ? { append: appendRelay } : null,
}))

import { deliverEscalationToIm, formatQuestion } from '../../../../src/main/apps/runtime/im-escalation'
import { buildImSessionKey, buildRunSenderKey, buildTeamSessionKey } from '../../../../src/shared/apps/im-keys'
import type { ActivityEntry } from '../../../../src/shared/apps/app-types'

function bot(id: string, fields: Record<string, unknown>) {
  const pushToChat = vi.fn((_chatId: string, _text: string, _chatType: 'direct' | 'group') => true)
  config.imChannels.instances.push({ id, enabled: true, type: 'wecom-bot', config: {}, ...fields })
  instances.set(id, { providerType: 'wecom-bot', isConnected: () => true, pushToChat })
  return pushToChat
}

function chat(instanceId: string, chatType: 'direct' | 'group', chatId: string, extra: Record<string, unknown> = {}) {
  registrySessions.push({ appId: 'dh', channel: 'wecom-bot', source: 'im', instanceId, chatType, chatId, proactive: false, ...extra })
}

function question(content: Partial<ActivityEntry['content']> = {}, appId = 'dh'): ActivityEntry {
  return {
    id: 'entry-1', appId, runId: 'run-1', type: 'escalation', ts: 1,
    content: { summary: 'Ship the release tonight?', ...content },
  }
}

beforeEach(() => {
  config.imChannels.instances.length = 0
  registrySessions.length = 0
  instances.clear()
  epochs.clear()
  recordChatPush.mockReset()
  appendRelay.mockReset()
  Object.assign(available, { manager: true, registry: true, spool: true })
  Object.assign(teamState, { store: true, runtime: true, exists: true, member: true, remote: false })
  ensureConversationEpoch.mockReset().mockReturnValue({ id: 'private-epoch' })
  setTeamContext.mockReset().mockImplementation((appId, channel, chatId, teamContext) => {
    const session = registrySessions.find(s => s.appId === appId && s.channel === channel && s.chatId === chatId)
    if (session) session.teamContext = teamContext
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('asking over IM', () => {
  it('sends the full question only to owner direct chats, with no notices to result groups', () => {
    const push = bot('i1', { appId: 'dh', permissionEnabled: true, owners: ['boss'] })
    chat('i1', 'direct', 'boss', { contactId: 'boss' })
    chat('i1', 'direct', 'customer', { contactId: 'customer', proactive: true })
    chat('i1', 'group', 'ops-group', { proactive: true })
    chat('i1', 'group', 'chatter-group')

    deliverEscalationToIm(question({ choices: ['Yes', 'No'], data: 'The tests are green.' }), 'Release Bot')

    expect(push.mock.calls.map(([chatId, , type]) => [chatId, type])).toEqual([['boss', 'direct']])
    const asked = push.mock.calls[0][1]
    expect(asked).toContain('「Release Bot」的任务需要你决定：Ship the release tonight?')
    expect(asked).toContain('The tests are green.')
    expect(asked).toContain('A. Yes')
    expect(asked).toContain('B. No')
    expect(asked).toContain('直接回复我就行')
    expect(asked).not.toMatch(/\/answer|编号|entry-1|run-1/)
    expect(appendRelay).toHaveBeenCalledOnce()
  })

  it('matches the owner by contactId rather than a provider-specific conversation id', () => {
    const push = bot('i1', { appId: 'dh', permissionEnabled: true, owners: ['ou_boss'] })
    chat('i1', 'direct', 'oc_chat_42', { contactId: 'ou_boss' })
    chat('i1', 'direct', 'ou_boss', { contactId: 'customer', proactive: true })

    deliverEscalationToIm(question(), 'Release Bot')

    expect(push).toHaveBeenCalledOnce()
    expect(push).toHaveBeenCalledWith('oc_chat_42', expect.stringContaining('需要你决定'), 'direct')
    expect(appendRelay.mock.calls[0][0]).toBe(buildImSessionKey('dh', 'wecom-bot', 'direct', 'oc_chat_42'))
  })

  it('falls back to chatId for an older direct-chat record without contactId', () => {
    const push = bot('i1', { appId: 'dh', permissionEnabled: true, owners: ['boss'] })
    chat('i1', 'direct', 'boss')

    deliverEscalationToIm(question(), 'Release Bot')

    expect(push).toHaveBeenCalledOnce()
    expect(push).toHaveBeenCalledWith('boss', expect.stringContaining('需要你决定'), 'direct')
  })

  it('with permission control off, asks only direct chats chosen to receive results', () => {
    const push = bot('i1', { appId: 'dh', permissionEnabled: false, owners: ['passer-by'] })
    chat('i1', 'direct', 'follower', { proactive: true })
    chat('i1', 'direct', 'passer-by')
    chat('i1', 'group', 'results', { proactive: true })

    deliverEscalationToIm(question(), 'Release Bot')

    expect(push.mock.calls.map(([chatId, , type]) => [chatId, type])).toEqual([['follower', 'direct']])
    expect(appendRelay.mock.calls.map(([key]) => key)).toEqual([buildImSessionKey('dh', 'wecom-bot', 'direct', 'follower')])
  })

  it.each([{ owners: [] }, { owners: undefined }])('does not treat proactive contacts as owners when the enabled roster is $owners', ({ owners }) => {
    const push = bot('i1', { appId: 'dh', permissionEnabled: true, owners })
    chat('i1', 'direct', 'follower', { proactive: true })
    chat('i1', 'group', 'results', { proactive: true })

    deliverEscalationToIm(question(), 'Release Bot')

    expect(push).not.toHaveBeenCalled()
    expect(recordChatPush).not.toHaveBeenCalled()
    expect(appendRelay).not.toHaveBeenCalled()
  })

  it('ignores sessions of another app, instance or non-IM source', () => {
    const push = bot('i1', { appId: 'dh', permissionEnabled: true, owners: ['boss'] })
    chat('i1', 'direct', 'boss', { appId: 'other' })
    chat('other-instance', 'direct', 'boss')
    chat('i1', 'direct', 'boss', { source: 'local', channel: 'local' })

    deliverEscalationToIm(question(), 'Release Bot')

    expect(push).not.toHaveBeenCalled()
    expect(appendRelay).not.toHaveBeenCalled()
  })

  it('records each delivered question and spools an action naming its actual author and run', () => {
    const push = bot('i1', { appId: 'dh', permissionEnabled: true, owners: ['boss', 'backup'] })
    chat('i1', 'direct', 'boss')
    chat('i1', 'direct', 'backup')
    const entry = question()

    deliverEscalationToIm(entry, 'Release Bot')

    expect(recordChatPush.mock.calls.map(([sent]) => sent)).toEqual(['boss', 'backup'].map(chatId => ({
      appId: 'dh', channel: 'wecom-bot', chatType: 'direct', chatId,
      text: push.mock.calls[0][1], via: 'question', pushedBy: 'dh', teamContext: null,
    })))
    expect(appendRelay.mock.calls).toEqual(['boss', 'backup'].map(chatId => [
      buildImSessionKey('dh', 'wecom-bot', 'direct', chatId),
      {
        kind: 'push', id: expect.any(String), at: expect.any(Number),
        source: { key: buildRunSenderKey('dh', 'run-1'), appId: 'dh', runId: 'run-1', label: 'Release Bot' },
        sourceOwner: false, message: push.mock.calls[0][1],
        action: { kind: 'answer-question', appId: 'dh', entryId: 'entry-1' },
      },
    ]))
    expect(new Set(appendRelay.mock.calls.map(([, event]) => event.id)).size).toBe(2)
    expect(JSON.stringify(appendRelay.mock.calls)).not.toMatch(/Authorization|Bearer|curl|token|expiresAt/)
    expect(entry.userResponse).toBeUndefined()
  })

  it('asks team owners privately, notices only the originating group, and attributes the member who asked', () => {
    const push = bot('team-bot', { appId: 'lead', teamId: 't1', permissionEnabled: true, owners: ['boss'] })
    chat('team-bot', 'direct', 'boss', { appId: 'lead', contactId: 'boss', teamContext: { teamId: 't1', epochId: 'private-epoch' } })
    chat('team-bot', 'group', 'project-group', { appId: 'lead', teamContext: { teamId: 't1', epochId: 'e1' } })
    chat('team-bot', 'group', 'results-group', { appId: 'lead', proactive: true })
    const other = bot('other-team-bot', { appId: 'lead', teamId: 't1', permissionEnabled: true, owners: ['boss'] })
    chat('other-team-bot', 'group', 'project-group', { appId: 'lead', proactive: true })
    epochs.set('e1', { chatKey: 'team-bot:group:project-group' })
    const entry = question({ teamContext: { teamId: 't1', epochId: 'e1' }, data: 'Private release details' }, 'researcher')
    entry.sessionKey = buildTeamSessionKey('researcher', 't1', 'e1')

    deliverEscalationToIm(entry, 'Researcher')

    expect(push.mock.calls.map(([chatId, , type]) => [chatId, type])).toEqual([['boss', 'direct'], ['project-group', 'group']])
    expect(other).not.toHaveBeenCalled()
    const notice = push.mock.calls[1][1]
    expect(notice).toContain('「Researcher」的这项工作在等主人决定')
    expect(notice).not.toMatch(/Ship the release|Private release details|\/answer|编号|entry-1/)
    expect(recordChatPush.mock.calls.map(([sent]) => [sent.appId, sent.pushedBy, sent.chatId])).toEqual([
      ['lead', 'researcher', 'boss'], ['lead', 'researcher', 'project-group'],
    ])
    expect(appendRelay).toHaveBeenCalledOnce()
    expect(appendRelay).toHaveBeenCalledWith(buildTeamSessionKey('lead', 't1', 'private-epoch'), expect.objectContaining({
      source: { key: entry.sessionKey, appId: 'researcher', runId: 'run-1', label: 'Researcher' },
      action: { kind: 'answer-question', appId: 'researcher', entryId: 'entry-1' },
    }))
  })

  it('resolves the current private team chat after its previous conversation was cleared', () => {
    bot('team-bot', { appId: 'lead', teamId: 't1', permissionEnabled: true, owners: ['boss'] })
    chat('team-bot', 'direct', 'boss', { appId: 'lead', teamContext: { teamId: 't1', epochId: 'cleared-epoch' } })
    ensureConversationEpoch.mockReturnValue({ id: 'new-private-epoch' })

    deliverEscalationToIm(question({ teamContext: { teamId: 't1', epochId: 'run-epoch' } }, 'researcher'), 'Researcher')

    const teamContext = { teamId: 't1', epochId: 'new-private-epoch' }
    expect(ensureConversationEpoch).toHaveBeenCalledWith('t1', 'team-bot:direct:boss', undefined, undefined, 'lead')
    expect(setTeamContext).toHaveBeenCalledWith('lead', 'wecom-bot', 'boss', teamContext)
    expect(registrySessions[0].teamContext).toEqual(teamContext)
    expect(recordChatPush).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'boss', teamContext }))
    expect(appendRelay).toHaveBeenCalledWith(buildTeamSessionKey('lead', 't1', 'new-private-epoch'), expect.any(Object))
    expect(appendRelay.mock.calls[0][0]).not.toContain('cleared-epoch')
  })

  it('clears the old team destination when the bot now serves a single digital human', () => {
    bot('i1', { appId: 'dh', permissionEnabled: true, owners: ['boss'] })
    chat('i1', 'direct', 'boss', { teamContext: { teamId: 'old-team', epochId: 'old-epoch' } })

    deliverEscalationToIm(question(), 'Release Bot')

    expect(ensureConversationEpoch).not.toHaveBeenCalled()
    expect(setTeamContext).toHaveBeenCalledWith('dh', 'wecom-bot', 'boss', undefined)
    expect(recordChatPush).toHaveBeenCalledWith(expect.objectContaining({ teamContext: null }))
    expect(appendRelay).toHaveBeenCalledWith(buildImSessionKey('dh', 'wecom-bot', 'direct', 'boss'), expect.any(Object))
  })

  it.each(['store', 'runtime', 'exists', 'member', 'remote'] as const)('does not invite an answer to an unavailable team chat: %s', missing => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const push = bot('team-bot', { appId: 'lead', teamId: 't1', permissionEnabled: true, owners: ['boss'] })
    chat('team-bot', 'direct', 'boss', { appId: 'lead', teamContext: { teamId: 't1', epochId: 'old-epoch' } })
    teamState[missing] = missing === 'remote'

    deliverEscalationToIm(question({ teamContext: { teamId: 't1', epochId: 'run-epoch' } }, 'researcher'), 'Researcher')

    expect(push).not.toHaveBeenCalled()
    expect(recordChatPush).not.toHaveBeenCalled()
    expect(appendRelay).not.toHaveBeenCalled()
    expect(setTeamContext).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/ImTeamSession.*team-bot:direct:boss.*teamId=t1/))
  })

  it('without an owner conversation, keeps the question private and sends only its originating group a notice', () => {
    const push = bot('team-bot', { appId: 'lead', teamId: 't1', permissionEnabled: true, owners: ['boss'] })
    chat('team-bot', 'direct', 'customer', { appId: 'lead', proactive: true })
    chat('team-bot', 'group', 'results', { appId: 'lead', proactive: true })
    epochs.set('e1', { chatKey: 'team-bot:group:origin' })

    deliverEscalationToIm(question({ teamContext: { teamId: 't1', epochId: 'e1' }, data: 'Private details', choices: ['Confidential choice'] }, 'researcher'), 'Researcher')

    expect(push).toHaveBeenCalledOnce()
    expect(push).toHaveBeenCalledWith('origin', expect.stringContaining('等主人决定'), 'group')
    expect(push.mock.calls[0][1]).not.toMatch(/Ship the release|Private details|Confidential choice/)
    expect(recordChatPush).toHaveBeenCalledOnce()
    expect(appendRelay).not.toHaveBeenCalled()
  })

  it.each([undefined, 'native:conversation', 'team-bot:direct:someone'])('does not notice unrelated groups for team origin %s', chatKey => {
    const push = bot('team-bot', { appId: 'lead', teamId: 't1', permissionEnabled: true, owners: ['boss'] })
    chat('team-bot', 'group', 'results', { appId: 'lead', proactive: true })
    epochs.set('e1', { chatKey })

    deliverEscalationToIm(question({ teamContext: { teamId: 't1', epochId: 'e1' } }, 'researcher'), 'Researcher')

    expect(push).not.toHaveBeenCalled()
    expect(appendRelay).not.toHaveBeenCalled()
  })

  it('records and spools only accepted private sends', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const push = bot('i1', { appId: 'dh', permissionEnabled: true, owners: ['unreachable', 'boss'] })
    chat('i1', 'direct', 'unreachable')
    chat('i1', 'direct', 'boss')
    push.mockImplementation(chatId => chatId !== 'unreachable')

    deliverEscalationToIm(question(), 'Release Bot')

    expect(recordChatPush).toHaveBeenCalledOnce()
    expect(recordChatPush).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'boss', via: 'question' }))
    expect(appendRelay).toHaveBeenCalledOnce()
    expect(appendRelay).toHaveBeenCalledWith(buildImSessionKey('dh', 'wecom-bot', 'direct', 'boss'), expect.objectContaining({ action: { kind: 'answer-question', appId: 'dh', entryId: 'entry-1' } }))
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Question entry-1 had rejected IM sends:.*asked=1, told=0, failed=1/))
  })

  it('keeps a rejected originating-group notice out of both record and spool', () => {
    const push = bot('team-bot', { appId: 'lead', teamId: 't1', permissionEnabled: true, owners: ['boss'] })
    epochs.set('e1', { chatKey: 'team-bot:group:origin' })
    push.mockReturnValue(false)

    deliverEscalationToIm(question({ teamContext: { teamId: 't1', epochId: 'e1' } }, 'researcher'), 'Researcher')

    expect(push).toHaveBeenCalledOnce()
    expect(recordChatPush).not.toHaveBeenCalled()
    expect(appendRelay).not.toHaveBeenCalled()
  })

  it('reaches no unrelated, disabled or disconnected bot', () => {
    const other = bot('other', { appId: 'someone-else', permissionEnabled: true, owners: ['boss'] })
    const disabled = bot('disabled', { appId: 'dh', enabled: false, permissionEnabled: true, owners: ['boss'] })
    const offline = bot('i1', { appId: 'dh', permissionEnabled: true, owners: ['boss'] })
    instances.set('i1', { isConnected: () => false, pushToChat: offline })
    for (const id of ['other', 'disabled', 'i1']) chat(id, 'direct', 'boss')

    deliverEscalationToIm(question(), 'Release Bot')

    for (const push of [other, disabled, offline]) expect(push).not.toHaveBeenCalled()
    expect(recordChatPush).not.toHaveBeenCalled()
    expect(appendRelay).not.toHaveBeenCalled()
  })

  it('logs why a question reached nobody and where a later delivery went', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    deliverEscalationToIm(question(), 'Release Bot')
    bot('i1', { appId: 'dh', permissionEnabled: true, owners: ['boss'] })
    deliverEscalationToIm(question(), 'Release Bot')
    chat('i1', 'direct', 'boss')
    deliverEscalationToIm(question(), 'Release Bot')

    const lines = log.mock.calls.map(([line]) => String(line)).filter(line => line.includes('Question entry-1'))
    expect(lines[0]).toContain('no enabled IM bot serves this digital human')
    expect(lines[1]).toContain('no owner direct chat known to its bots, and no originating team group')
    expect(lines[2]).toContain('sent to IM: bots=1, offline=0, ownerChats=1, groups=0, asked=1')
  })

  it('logs when the serving bot is offline', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const push = bot('i1', { appId: 'dh', permissionEnabled: true, owners: ['boss'] })
    instances.set('i1', { isConnected: () => false, pushToChat: push })

    deliverEscalationToIm(question(), 'Release Bot')

    expect(log).toHaveBeenCalledWith(expect.stringContaining('its IM bots are not connected'))
    expect(push).not.toHaveBeenCalled()
    expect(appendRelay).not.toHaveBeenCalled()
  })

  it.each(['manager', 'registry'] as const)('leaves questions in Halo when the %s is unavailable', missing => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    available[missing] = false

    expect(() => deliverEscalationToIm(question(), 'Release Bot')).not.toThrow()

    expect(log).toHaveBeenCalledWith(expect.stringContaining('IM channels are not running'))
    expect(recordChatPush).not.toHaveBeenCalled()
    expect(appendRelay).not.toHaveBeenCalled()
  })

  it('records a delivered question but warns when relay context cannot be queued', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const push = bot('i1', { appId: 'dh', permissionEnabled: true, owners: ['boss'] })
    chat('i1', 'direct', 'boss')
    available.spool = false

    expect(() => deliverEscalationToIm(question(), 'Release Bot')).not.toThrow()

    expect(push).toHaveBeenCalledOnce()
    expect(recordChatPush).toHaveBeenCalledOnce()
    expect(appendRelay).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('without relay context: spool is unavailable'))
  })
})

describe('the question the owner reads', () => {
  it('includes every question and choice without imposing an answer command or line format', () => {
    const text = formatQuestion(question({
      summary: 'Two things before the release',
      questions: [{ question: 'Ship tonight?', choices: ['Yes', 'No'] }, { question: 'Who signs off?' }],
    }), 'Release Bot')

    expect(text).toContain('Two things before the release')
    expect(text).toContain('1. Ship tonight?')
    expect(text).toContain('   A. Yes')
    expect(text).toContain('2. Who signs off?')
    expect(text).toContain('直接回复我就行')
    expect(text).not.toMatch(/\/answer|编号|每行写一个答案/)
  })

  it('bounds supporting data without splitting a surrogate pair or exposing its local path', () => {
    const text = formatQuestion(question({ data: 'x'.repeat(1499) + '\uD83D\uDE00'.repeat(10), dataPath: '/private/report.md' }), 'Release Bot')

    expect(text).toContain('x'.repeat(1499) + '…')
    expect(text).not.toContain('\uD83D')
    expect(text).toContain('完整内容请在 Halo 里查看')
    expect(text).not.toContain('/private/report.md')
    expect(text).toContain('直接回复我就行')
  })
})
