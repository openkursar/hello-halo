/**
 * Unit tests for apps/runtime/im-escalation — a question a digital human asks,
 * over IM: who is asked, who is only told, and how an owner answers it there.
 *
 * Before this, a question reached Halo's own screens and the desktop only; a
 * person who works with the digital human through an IM bot never saw it and
 * had no way to answer, so the work stopped without a word.
 *
 * Answers run against a real activity store: `respond` is the store's
 * `acceptDecision`, the step every answer — Halo's own included — goes through.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { config, registrySessions, instances, epochs, recordChatPush } = vi.hoisted(() => ({
  config: { imChannels: { instances: [] as Array<Record<string, unknown>> } },
  registrySessions: [] as Array<Record<string, unknown>>,
  instances: new Map<string, { providerType?: string; isConnected: () => boolean; pushToChat: (chatId: string, text: string, chatType: 'direct' | 'group') => boolean }>(),
  epochs: new Map<string, { chatKey?: string }>(),
  recordChatPush: vi.fn(),
}))

vi.mock('../../../../src/main/foundation/config.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConfig: () => config,
}))
vi.mock('../../../../src/main/apps/runtime/im-channels', () => ({
  getActiveImChannelManager: () => ({ getInstance: (id: string) => instances.get(id) }),
}))
vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: () => ({ listAll: () => registrySessions.map(s => ({ ...s })) }),
}))
vi.mock('../../../../src/main/apps/team', () => ({
  getTeamStore: () => ({ getEpochById: (id: string) => epochs.get(id) ?? null }),
}))
vi.mock('../../../../src/main/apps/runtime/chat-push', () => ({ recordChatPush }))

import {
  answerEscalationFromIm,
  deliverEscalationToIm,
  parseAnswerCommand,
  type AnswerDeps,
  type AnswerSender,
} from '../../../../src/main/apps/runtime/im-escalation'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { migrations as managerMigrations } from '../../../../src/main/apps/manager/migrations'
import { migrations } from '../../../../src/main/apps/runtime/migrations'
import { ActivityStore } from '../../../../src/main/apps/runtime/store'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
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

function question(content: Partial<ActivityEntry['content']>, appId = 'dh'): ActivityEntry {
  return {
    id: 'entry-1', appId, runId: 'run-1', type: 'escalation', ts: 1,
    content: { summary: 'Ship the release tonight?', number: 7, ...content },
  }
}

beforeEach(() => {
  config.imChannels.instances.length = 0
  registrySessions.length = 0
  instances.clear()
  epochs.clear()
  recordChatPush.mockClear()
})

describe('asking over IM', () => {
  it('asks the owners in their direct chats, tells result groups only that a question waits, and no one else', () => {
    const push = bot('i1', { appId: 'dh', permissionEnabled: true, owners: ['boss'] })
    chat('i1', 'direct', 'boss', { contactId: 'boss' })
    chat('i1', 'direct', 'customer', { contactId: 'customer', proactive: true })
    chat('i1', 'group', 'ops-group', { proactive: true })
    chat('i1', 'group', 'chatter-group')

    deliverEscalationToIm(question({ choices: ['Yes', 'No'] }), 'Release Bot')

    expect(push.mock.calls.map(([chatId, , type]) => [chatId, type])).toEqual([['boss', 'direct'], ['ops-group', 'group']])
    const asked = push.mock.calls[0][1] as string
    expect(asked).toContain('【Release Bot】需要你决定（编号 7）')
    expect(asked).toContain('Ship the release tonight?')
    expect(asked).toContain('A. Yes')
    expect(asked).toContain('B. No')
    expect(asked).toContain('/answer 7')
    const told = push.mock.calls[1][1] as string
    expect(told).toContain('有一个问题在等主人回复（编号 7）')
    expect(told).not.toContain('Ship the release')
  })

  it('knows a direct chat\'s owner by who is on the other side, not by the chat\'s own id', () => {
    const push = bot('i1', { appId: 'dh', permissionEnabled: true, owners: ['ou_boss'] })
    chat('i1', 'direct', 'oc_chat_42', { contactId: 'ou_boss' })

    deliverEscalationToIm(question({}), 'Release Bot')

    expect(push).toHaveBeenCalledWith('oc_chat_42', expect.stringContaining('需要你决定'), 'direct')
  })

  it('with no owner list, asks the direct chats chosen to receive results, not every contact', () => {
    const push = bot('i1', { appId: 'dh', permissionEnabled: false })
    chat('i1', 'direct', 'follower', { proactive: true })
    chat('i1', 'direct', 'passer-by')

    deliverEscalationToIm(question({}), 'Release Bot')

    expect(push.mock.calls.map(([chatId]) => chatId)).toEqual(['follower'])
  })

  it('asks the owners of the bot a team works behind, and tells the group the work came from', () => {
    const push = bot('team-bot', { appId: 'lead', teamId: 't1', permissionEnabled: true, owners: ['boss'] })
    chat('team-bot', 'direct', 'boss', { appId: 'lead', contactId: 'boss' })
    chat('team-bot', 'group', 'project-group', { appId: 'lead' })
    epochs.set('e1', { chatKey: 'team-bot:group:project-group' })

    deliverEscalationToIm(question({ teamContext: { teamId: 't1', epochId: 'e1' } }, 'researcher'), 'Researcher')

    expect(push.mock.calls.map(([chatId, , type]) => [chatId, type])).toEqual([['boss', 'direct'], ['project-group', 'group']])
    // Kept where the bot's chats are kept, and sent by: the digital human it serves.
    expect(recordChatPush.mock.calls.map(([sent]) => [sent.appId, sent.pushedBy, sent.chatId])).toEqual([['lead', 'lead', 'boss'], ['lead', 'lead', 'project-group']])
  })

  it('reaches no bot of another digital human, and none that is offline', () => {
    const other = bot('other', { appId: 'someone-else', permissionEnabled: true, owners: ['boss'] })
    chat('other', 'direct', 'boss', { contactId: 'boss' })
    const offline = bot('i1', { appId: 'dh', permissionEnabled: true, owners: ['boss'] })
    instances.set('i1', { isConnected: () => false, pushToChat: offline })
    chat('i1', 'direct', 'boss', { contactId: 'boss' })

    deliverEscalationToIm(question({}), 'Release Bot')

    expect(other).not.toHaveBeenCalled()
    expect(offline).not.toHaveBeenCalled()
  })

  it('logs where each question went, and why when it reached no chat', () => {
    // "IM never got the question" has to be answerable from the log alone.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      bot('i1', { appId: 'dh', permissionEnabled: true, owners: ['boss'] })
      chat('i1', 'direct', 'stranger', { contactId: 'stranger' })
      deliverEscalationToIm(question({}), 'Release Bot')
      chat('i1', 'direct', 'boss', { contactId: 'boss' })
      deliverEscalationToIm(question({}), 'Release Bot')

      const lines = log.mock.calls.map(([line]) => String(line)).filter(line => line.includes('Question entry-1'))
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain('reached no IM chat (no owner direct chat known to its bots, and no group receives results)')
      expect(lines[0]).toContain('bots=1, offline=0, ownerChats=0')
      expect(lines[1]).toContain('sent to IM: bots=1, offline=0, ownerChats=1, groups=0, asked=1')
    } finally {
      log.mockRestore()
    }
  })

  it('logs a question no bot serves, and one whose bots are offline', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      deliverEscalationToIm(question({}), 'Release Bot')
      const offline = bot('i1', { appId: 'dh', permissionEnabled: true, owners: ['boss'] })
      instances.set('i1', { isConnected: () => false, pushToChat: offline })
      deliverEscalationToIm(question({}), 'Release Bot')

      const lines = log.mock.calls.map(([line]) => String(line)).filter(line => line.includes('Question entry-1'))
      expect(lines[0]).toContain('no enabled IM bot serves this digital human')
      expect(lines[1]).toContain('its IM bots are not connected')
    } finally {
      log.mockRestore()
    }
  })

  it('keeps what it sent in the record of each chat it reached, as a question pushed there', () => {
    const push = bot('i1', { appId: 'dh', permissionEnabled: true, owners: ['boss'] })
    chat('i1', 'direct', 'boss', { contactId: 'boss' })
    chat('i1', 'group', 'ops-group', { proactive: true })
    chat('i1', 'group', 'unreachable-group', { proactive: true })
    push.mockImplementation((chatId: string) => chatId !== 'unreachable-group')

    deliverEscalationToIm(question({}), 'Release Bot')

    expect(recordChatPush.mock.calls.map(([sent]) => sent)).toEqual([
      { appId: 'dh', channel: 'wecom-bot', chatType: 'direct', chatId: 'boss', text: push.mock.calls[0][1], via: 'question', pushedBy: 'dh' },
      { appId: 'dh', channel: 'wecom-bot', chatType: 'group', chatId: 'ops-group', text: push.mock.calls[1][1], via: 'question', pushedBy: 'dh' },
    ])
  })

  it('lists several decisions, and asks for one answer per line', () => {
    const push = bot('i1', { appId: 'dh', permissionEnabled: true, owners: ['boss'] })
    chat('i1', 'direct', 'boss', { contactId: 'boss' })

    deliverEscalationToIm(question({
      summary: 'Two things before the release',
      questions: [{ question: 'Ship tonight?', choices: ['Yes', 'No'] }, { question: 'Who signs off?' }],
    }), 'Release Bot')

    const asked = push.mock.calls[0][1] as string
    expect(asked).toContain('1. Ship tonight?')
    expect(asked).toContain('   A. Yes')
    expect(asked).toContain('2. Who signs off?')
    expect(asked).toContain('每行写一个答案')
  })
})

describe('what counts as an answer command', () => {
  it('in a direct chat, a message that starts with it', () => {
    expect(parseAnswerCommand('/answer 7 A', 'direct')).toBe('7 A')
    expect(parseAnswerCommand('/Answer 7 A', 'direct')).toBe('7 A')
    expect(parseAnswerCommand('/answer', 'direct')).toBe('')
    expect(parseAnswerCommand('/answer 7\nA\nB', 'direct')).toBe('7\nA\nB')
  })

  it('in a group, right after the mentions the message starts with', () => {
    // WeCom ends a mention with U+2005, so a bot name may hold spaces.
    expect(parseAnswerCommand('@Halo AI 团队\u2005/answer 7 A', 'group')).toBe('7 A')
    expect(parseAnswerCommand('@Halo\u2005@张三\u2005 /answer 7 A', 'group')).toBe('7 A')
    expect(parseAnswerCommand('@Halo /answer 7 A', 'group')).toBe('7 A')
    expect(parseAnswerCommand('@Halo @张三 /answer 7 A', 'group')).toBe('7 A')
    // The bot's own mention removed by the platform (Feishu).
    expect(parseAnswerCommand('/answer 7 A', 'group')).toBe('7 A')
  })

  it('never an ordinary message that mentions it, wherever it sits', () => {
    expect(parseAnswerCommand('please /answer 7', 'direct')).toBeNull()
    expect(parseAnswerCommand('hello /answer 7', 'group')).toBeNull()
    expect(parseAnswerCommand('@bot 我晚点用 /answer 回复', 'group')).toBeNull()
    expect(parseAnswerCommand('@Halo\u2005我想问 /answer 7 怎么用', 'group')).toBeNull()
    expect(parseAnswerCommand('/answers 7', 'direct')).toBeNull()
    expect(parseAnswerCommand('the answer is 7', 'direct')).toBeNull()
  })

  it('reads a mention typed by hand as ending at its first space', () => {
    // A real WeCom mention ends with U+2005; without it a name with spaces
    // cannot be told from the words after it, so nothing is taken as an answer.
    expect(parseAnswerCommand('@Halo AI 团队 /answer 7 A', 'group')).toBeNull()
  })
})

describe('answering from IM', () => {
  let manager: DatabaseManager
  let store: ActivityStore
  let deps: AnswerDeps

  const owner: AnswerSender = { appId: 'dh', senderId: 'boss', chatType: 'direct', permissionEnabled: true, owners: ['boss'] }

  function ask(id: string, content: Partial<ActivityEntry['content']> = {}, appId = 'dh'): number {
    const number = store.nextEscalationNumber()
    store.insertRun({ runId: id, appId, sessionKey: `session-${id}`, status: 'waiting_user', triggerType: 'manual', startedAt: Date.now() })
    store.insertEntry({ id, appId, runId: id, type: 'escalation', ts: Date.now(), content: { summary: 'Ship tonight?', choices: ['Yes', 'No'], number, ...content } })
    return number
  }

  beforeEach(() => {
    manager = createDatabaseManager(':memory:')
    const db = manager.getAppDatabase()
    manager.runMigrations(db, 'app_manager', managerMigrations)
    manager.runMigrations(db, 'app_runtime', migrations)
    for (const id of ['dh', 'other']) {
      db.prepare(`INSERT INTO installed_apps(id, spec_id, space_id, spec_json, installed_at) VALUES (?, ?, 'space', '{"type":"automation"}', 1)`).run(id, `spec-${id}`)
    }
    store = new ActivityStore(db)
    deps = {
      pendingEscalations: () => store.getAllPendingEscalations(),
      escalationByNumber: number => store.getEscalationByNumber(number),
      isRunClosed: runId => store.isRunClosed(runId),
      respond: vi.fn(async (appId: string, entryId: string, response) => store.acceptDecision(appId, entryId, response)),
    }
  })

  afterEach(() => manager.closeAll())

  it('numbers questions in the order they are asked, and finds each by its number', () => {
    const first = ask('a')
    const second = ask('b')

    expect(second).toBe(first + 1)
    expect(store.getEscalationByNumber(second)?.id).toBe('b')
    expect(store.getEscalationByNumber(second + 1)).toBeNull()
  })

  it('takes an owner\'s answer by number and letter, the way Halo takes an answer, and the work goes on', async () => {
    const number = ask('a')

    const { reply } = await answerEscalationFromIm(`${number} A`, owner, deps)

    expect(reply).toBe(`已收到，任务继续。（编号 ${number} 的问题）`)
    expect(store.getEntry('a')?.userResponse?.choice).toBe('Yes')
    expect(store.getEntry('a')?.continuation?.status).toBe('queued')
  })

  it('takes the answer without a number while one question is open, in the owner\'s own words', async () => {
    ask('a')

    await answerEscalationFromIm('Yes, but after 10pm', owner, deps)

    expect(store.getEntry('a')?.userResponse?.text).toBe('Yes, but after 10pm')
  })

  it('asks for the number when several questions are open, and answers none', async () => {
    const one = ask('a')
    const two = ask('b')

    const { reply } = await answerEscalationFromIm('A', owner, deps)

    expect(reply).toContain('有 2 个问题在等你回答')
    expect(reply).toContain(`${one}、${two}`)
    expect(deps.respond).not.toHaveBeenCalled()
  })

  it('answers only for an owner, and in a group only where there is an owner list', async () => {
    ask('a')

    expect((await answerEscalationFromIm('A', { ...owner, senderId: 'customer' }, deps)).reply).toBe('只有主人可以回答这个问题。')
    expect((await answerEscalationFromIm('A', { ...owner, chatType: 'group', permissionEnabled: false, owners: [] }, deps)).reply)
      .toBe('请在与机器人的私聊里回答。')
    expect(deps.respond).not.toHaveBeenCalled()
    // An owner in a group the bot serves is still the owner.
    expect((await answerEscalationFromIm('A', { ...owner, chatType: 'group' }, deps)).reply).toContain('已收到')
  })

  it('says when a question was already answered, closed or expired, and changes nothing', async () => {
    const answered = ask('a')
    await answerEscalationFromIm(`${answered} A`, owner, deps)
    expect((await answerEscalationFromIm(`${answered} B`, owner, deps)).reply).toBe(`编号 ${answered} 的问题已经回答过了。`)
    expect(store.getEntry('a')?.userResponse?.choice).toBe('Yes')

    const expired = ask('b', { deadlineAt: Date.now() - 1000 })
    expect((await answerEscalationFromIm(`${expired} A`, owner, deps)).reply).toBe(`编号 ${expired} 的问题已过期。`)

    const closed = ask('c')
    store.closeRun('c')
    expect((await answerEscalationFromIm(`${closed} A`, owner, deps)).reply).toBe(`编号 ${closed} 的问题已经关闭，不需要再回答。`)
    expect(deps.respond).toHaveBeenCalledTimes(1)
  })

  it('never reads a number it cannot find as an answer to the one open question', async () => {
    // A mistyped number, or a question since removed: "99 A" is no answer to #N.
    const open = ask('a')

    const result = await answerEscalationFromIm('99 A', owner, deps)
    const bare = await answerEscalationFromIm('99', owner, deps)

    expect(result).toMatchObject({ outcome: 'no_such_number' })
    expect(result.reply).toContain('没有找到编号 99 的问题')
    expect(result.reply).toContain(`/answer ${open} 你的答案`)
    expect(bare.outcome).toBe('no_such_number')
    expect(deps.respond).not.toHaveBeenCalled()
    expect(store.getEntry('a')?.userResponse).toBeUndefined()
  })

  it('tells the outcome of every answer for the log, and the question it was for', async () => {
    const number = ask('a')

    expect(await answerEscalationFromIm(`${number} A`, { ...owner, senderId: 'customer' }, deps)).toMatchObject({ outcome: 'not_owner' })
    expect(await answerEscalationFromIm(`${number} A`, owner, deps)).toMatchObject({ outcome: 'answered', entryId: 'a' })
    expect(await answerEscalationFromIm(`${number} B`, owner, deps)).toMatchObject({ outcome: 'already_answered', entryId: 'a' })
  })

  it('says a failed submission in words the chat can use, and keeps the runtime\'s words for the log', async () => {
    const number = ask('a')
    deps.respond = vi.fn(async () => { throw new Error('This decision has already been answered differently') })

    const result = await answerEscalationFromIm(`${number} A`, owner, deps)

    expect(result.outcome).toBe('submit_failed')
    expect(result.reply).toContain('请在 Halo 里查看')
    expect(result.reply).not.toContain('decision')
    expect(result.error).toBe('This decision has already been answered differently')
  })

  it('sends questions asked before numbering existed to Halo', async () => {
    for (const id of ['old-1', 'old-2']) {
      store.insertRun({ runId: id, appId: 'dh', sessionKey: `session-${id}`, status: 'waiting_user', triggerType: 'manual', startedAt: Date.now() })
      store.insertEntry({ id, appId: 'dh', runId: id, type: 'escalation', ts: Date.now(), content: { summary: 'Old question' } })
    }

    const result = await answerEscalationFromIm('A', owner, deps)

    expect(result.outcome).toBe('number_needed')
    expect(result.reply).toContain('另有 2 个较早的问题没有编号，请在 Halo 里回答')
  })

  it('never lands an answer on another question: another digital human\'s number is not found here', async () => {
    const elsewhere = ask('theirs', {}, 'other')
    ask('mine')

    const { reply } = await answerEscalationFromIm(`${elsewhere} A`, owner, deps)

    expect(reply).toContain(`没有找到编号 ${elsewhere} 的问题`)
    expect(deps.respond).not.toHaveBeenCalled()
  })

  it('reads one answer per line for several decisions, and says how when the lines do not match', async () => {
    const number = ask('a', { choices: undefined, questions: [{ question: 'Ship tonight?', choices: ['Yes', 'No'] }, { question: 'Who signs off?' }] })

    expect((await answerEscalationFromIm(`${number}\nB`, owner, deps)).reply).toContain('这个问题包含 2 项')
    expect((await answerEscalationFromIm(`${number}\nB\nLin`, owner, deps)).reply).toContain('已收到')
    expect(store.getEntry('a')?.userResponse?.answers).toEqual([{ choice: 'No' }, { text: 'Lin' }])
  })

  it('keeps a letter that starts a longer answer as words', async () => {
    const number = ask('a')

    await answerEscalationFromIm(`${number} A good plan, go ahead`, owner, deps)

    expect(store.getEntry('a')?.userResponse).toMatchObject({ text: 'A good plan, go ahead' })
  })
})
