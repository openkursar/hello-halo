/** Questions go privately to owners; only the originating team group gets a waiting notice. */
import { randomUUID } from 'crypto'
import type { ActivityEntry } from '../../../shared/apps/app-types'
import { getEscalationQuestions } from '../../../shared/apps/app-types'
import { buildRunSenderKey, parseTeamChatKey } from '../../../shared/apps/im-keys'
import { getConfig } from '../../foundation/config.service'
import { getTeamStore } from '../team'
import { getActiveImChannelManager } from './im-channels'
import { getImSessionRegistry } from './im-session-registry'
import { truncateUtf16Safe } from './text-truncate'
import { recordChatPush } from './chat-push'
import { getPendingRelayStore } from './pending-relays'
import { resolveImPushConversation } from './im-team-session'
import { receivesImQuestions } from './im-sender-standing'

const LOG_TAG = '[ImEscalation]'
const MAX_DATA_CHARS = 1500

/** Delivery is best-effort: a question that cannot reach IM remains open in Halo. */
export function deliverEscalationToIm(entry: ActivityEntry, appName: string): void {
  const tag = `Question ${entry.id}`
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
    const notice = `「${appName}」的这项工作在等主人决定。主人可以直接回复机器人的私聊，或在 Halo 里回答。`
    const counts = { bots: 0, offline: 0, ownerChats: 0, groups: 0, asked: 0, told: 0, failed: 0, unroutable: 0 }
    const allSessions = registry.listAll()

    for (const cfg of getConfig().imChannels?.instances ?? []) {
      if (!cfg.enabled || !(cfg.appId === entry.appId || (team && cfg.teamId === team.teamId))) continue
      counts.bots++
      const instance = manager.getInstance(cfg.id)
      if (!instance?.isConnected()) {
        counts.offline++
        continue
      }
      const owners = allSessions.filter(session => receivesImQuestions(cfg, session))
      const groups = origin?.instanceId === cfg.id && origin.chatType === 'group' ? [origin.chatId] : []
      counts.ownerChats += owners.length
      counts.groups += groups.length
      const pushed = (chatId: string, chatType: 'direct' | 'group', text: string) =>
        recordChatPush({ appId: cfg.appId, channel: instance.providerType, chatType, chatId, text, via: 'question', pushedBy: entry.appId })

      for (const session of owners) {
        const destination = resolveImPushConversation(session, cfg)
        if (!destination) {
          counts.unroutable++
          continue // The resolver logs the unavailable destination.
        }
        if (instance.pushToChat(session.chatId, question, 'direct')) {
          counts.asked++
          registry.setTeamContext(session.appId, session.channel, session.chatId, destination.teamContext ?? undefined)
          recordChatPush({ appId: cfg.appId, channel: instance.providerType, chatType: 'direct', chatId: session.chatId,
            text: question, via: 'question', pushedBy: entry.appId, teamContext: destination.teamContext })
          const targetKey = destination.conversationId
          const spool = getPendingRelayStore()
          if (spool) {
            spool.append(targetKey, {
              kind: 'push', id: randomUUID(), at: Date.now(),
              source: { key: entry.sessionKey ?? buildRunSenderKey(entry.appId, entry.runId), appId: entry.appId, runId: entry.runId, label: appName },
              // Answering a question does not invite reading the whole originating chat.
              sourceOwner: false,
              message: question,
              action: { kind: 'answer-question', appId: entry.appId, entryId: entry.id },
            })
          } else {
            console.warn(`${LOG_TAG} ${tag} sent to ${targetKey} without relay context: spool is unavailable`)
          }
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
      `groups=${counts.groups}, asked=${counts.asked}, told=${counts.told}, failed=${counts.failed}, unroutable=${counts.unroutable}`
    if (counts.failed > 0) {
      console.warn(`${LOG_TAG} ${tag} had rejected IM sends: ${summary}`)
    } else if (counts.asked + counts.told > 0) {
      console.log(`${LOG_TAG} ${tag} sent to IM: ${summary}`)
    } else {
      console.log(`${LOG_TAG} ${tag} reached no IM chat (${undeliveredReason(counts)}): ${summary}`)
    }
  } catch (err) {
    console.warn(`${LOG_TAG} ${tag} could not be sent to IM:`, err)
  }
}

function undeliveredReason(counts: { bots: number; offline: number; unroutable: number }): string {
  if (counts.bots === 0) return 'no enabled IM bot serves this digital human'
  if (counts.offline === counts.bots) return 'its IM bots are not connected'
  if (counts.unroutable > 0) return 'the owner team chats cannot accept a reply'
  return 'no owner direct chat known to its bots, and no originating team group'
}

function teamOriginChat(epochId: string): ReturnType<typeof parseTeamChatKey> {
  const chatKey = getTeamStore()?.getEpochById(epochId)?.chatKey
  return chatKey ? parseTeamChatKey(chatKey) : null
}

function choiceLines(choices: string[] | undefined, indent = ''): string[] {
  return (choices ?? []).map((choice, i) => `${indent}${String.fromCharCode(65 + i)}. ${choice}`)
}

export function formatQuestion(entry: ActivityEntry, appName: string): string {
  const { content } = entry
  const lines = [`「${appName}」的任务需要你决定：${content.summary.trim()}`]
  if (typeof content.data === 'string' && content.data.trim()) {
    const data = content.data.trim()
    lines.push('', data.length > MAX_DATA_CHARS ? `${truncateUtf16Safe(data, MAX_DATA_CHARS)}…` : data)
  }
  if (content.dataPath || (typeof content.data === 'string' && content.data.trim().length > MAX_DATA_CHARS)) {
    lines.push('（完整内容请在 Halo 里查看）')
  }
  const questions = getEscalationQuestions(content)
  if (content.questions?.length) {
    lines.push('')
    questions.forEach((q, i) => lines.push(`${i + 1}. ${q.question}`, ...choiceLines(q.choices, '   ')))
  } else {
    const choices = choiceLines(questions[0].choices)
    if (choices.length > 0) lines.push('', ...choices)
  }
  lines.push('', '直接回复我就行，也可以在 Halo 里回答。')
  return lines.join('\n')
}
