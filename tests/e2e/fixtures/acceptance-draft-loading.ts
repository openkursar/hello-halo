import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { HaloApi } from '../../../src/renderer/api'
import { parseAppChatKey } from '../../../src/shared/apps/im-keys'
import type { TranscriptMessage } from '../../../src/shared/types/transcript'
import { expect, openManagedConversation, seedManagedConversation, seedManagedPerson } from './acceptance-management'
import { navigateToChat } from './helpers'
import { userLine, replyLine } from './seed-digital-human-chat'

export interface DraftSession {
  appId: string
  conversationId: string
  label: string
  file: string
  bytes: string
  messages: TranscriptMessage[]
}

export async function readNativeDraftHistory(page: Page, session: Pick<DraftSession, 'appId' | 'conversationId'>) {
  return page.evaluate(async session => {
    const result = await (window as unknown as { halo: HaloAPI }).halo.appChatTranscript({ ...session, spaceId: 'halo-temp' })
    if (!result.success || !result.data) throw new Error('The native transcript reader did not return the saved draft history')
    return result.data.messages
  }, { appId: session.appId, conversationId: session.conversationId })
}

export async function prepareDraftHistories(page: Page, profile: string) {
  await navigateToChat(page)
  const control = await seedManagedConversation(page, 'halo-temp', 'Ordinary draft control', [
    { role: 'user', content: 'Keep this ordinary control question unchanged.' },
    { role: 'assistant', content: 'Keep this ordinary control answer unchanged.' },
  ])
  const person = await seedManagedPerson(page, 'Loading draft person')
  const data = await page.evaluate(id => (window as unknown as { halo: HaloAPI }).halo.appGetDataPath(id), person.id)
  expect(data.success).toBe(true)
  const dataRoot = realpathSync(data.data!.path)
  const owned = relative(realpathSync(profile), dataRoot)
  expect(owned.length > 0 && !isAbsolute(owned) && owned !== '..' && !owned.startsWith(`..${sep}`)).toBe(true)
  const directory = join(dataRoot, 'runs')
  mkdirSync(directory, { recursive: true })
  const sessions: DraftSession[] = []
  for (const [index, label] of ['Draft Alpha', 'Draft Beta'].entries()) {
    const created = await page.evaluate(appId => (window as unknown as { halo: HaloAPI }).halo.appSessionCreate({ appId }), person.id)
    expect(created.success).toBe(true)
    const conversationId = created.data!.conversationId
    const key = parseAppChatKey(conversationId)
    expect(key).toMatchObject({ appId: person.id, channel: 'local', chatType: 'direct' })
    expect(key!.chatId).toMatch(/^[\da-f-]{36}$/i)
    const renamed = await page.evaluate(input => (window as unknown as { halo: HaloAPI }).halo.imSessionsSetCustomName(input), { appId: person.id, channel: 'local', chatId: key!.chatId, name: label })
    expect(renamed.success).toBe(true)
    const file = join(directory, `chat-local-direct-${key!.chatId}.jsonl`)
    expect(existsSync(file)).toBe(false)
    const token = randomUUID().slice(0, 8)
    const question = `${label} saved question ${token}`
    const answer = `${label} saved answer ${token}`
    const bytes = [
      userLine(question, new Date(Date.UTC(2026, 8, 2, 10, index * 2)).toISOString()),
      replyLine(answer, new Date(Date.UTC(2026, 8, 2, 10, index * 2, 30)).toISOString()),
    ].join('\n') + '\n'
    writeFileSync(file, bytes, { flag: 'wx' })
    const session = { appId: person.id, conversationId, label, file, bytes, messages: [] as TranscriptMessage[] }
    session.messages = await readNativeDraftHistory(page, session)
    expect(session.messages.map(message => ({ role: message.role, content: message.content }))).toEqual([{ role: 'user', content: question }, { role: 'assistant', content: answer }])
    sessions.push(session)
  }
  expect(new Set(sessions.map(session => session.conversationId)).size).toBe(2)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await openManagedConversation(page, control.title)
  return { person, sessions, control }
}

export interface DraftReadReceipt {
  conversationId: string
  held: boolean
  nativeCompleted: boolean
  nativeSuccess: boolean | null
  delivered: boolean
  messageIds: string[]
  error?: string
}

