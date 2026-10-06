/**
 * apps/runtime -- A question a digital human asks, over IM
 *
 * When a digital human asks for a decision (a `report_to_user` escalation),
 * people who reach it only through an IM bot get the question there, and its
 * owner can answer there: `/answer <number> <answer>` takes the path an answer
 * given in Halo takes (`respondToEscalation`), and the first answer wins.
 *
 *   who is asked   the full question goes only to owners' direct chats — a
 *                  decision may carry private details. With permission control
 *                  off there is no owner list, so the direct chats chosen to
 *                  receive results stand for it. A group that receives results,
 *                  or the group a team's work came from, is told only that a
 *                  question waits for the owner.
 *   who answers    with permission control on, a listed owner, in any chat;
 *                  with it off, a direct chat — never a group, where anyone could.
 *   which question every question carries a number (`content.number`); with a
 *                  single question open the number may be left out.
 *
 * IM-facing text is Chinese, like the bot's other notices: the main process
 * has no renderer i18n.
 */

import type { ActivityEntry, EscalationAnswer, EscalationQuestion, EscalationResponse } from '../../../shared/apps/app-types'
import { getEscalationQuestions } from '../../../shared/apps/app-types'
import type { ImChannelInstanceConfig, ImSessionRecord } from '../../../shared/types/im-channel'
import { parseTeamChatKey } from '../../../shared/apps/im-keys'
import { getConfig } from '../../foundation/config.service'
import { getTeamStore } from '../team'
import { getActiveImChannelManager } from './im-channels'
import { getImSessionRegistry } from './im-session-registry'
import { truncateUtf16Safe } from './text-truncate'
import { recordChatPush } from './chat-push'

const LOG_TAG = '[ImEscalation]'

/** Inline details are part of the question; a long document stays in Halo. */
const MAX_DATA_CHARS = 1500

// ── Asking ──

/**
 * Tell the bot's owners about a new question, and the groups that follow this
 * digital human that one is waiting. Never throws: a question that cannot reach
 * IM is still open in Halo.
 */
export function deliverEscalationToIm(entry: ActivityEntry, appName: string): void {
  const tag = `Question ${entry.id} (number ${entry.content.number ?? 'none'})`
  try {
    const manager = getActiveImChannelManager()
    const registry = getImSessionRegistry()
    if (!manager || !registry) {
      console.log(`${LOG_TAG} ${tag} not sent to IM: IM channels are not running`)
      return
    }

    const team = entry.content.teamContext
    const origin = team ? teamOriginChat(team.epochId) : null
    const question = formatQuestion(entry, appName)
    const notice = formatNotice(entry, appName)
    // One line per question, whatever happened: "IM never got the question"
    // has to be answerable from the log alone.
    const counts = { bots: 0, offline: 0, ownerChats: 0, groups: 0, asked: 0, told: 0, failed: 0 }

    for (const cfg of getConfig().imChannels?.instances ?? []) {
      if (!cfg.enabled || !(cfg.appId === entry.appId || (team && cfg.teamId === team.teamId))) continue
      counts.bots++
      const instance = manager.getInstance(cfg.id)
      if (!instance?.isConnected()) {
        counts.offline++
        continue
      }
      const sessions = registry.listAll().filter(s => s.instanceId === cfg.id && s.source === 'im')
      const owners = sessions.filter(s => s.chatType === 'direct' && asksHere(cfg, s))
      const groups = new Set(sessions.filter(s => s.chatType === 'group' && s.proactive).map(s => s.chatId))
      if (origin?.instanceId === cfg.id && origin.chatType === 'group') groups.add(origin.chatId)
      counts.ownerChats += owners.length
      counts.groups += groups.size
      // The chats are the bot's, kept under — and asked from — the digital human it serves.
      const pushed = (chatId: string, chatType: 'direct' | 'group', text: string) =>
        recordChatPush({ appId: cfg.appId, channel: instance.providerType, chatType, chatId, text, via: 'question', pushedBy: cfg.appId })

      for (const session of owners) {
        if (instance.pushToChat(session.chatId, question, 'direct')) {
          counts.asked++
          pushed(session.chatId, 'direct', question)
        } else counts.failed++
      }
      for (const chatId of groups) {
        if (instance.pushToChat(chatId, notice, 'group')) {
          counts.told++
          pushed(chatId, 'group', notice)
        } else counts.failed++
      }
    }

    const summary = `bots=${counts.bots}, offline=${counts.offline}, ownerChats=${counts.ownerChats}, ` +
      `groups=${counts.groups}, asked=${counts.asked}, told=${counts.told}, failed=${counts.failed}`
    if (counts.asked + counts.told > 0) {
      console.log(`${LOG_TAG} ${tag} sent to IM: ${summary}`)
    } else {
      console.log(`${LOG_TAG} ${tag} reached no IM chat (${undeliveredReason(counts)}): ${summary}`)
    }
  } catch (err) {
    console.warn(`${LOG_TAG} ${tag} could not be sent to IM:`, err)
  }
}

