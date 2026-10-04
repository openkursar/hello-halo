/**
 * A person's message to a team member travels the team's bus as text, so the
 * places they pointed at are written into it, after their words.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../src/main/services/agent', async () => ({
  formatReferencesBlock: (await vi.importActual<typeof import('../../../src/main/services/agent/references')>(
    '../../../src/main/services/agent/references',
  )).formatReferencesBlock,
  getWorkingDir: (spaceId: string) => `/spaces/${spaceId}`,
}))

import { toMemberMessage } from '../../../src/main/controllers/team-member-message.controller'

const excerpt = {
  id: 'r1',
  source: { kind: 'file', path: '/spaces/s/src/a.ts', precision: 'lines' },
  range: { startLine: 2, endLine: 3 },
  quote: 'const a = 1',
  note: 'Why?',
}

describe('toMemberMessage', () => {
  it('passes a message without references through as typed', () => {
    expect(toMemberMessage({ message: 'hi' })).toEqual({ ok: true, message: 'hi' })
    expect(toMemberMessage({ message: '' })).toEqual({ ok: true, message: '' })
  })

  it('writes the references after the text, paths relative to the space they were taken in', () => {
    const result = toMemberMessage({ message: 'Look', references: [excerpt], spaceId: 's' })
    expect(result.ok).toBe(true)
    const message = result.ok ? result.message : ''
    expect(message.startsWith('Look\n\n<halo_references>\n')).toBe(true)
    expect(message).toContain('[1] src/a.ts, lines 2-3\nNote: Why?\nExcerpt:\n```ts\nconst a = 1\n```')
    expect(message.endsWith('</halo_references>')).toBe(true)
  })

  it('sends references alone, with full paths when no space is named', () => {
    const result = toMemberMessage({ message: '', references: [excerpt] })
    const message = result.ok ? result.message : ''
    expect(message.startsWith('<halo_references>')).toBe(true)
    expect(message).toContain('[1] /spaces/s/src/a.ts, lines 2-3')
  })

  it('refuses a malformed list rather than sending part of it', () => {
    expect(toMemberMessage({ message: 'hi', references: [excerpt, { id: 1 }] })).toMatchObject({ ok: false })
  })
})
