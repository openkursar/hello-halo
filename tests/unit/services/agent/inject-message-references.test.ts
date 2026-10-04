/**
 * Mid-turn injection carries references the same way a send does: the record
 * keeps them, the engine reads them expanded ahead of the text.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({
  addMessage: vi.fn(),
  send: vi.fn(),
  sessions: new Map<string, unknown>(),
}))

vi.mock('../../../../src/main/services/agent/session-manager', () => ({ v2Sessions: m.sessions }))
vi.mock('../../../../src/main/services/conversation.service', () => ({ addMessage: m.addMessage }))
vi.mock('../../../../src/main/services/agent/helpers', () => ({ getWorkingDir: () => '/work' }))

import { injectMessage } from '../../../../src/main/services/agent/inject-message'
import type { ContentReference } from '../../../../src/shared/types/content-reference'

const terminal: ContentReference = { id: 't', source: { kind: 'terminal', title: 'zsh' }, quote: 'Error: boom' }

beforeEach(() => {
  vi.clearAllMocks()
  m.sessions.clear()
  m.sessions.set('conv-1', { spaceId: 'space-1', session: { send: m.send } })
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

  it('throws without a live session', () => {
    expect(() => injectMessage('missing', 'x')).toThrow('No active V2 session')
  })
})