function undeliveredReason(counts: { bots: number; offline: number; ownerChats: number; groups: number }): string {
  if (counts.bots === 0) return 'no enabled IM bot serves this digital human'
  if (counts.offline === counts.bots) return 'its IM bots are not connected'
  if (counts.ownerChats + counts.groups === 0) {
    return 'no owner direct chat known to its bots, and no group receives results'
  }
  return 'every send failed'
}

/** Whether a direct chat gets the full question: an owner's, or with no owner list one chosen to receive results. */
function asksHere(cfg: ImChannelInstanceConfig, session: ImSessionRecord): boolean {
  if (!cfg.permissionEnabled) return session.proactive
  return (cfg.owners ?? []).includes(session.contactId ?? session.chatId)
}

/** The IM chat a team's conversation epoch serves, when it serves one. */
function teamOriginChat(epochId: string): ReturnType<typeof parseTeamChatKey> {
  const chatKey = getTeamStore()?.getEpochById(epochId)?.chatKey
  return chatKey ? parseTeamChatKey(chatKey) : null
}

function choiceLines(choices: string[] | undefined, indent = ''): string[] {
  return (choices ?? []).map((choice, i) => `${indent}${String.fromCharCode(65 + i)}. ${choice}`)
}

export function formatQuestion(entry: ActivityEntry, appName: string): string {
  const { content } = entry
  const number = content.number
  const lines = [`【${appName}】需要你决定${number ? `（编号 ${number}）` : ''}：`, content.summary.trim()]

  if (typeof content.data === 'string' && content.data.trim()) {
    const data = content.data.trim()
    lines.push('', data.length > MAX_DATA_CHARS ? `${truncateUtf16Safe(data, MAX_DATA_CHARS)}…` : data)
  }
  if (content.dataPath || (typeof content.data === 'string' && content.data.trim().length > MAX_DATA_CHARS)) {
    lines.push('（完整内容请在 Halo 里查看）')
  }

  const questions = getEscalationQuestions(content)
  const command = number ? `/answer ${number}` : '/answer'
  if (content.questions?.length) {
    lines.push('')
    questions.forEach((q, i) => lines.push(`${i + 1}. ${q.question}`, ...choiceLines(q.choices, '   ')))
    lines.push('', `回复「${command}」并换行，每行写一个答案，按顺序对应上面的问题。也可以在 Halo 里回答。`)
  } else {
    const choices = choiceLines(questions[0].choices)
    if (choices.length > 0) lines.push('', '选项：', ...choices)
    lines.push('', `回复「${command} 你的答案」${choices.length > 0 ? '（可只写选项字母）' : ''}。也可以在 Halo 里回答。`)
  }
  return lines.join('\n')
}

function formatNotice(entry: ActivityEntry, appName: string): string {
  const number = entry.content.number
  return `【${appName}】有一个问题在等主人回复${number ? `（编号 ${number}）` : ''}。主人可以在与机器人的私聊里，或在 Halo 里回答。`
}

// ── Answering ──

const ANSWER_COMMAND = /^\/answer(?=\s|$)/i

/**
 * The mentions a group message to the bot starts with. A mention ends where
 * WeCom ends it (U+2005, so a name may hold spaces) or, typed by hand, at the
 * first space.
 */
const LEADING_MENTIONS = /^(?:@(?:[^@/\u2005\n]+\u2005|\S+\s)\s*)+/

/** `/answer` as a word of its own, followed by the number of the question it answers. */
const NUMBERED_ANSWER = /\s(\/answer\s+\d)/i

/**
 * The text after `/answer` when this message is one, else null. A direct
 * message must start with it; in a group it may also come right after the
 * mentions the message starts with — "@bot I'll /answer it later" is a
 * message, not an answer.
 *
 * Where a mention without WeCom's U+2005 ends cannot be told when the name
 * holds ordinary spaces ("@Halo AI Team /answer 3 A"). `/stop` counts there
 * when it ends the message; `/answer` counts further into it when it names
 * its question, which a sentence about answering does not.
 */