interface DraftDeliveryControl {
  read(): DraftReadReceipt[]
  release(conversationId: string): void
  restore(): DraftReadReceipt[]
}

interface DraftDeliveryWindow { acceptanceDraftDelivery?: DraftDeliveryControl }

export async function delayDraftHistoryDelivery(page: Page, appId: string, conversationIds: string[]) {
  await page.evaluate(async ({ appId, conversationIds }) => {
    const state = window as unknown as DraftDeliveryWindow
    if (state.acceptanceDraftDelivery) throw new Error('A transcript delivery gate is already installed')
    const entries = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'))
    if (entries.length !== 1) throw new Error(`Expected one already-loaded renderer module entry, found ${entries.length}`)
    const loaded = await import(entries[0].src)
    const matches = [...new Set(Object.values(loaded).filter(value => {
      const candidate = value as Partial<HaloApi> | null
      return candidate && typeof candidate === 'object' && typeof candidate.appChatTranscript === 'function' && typeof candidate.getConfig === 'function' && typeof candidate.listArtifactsTree === 'function'
    }))]
    if (matches.length !== 1) throw new Error(`Expected one publicly exported unified renderer API, found ${matches.length}`)
    const api = matches[0] as HaloApi
    const original = api.appChatTranscript
    const holds = new Map<string, { used: boolean; promise: Promise<void>; release: () => void }>()
    for (const conversationId of conversationIds) {
      let resume!: () => void
      const promise = new Promise<void>(resolve => { resume = resolve })
      holds.set(conversationId, { used: false, promise, release: resume })
    }
    const receipts: DraftReadReceipt[] = []
    const wrapped: HaloApi['appChatTranscript'] = async input => {
      const hold = input.appId === appId && input.spaceId === 'halo-temp' && input.conversationId && !input.before && !input.through ? holds.get(input.conversationId) : undefined
      if (!hold) return original.call(api, input)
      const held = !hold.used
      hold.used = true
      const receipt: DraftReadReceipt = { conversationId: input.conversationId!, held, nativeCompleted: false, nativeSuccess: null, delivered: false, messageIds: [] }
      receipts.push(receipt)
      try {
        const result = await original.call(api, input)
        receipt.nativeCompleted = true
        receipt.nativeSuccess = result.success
        receipt.messageIds = result.data?.messages.map(message => message.id) ?? []
        if (held) await hold.promise
        receipt.delivered = true
        return result
      } catch (error) {
        receipt.error = error instanceof Error ? error.name : 'UnknownError'
        throw error
      }
    }
    api.appChatTranscript = wrapped
    if (api.appChatTranscript !== wrapped) throw new Error('The renderer transcript transport could not be wrapped')
    state.acceptanceDraftDelivery = {
      read: () => receipts.map(receipt => ({ ...receipt, messageIds: [...receipt.messageIds] })),
      release: conversationId => {
        const hold = holds.get(conversationId)
        if (!hold) throw new Error('Cannot release an unrelated conversation read')
        hold.release()
      },
      restore: () => {
        try {
          if (api.appChatTranscript !== wrapped) throw new Error('The renderer transcript transport changed during this UI check')
          api.appChatTranscript = original
          if (api.appChatTranscript !== original) throw new Error('The original renderer transcript transport was not restored')
          return receipts.map(receipt => ({ ...receipt, messageIds: [...receipt.messageIds] }))
        } finally {
          for (const hold of holds.values()) hold.release()
          delete state.acceptanceDraftDelivery
        }
      },
    }
  }, { appId, conversationIds })
  return {
    read: () => page.evaluate(() => (window as unknown as DraftDeliveryWindow).acceptanceDraftDelivery!.read()),
    release: (conversationId: string) => page.evaluate(id => (window as unknown as DraftDeliveryWindow).acceptanceDraftDelivery!.release(id), conversationId),
    restore: () => page.evaluate(() => (window as unknown as DraftDeliveryWindow).acceptanceDraftDelivery!.restore()),
  }
}

export function assertDraftHistoryFiles(sessions: DraftSession[]) {
  for (const session of sessions) expect(readFileSync(session.file, 'utf8')).toBe(session.bytes)
}
