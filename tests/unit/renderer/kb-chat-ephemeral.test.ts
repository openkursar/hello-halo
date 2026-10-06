/**
 * The knowledge base chat is temporary: it runs on an ephemeral conversation
 * (kept out of every conversation list), and ends — its conversation deleted —
 * when the user leaves the knowledge base for another one, the list or another
 * page, or clears it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  effects: [] as Array<{ run: () => void | (() => void); deps?: unknown[] }>,
}))

const api = vi.hoisted(() => ({
  createConversation: vi.fn(),
  sendMessage: vi.fn(),
  deleteConversation: vi.fn(),
  retainConversationDetail: vi.fn(() => () => {}),
  tlon: {},
}))
const forgetConversation = vi.hoisted(() => vi.fn())

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => [initial, () => {}],
  useEffect: (run: () => void | (() => void), deps?: unknown[]) => { env.effects.push({ run, deps }) },
}))
vi.mock('../../../src/renderer/api', () => ({ api }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({
  useChatStore: { getState: () => ({ forgetConversation }) },
}))
vi.mock('../../../src/renderer/i18n', () => ({
  default: { t: (text: string, values?: Record<string, unknown>) => text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(values?.[k] ?? '')) },
  useTranslation: () => ({ t: (text: string) => text }),
}))
vi.mock('../../../src/renderer/components/tlon/ChatTab', () => ({ ChatTab: () => null }))
vi.mock('../../../src/renderer/components/tlon/RawFilesTab', () => ({ RawFilesTab: () => null }))
vi.mock('../../../src/renderer/components/tlon/SettingsTab', () => ({ SettingsTab: () => null }))

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useTlonStore } from '../../../src/renderer/stores/tlon.store'
import { KBDetail } from '../../../src/renderer/components/tlon/KBDetail'
import type { KnowledgeBaseEntry } from '../../../src/shared/types/tlon'

const kb = (id: string): KnowledgeBaseEntry => ({
  id,
  name: 'Docs',
  icon: '',
  description: '',
  status: 'active',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  path: '/kb',
  linkedDirs: [],
  spaceIds: [],
  appIds: [],
  stats: { rawFileCount: 3, indexedCount: 3, rawSizeBytes: 0 },
})

beforeEach(() => {
  vi.clearAllMocks()
  env.effects = []
  useTlonStore.setState({ kbs: [kb('kb1')], chatSessions: {} })
  api.createConversation.mockResolvedValue({ success: true, data: { id: 'conv-1' } })
  api.sendMessage.mockResolvedValue({ success: true })
  api.deleteConversation.mockResolvedValue({ success: true })
})

describe('the knowledge base chat', () => {
  it('runs on an ephemeral conversation', async () => {
    await useTlonStore.getState().sendChatMessage('kb1', 'What is the refund policy?')

    expect(api.createConversation).toHaveBeenCalledWith('halo-temp', 'Ask: Docs', undefined, { ephemeral: true })
    expect(api.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'conv-1', knowledgeBaseId: 'kb1' }))
  })

  it('ending it deletes its conversation and every trace of it in the chat view', async () => {
    await useTlonStore.getState().sendChatMessage('kb1', 'What is the refund policy?')

    await useTlonStore.getState().clearChat('kb1')

    expect(api.deleteConversation).toHaveBeenCalledWith('halo-temp', 'conv-1')
    expect(forgetConversation).toHaveBeenCalledWith('conv-1')
    expect(useTlonStore.getState().chatSessions.kb1?.messages ?? []).toEqual([])
  })

  it('ending a chat that never started changes nothing', async () => {
    const before = useTlonStore.getState().chatSessions

    await useTlonStore.getState().clearChat('kb1')

    expect(api.deleteConversation).not.toHaveBeenCalled()
    expect(useTlonStore.getState().chatSessions).toBe(before)
  })

  it('ends when the user leaves the knowledge base', async () => {
    await useTlonStore.getState().sendChatMessage('kb1', 'What is the refund policy?')

    renderToStaticMarkup(createElement(KBDetail, { kb: kb('kb1'), onDeleted: () => {} }))
    const leave = env.effects.find(effect => effect.deps?.includes('kb1'))
    expect(leave).toBeDefined()
    const cleanup = leave!.run()
    expect(api.deleteConversation).not.toHaveBeenCalled()

    // Another knowledge base, the list or another page: React runs the cleanup.
    ;(cleanup as () => void)()
    await vi.waitFor(() => expect(api.deleteConversation).toHaveBeenCalledWith('halo-temp', 'conv-1'))
  })
})