export function parseAnswerCommand(body: string, chatType: 'direct' | 'group'): string | null {
  let text = body.trim()
  if (chatType === 'group') {
    const afterMentions = text.replace(LEADING_MENTIONS, '')
    const numbered = text.startsWith('@') && !text.includes('\u2005') ? NUMBERED_ANSWER.exec(text) : null
    text = ANSWER_COMMAND.test(afterMentions) || !numbered ? afterMentions : text.slice(numbered.index + 1)
  }
  const match = ANSWER_COMMAND.exec(text)
  return match ? text.slice(match[0].length).trim() : null
}

/** Who wrote the command, and to which bot. */
export interface AnswerSender {
  /** The digital human the bot serves */
  appId: string
  /** The team the bot fronts, when it fronts one */
  teamId?: string
  senderId: string
  chatType: 'direct' | 'group'
  permissionEnabled: boolean
  owners: string[]
}

/** What answering needs from the runtime: the same calls Halo's own answer path makes. */
export interface AnswerDeps {
  pendingEscalations: () => ActivityEntry[]
  escalationByNumber: (number: number) => ActivityEntry | null
  isRunClosed: (runId: string) => boolean
  respond: (appId: string, entryId: string, response: EscalationResponse) => Promise<unknown>
}

/** How an `/answer` ended, for the log: a tag, never the answer itself. */
export type AnswerOutcome =
  | 'answered'
  | 'not_owner'
  | 'group_without_owner_list'
  | 'no_such_number'
  | 'number_needed'
  | 'none_pending'
  | 'answer_missing'
  | 'already_answered'
  | 'expired'
  | 'closed'
  | 'deadline_review'
  | 'answer_unreadable'
  | 'submit_failed'

export interface AnswerResult {
  /** What the chat is told */
  reply: string
  outcome: AnswerOutcome
  /** The question the answer was for, once one was found */
  entryId?: string
  /** Why submitting failed, as the runtime said it (not for the chat) */
  error?: string
}

/** Handle `/answer`: answer a question, or say why not. */
export async function answerEscalationFromIm(args: string, sender: AnswerSender, deps: AnswerDeps): Promise<AnswerResult> {
  if (sender.permissionEnabled ? !sender.owners.includes(sender.senderId) : sender.chatType !== 'direct') {
    return sender.permissionEnabled
      ? { reply: '只有主人可以回答这个问题。', outcome: 'not_owner' }
      : { reply: '请在与机器人的私聊里回答。', outcome: 'group_without_owner_list' }
  }

  const inScope = (entry: ActivityEntry) =>
    entry.appId === sender.appId || (!!sender.teamId && entry.content.teamContext?.teamId === sender.teamId)
  const pending = deps.pendingEscalations().filter(inScope)

  // A leading number is always a question's number, looked up as such: one this
  // bot cannot answer, or none at all (mistyped, or a question since removed),
  // is not found — never read as an answer to whichever question is open.
  // Without a number the only open question is meant.
  const numbered = /^(\d+)(?:\s+([\s\S]*))?$/.exec(args)
  let entry: ActivityEntry
  let answer: string
  if (numbered) {
    const named = deps.escalationByNumber(Number(numbered[1]))
    if (!named || !inScope(named)) {
      const hint = pending.length === 1 && pending[0].content.number !== undefined
        ? `如果要回答编号 ${pending[0].content.number} 的问题，请写「/answer ${pending[0].content.number} 你的答案」。`
        : listPending(pending)
      return { reply: `没有找到编号 ${numbered[1]} 的问题。${hint}`, outcome: 'no_such_number' }
    }
    entry = named
    answer = (numbered[2] ?? '').trim()
    if (!answer) {
      return { reply: `请在编号后写上你的答案，例如「/answer ${numbered[1]} A」。`, outcome: 'answer_missing', entryId: entry.id }
    }
  } else if (pending.length === 1) {
    entry = pending[0]
    answer = args
    if (!answer) return { reply: `请写上你的答案，例如「${commandFor(entry)} A」。`, outcome: 'answer_missing', entryId: entry.id }
  } else if (pending.length === 0) {
    return { reply: '现在没有在等你回答的问题。', outcome: 'none_pending' }
  } else {
    return {
      reply: `有 ${pending.length} 个问题在等你回答，请写明编号：「/answer 编号 你的答案」。${listPending(pending)}`,
      outcome: 'number_needed',
    }
  }

  const found = { entryId: entry.id }
  const label = entry.content.number ? `编号 ${entry.content.number} 的问题` : '这个问题'
  if (entry.userResponse) return { reply: `${label}已经回答过了。`, outcome: 'already_answered', ...found }
  if (entry.content.resolution?.reason === 'expired' || (entry.content.deadlineAt !== undefined && entry.content.deadlineAt <= Date.now())) {
    return { reply: `${label}已过期。`, outcome: 'expired', ...found }
  }
  if (entry.content.resolution || deps.isRunClosed(entry.runId)) {
    return { reply: `${label}已经关闭，不需要再回答。`, outcome: 'closed', ...found }
  }
  if (entry.content.deadlineReviewRequired) {
    return { reply: `${label}需要先在 Halo 里确认期限，然后才能回答。`, outcome: 'deadline_review', ...found }
  }

  const questions = getEscalationQuestions(entry.content)
  const response = responseFor(questions, answer)
  if (typeof response === 'string') return { reply: response, outcome: 'answer_unreadable', ...found }

  try {
    await deps.respond(entry.appId, entry.id, { ts: Date.now(), ...response })
  } catch (err) {
    // The checks above ran a moment ago; what failed now is most likely an
    // answer given elsewhere in between. The runtime's words go to the log.
    return {
      reply: `没能提交你的答案：${label}可能刚刚在别处被回答或关闭了，请在 Halo 里查看。`,
      outcome: 'submit_failed',
      ...found,
      error: (err as Error).message,
    }
  }
  return { reply: `已收到，任务继续。（${label}）`, outcome: 'answered', ...found }
}

