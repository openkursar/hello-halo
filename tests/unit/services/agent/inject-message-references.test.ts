/**
 * Mid-turn injection carries references the same way a send does: the record
 * keeps them, the engine reads them expanded ahead of the text.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  addMessage: vi.fn(),
  send: vi.fn(),
  liveSend: vi.fn((..._args: unknown[]) => true),
  fallback: vi.fn((): { contextBlock: string; filePaths: string[] } | null => null),
  updateMessage: vi.fn(),
  sessions: new Map<string, unknown>(),
}))

vi.mock('../../../../src/main/services/agent/session-manager', () => ({ v2Sessions: m.sessions }))
vi.mock('../../../../src/main/services/agent/live-turn', () => ({ hasLiveTurn: () => true, sendIntoLiveTurn: (...args: unknown[]) => { m.send(args[1]); return m.liveSend(...args) } }))
vi.mock('../../../../src/main/services/agent/image-attachments', () => ({
  modelAcceptsImages: (capability: { supportsVision?: boolean }) => capability.supportsVision !== false,
  prepareNonVisionImageFallback: m.fallback,
}))
vi.mock('../../../../src/main/services/conversation.service', () => ({ addMessage: m.addMessage, updateMessageById: m.updateMessage }))
vi.mock('../../../../src/main/services/agent/helpers', () => ({ getWorkingDir: () => '/work' }))

import { injectMessage } from '../../../../src/main/services/agent/inject-message'
import type { ContentReference } from '../../../../src/shared/types/content-reference'

const terminal: ContentReference = { id: 't', source: { kind: 'terminal', title: 'zsh' }, quote: 'Error: boom' }

beforeEach(() => {
  vi.clearAllMocks()
  m.sessions.clear()
  m.liveSend.mockReturnValue(true)
  m.fallback.mockReturnValue(null)
  m.sessions.set('conv-1', { spaceId: 'space-1', session: { send: m.send }, imageInput: { model: 'vision', supportsVision: true, ocrAvailable: false } })
})

describe('injectMessage with references', () => {
  it('records them on the injection and expands them for the engine', () => {
    injectMessage('conv-1', 'why?', [terminal])
    expect(m.addMessage).toHaveBeenCalledWith('space-1', 'conv-1', {
      role: 'user', content: 'why?', source: 'injection', metadata: { references: [terminal] },
    })
    const sent: string = m.send.mock.calls[0][0]
    expect(sent.startsWith('<halo_references>')).toBe(true)
    expect(sent.endsWith('</halo_references>\n\nwhy?')).toBe(true)
  })

  it('keeps a plain injection unchanged', () => {
    injectMessage('conv-1', 'go on')
    expect(m.addMessage).toHaveBeenCalledWith('space-1', 'conv-1', { role: 'user', content: 'go on', source: 'injection' })
    expect(m.send).toHaveBeenCalledWith('go on')
  })

  it('delivers image-only input and persists original images', () => {
    const images = [{ id: 'image', type: 'image' as const, mediaType: 'image/png' as const, data: 'aGVsbG8=' }]
    injectMessage('conv-1', '', undefined, images)
    expect(m.liveSend).toHaveBeenCalledWith('conv-1', '', images, expect.any(Object))
    expect(m.addMessage).toHaveBeenCalledWith('space-1', 'conv-1', { role: 'user', content: '', source: 'injection', images })
  })

  it('does not persist refused image input', () => {
    m.liveSend.mockReturnValue(false)
    expect(() => injectMessage('conv-1', 'look', undefined, [{ id: 'i', type: 'image', mediaType: 'image/png', data: 'aA==' }])).toThrow('cannot accept input')
    expect(m.addMessage).not.toHaveBeenCalled()
  })

  it('uses the running non-vision session fallback while retaining original images', () => {
    const images = [{ id: 'i', type: 'image' as const, mediaType: 'image/png' as const, data: 'aA==' }]
    m.sessions.set('conv-1', { spaceId: 'space-1', imageInput: { model: 'text-model', supportsVision: false, ocrAvailable: true } })
    m.fallback.mockReturnValue({ contextBlock: 'OCR paths\n', filePaths: ['/image.png'] })
    injectMessage('conv-1', 'read', undefined, images)
    expect(m.liveSend).toHaveBeenCalledWith('conv-1', 'OCR paths\nread', undefined, expect.any(Object))
    expect(m.addMessage).toHaveBeenCalledWith('space-1', 'conv-1', expect.objectContaining({ content: 'read', images }))
  })

  it('refuses images without OCR instead of silently stripping or restarting', () => {
    m.sessions.set('conv-1', { spaceId: 'space-1', imageInput: { model: 'text-model', supportsVision: false, ocrAvailable: false } })
    expect(() => injectMessage('conv-1', 'read', undefined, [{ id: 'i', type: 'image', mediaType: 'image/png', data: 'aA==' }]))
      .toThrow(expect.objectContaining({ retryable: false }))
    expect(m.liveSend).not.toHaveBeenCalled()
    expect(m.addMessage).not.toHaveBeenCalled()
  })

  it('throws without a live session', () => {
    expect(() => injectMessage('missing', 'x')).toThrow('No active V2 session')
  })
})
