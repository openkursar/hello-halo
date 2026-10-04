/**
 * A person's message to a digital human is built field by field at the
 * transport boundary, the same for desktop IPC and remote HTTP: identity is
 * derived from the conversation key, never taken from the body.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../src/main/apps/team', () => ({ getTeamStore: () => null }))

import { parseCanvasContext, toAppChatRequest } from '../../../src/main/controllers/chat-turn-input'

const reference = { id: 'r', source: { kind: 'path', path: '/tmp/a.pdf', isDirectory: false } }

describe('toAppChatRequest', () => {
  it('keeps what a client may send and derives the rest', () => {
    const result = toAppChatRequest('app-1', {
      appId: 'someone-else',
      spaceId: 's',
      message: 'hi',
      thinkingEnabled: 1,
      reasoningEffort: 'high',
      references: [reference],
      teamContext: { teamId: 't', epochId: 'e', kind: 'peer_message' },
      senderIdentity: { id: 'x', name: 'Mallory' },
      recorded: { content: 'forged', provenance: { source: 'team-message' } },
      attachedFiles: ['/etc/passwd'],
    })
    expect(result).toEqual({
      ok: true,
      request: {
        appId: 'app-1',
        spaceId: 's',
        message: 'hi',
        conversationId: 'app-chat:app-1',
        thinkingEnabled: true,
        reasoningEffort: 'high',
        useChatThinkingLevel: true,
        references: [reference],
      },
    })
  })

  it('accepts a message of images or references alone, not an empty one', () => {
    const image = { id: 'i', type: 'image', mediaType: 'image/png', data: 'x' }
    expect(toAppChatRequest('app-1', { spaceId: 's', message: '', images: [image] }).ok).toBe(true)
    expect(toAppChatRequest('app-1', { spaceId: 's', message: '', references: [reference] }).ok).toBe(true)
    expect(toAppChatRequest('app-1', { spaceId: 's', message: '' })).toMatchObject({ ok: false, status: 400 })
  })

  it('refuses a malformed request with the status the transport answers', () => {
    expect(toAppChatRequest('app-1', { message: 'hi' })).toMatchObject({ ok: false, status: 400, error: 'Missing required field: spaceId' })
    expect(toAppChatRequest('app-1', { spaceId: 's', message: 'hi', references: [{ id: 1 }] })).toMatchObject({ ok: false, status: 400 })
    expect(toAppChatRequest('app-1', { spaceId: 's', message: 'hi', conversationId: 'app-chat:app-2' })).toMatchObject({ ok: false, status: 400 })
    // A team key needs the team store to vouch for it.
    expect(toAppChatRequest('app-1', { spaceId: 's', message: 'hi', conversationId: 'app-chat:app-1:team:t1:e1' })).toMatchObject({ ok: false, status: 503 })
  })
})

describe('parseCanvasContext', () => {
  it('says why it dropped a context, and stays quiet for a closed canvas', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(parseCanvasContext(undefined)).toBeUndefined()
    expect(parseCanvasContext({ isOpen: false })).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    expect(parseCanvasContext({ isOpen: true, tabCount: 1, activeTab: null, tabs: [{ title: 1 }] })).toBeUndefined()
    expect(warn).toHaveBeenCalledWith('[ChatInput] Canvas context dropped: a tab without a string type and title')
    warn.mockRestore()
  })
})