function commandFor(entry: ActivityEntry): string {
  return entry.content.number ? `/answer ${entry.content.number}` : '/answer'
}

/** The open questions' numbers; questions asked before numbering existed are answered in Halo. */
function listPending(pending: ActivityEntry[]): string {
  const numbers = pending.map(entry => entry.content.number).filter((n): n is number => n !== undefined)
  const unnumbered = pending.length - numbers.length
  return (numbers.length > 0 ? `在等回答的编号：${numbers.join('、')}。` : '') +
    (unnumbered > 0 ? `另有 ${unnumbered} 个较早的问题没有编号，请在 Halo 里回答。` : '')
}

/** The answer as Halo's own answer path takes it, or why it cannot be read as one. */
function responseFor(questions: EscalationQuestion[], answer: string): Omit<EscalationResponse, 'ts'> | string {
  if (questions.length === 1) return answerFor(questions[0], answer)

  const lines = answer.split('\n').map(line => line.trim()).filter(Boolean)
  if (lines.length !== questions.length) {
    return `这个问题包含 ${questions.length} 项，请在「/answer」后换行，每行写一个答案：\n` +
      questions.map((q, i) => `${i + 1}. ${q.question}`).join('\n')
  }
  return { answers: questions.map((q, i) => answerFor(q, lines[i])) }
}

/**
 * A choice by its letter alone or by its words, else free text. A letter that
 * starts a longer answer stays text: "A good plan…" is not choice A.
 */
function answerFor(question: EscalationQuestion, raw: string): EscalationAnswer {
  const text = raw.trim()
  const choices = question.choices ?? []
  const lettered = /^([A-Za-z])[.、)）]?$/.exec(text)
  const index = lettered ? lettered[1].toUpperCase().charCodeAt(0) - 65 : -1
  if (index >= 0 && index < choices.length) return { choice: choices[index] }
  const exact = choices.find(choice => choice.trim().toLowerCase() === text.toLowerCase())
  return exact ? { choice: exact } : { text }
}

/** The runtime's own answer path, looked up when an answer arrives. Null before the runtime is up. */
export async function runtimeAnswerDeps(): Promise<AnswerDeps | null> {
  const { getActivityStore, getAppRuntime } = await import('./index')
  const store = getActivityStore()
  const runtime = getAppRuntime()
  if (!store || !runtime) return null
  return {
    pendingEscalations: () => store.getAllPendingEscalations(),
    escalationByNumber: number => store.getEscalationByNumber(number),
    isRunClosed: runId => store.isRunClosed(runId),
    respond: (appId, entryId, response) => runtime.respondToEscalation(appId, entryId, response),
  }
}
