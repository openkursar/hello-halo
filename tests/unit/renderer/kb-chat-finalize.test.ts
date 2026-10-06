/**
 * The knowledge base chat's answer is read from its conversation once the turn
 * ends: only a reply after this turn's question counts. A turn that produced
 * nothing leaves no reply of its own (its empty reply is removed), so the
 * previous question's answer must not be shown again as this one's.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  getConversation: vi.fn(),
  tlon: { resolveSources: vi.fn() },
}))

vi.mock('../../../src/renderer/api', () => ({ api }))
vi.mock('../../../src/renderer/stores/chat.store', () => ({
  useChatStore: { getState: () => ({ forgetConversation: vi.fn() }) },
}))
vi.mock('../../../src/renderer/i18n', () => ({ default: { t: (text: string) => text } }))

import { useTlonStore } from '../../../src/renderer/stores/tlon.store'

const msg = (id: string, role: 'user' | 'assistant', content: string) =>
  ({ id, role, content, timestamp: '2026-10-07T00:00:00.000Z' })

function askingSecondQuestion() {
  useTlonStore.setState({
    chatSessions: {
      kb1: {
        conversationId: 'conv-1',
        messages: [
          { id: 'u1', role: 'user', content: 'What is the refund policy?' },
          { id: 'a1', role: 'assistant', content: 'Refunds within 30 days.' },
          { id: 'u2', role: 'user', content: 'And for gift cards?' },
        ],
        generating: true,
        readPaths: [],
      },
    },
  })
}

const shown = () => useTlonStore.getState().chatSessions.kb1.messages.at(-1)

beforeEach(() => {
  vi.clearAllMocks()
  api.tlon.resolveSources.mockResolvedValue({ success: true, data: [] })
})

describe('finalizeChatTurn', () => {
  it('shows the reply that follows this turn\'s question', async () => {
    askingSecondQuestion()
    api.getConversation.mockResolvedValue({ success: true, data: { messages: [
      msg('m1', 'user', 'What is the refund policy?'),
      msg('m2', 'assistant', 'Refunds within 30 days.'),
      msg('m3', 'user', 'And for gift cards?'),
      msg('m4', 'assistant', 'Gift cards cannot be refunded.'),
    ] } })

    await useTlonStore.getState().finalizeChatTurn('kb1')

    expect(shown()).toMatchObject({ role: 'assistant', content: 'Gift cards cannot be refunded.' })
    expect(useTlonStore.getState().chatSessions.kb1.generating).toBe(false)
  })

  it('does not show the previous answer again when this turn left no reply', async () => {
    askingSecondQuestion()
    api.getConversation.mockResolvedValue({ success: true, data: { messages: [
      msg('m1', 'user', 'What is the refund policy?'),
      msg('m2', 'assistant', 'Refunds within 30 days.'),
      msg('m3', 'user', 'And for gift cards?'),
    ] } })

    await useTlonStore.getState().finalizeChatTurn('kb1')

    expect(shown()).toMatchObject({ role: 'assistant', content: 'No answer was produced.', error: true })
  })
})
