/**
 * How a reference reads in the chips' lists and on comment cards (never with
 * a number), and which pending references a surface draws as highlights. Old
 * messages' `<attached_paths>` blocks show as the same file references new
 * messages carry.
 */

import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { commentHeader, quoteFirstLine, referenceLabel, referenceTooltip } from '../../../../src/renderer/components/references/reference-display'
import { sameReferenceSource } from '../../../../src/renderer/components/references/reference-match'
import { messageReferences } from '../../../../src/shared/content-reference'
import { REFERENCE_LIMITS, type ContentReference } from '../../../../src/shared/types/content-reference'

// Interpolates like i18next with the English source as the key.
const t = ((key: string, options?: Record<string, unknown>) =>
  key.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''))) as unknown as TFunction

const file: ContentReference = {
  id: '1', source: { kind: 'file', path: '/repo/src/agent/system-prompt.ts', precision: 'lines' }, range: { startLine: 8, endLine: 9 }, quote: 'x',
}

describe('referenceLabel', () => {
  it('names each kind of place the way the cards show it', () => {
    expect(referenceLabel(file, t)).toBe('system-prompt.ts:8-9')
    expect(referenceLabel({ source: { kind: 'file', path: '/repo/DESIGN.md', precision: 'passage' }, range: { startLine: 7, endLine: 7 } }, t)).toBe('DESIGN.md:7')
    expect(referenceLabel({ source: { kind: 'diff', path: '/repo/a.ts', side: 'after', compareLabel: 'Uncommitted changes' }, range: { startLine: 3, endLine: 4 } }, t)).toBe('a.ts:3-4 · After')
    expect(referenceLabel({ source: { kind: 'diff', path: '/repo/a.ts', side: 'before', compareLabel: 'Changes in the reply at 14:20' } }, t)).toBe('a.ts · Before')
    expect(referenceLabel({ source: { kind: 'terminal', title: 'zsh' }, quote: 'out' }, t)).toBe('Terminal · zsh')
    expect(referenceLabel({ source: { kind: 'message', conversationId: 'c', messageId: 'm', conversationTitle: 'Review · 35 files' } }, t)).toBe('Reply · Review · 35 files')
    expect(referenceLabel({ source: { kind: 'message', conversationId: 'c', messageId: 'm', conversationTitle: 'Review', whole: true } }, t)).toBe('Full reply · Review')
    expect(referenceLabel({ source: { kind: 'message', conversationId: 'c', messageId: 'm' } }, t)).toBe('AI reply')
    expect(referenceLabel({ source: { kind: 'path', path: '/Users/me/site/', isDirectory: true } }, t)).toBe('site/')
  })

  it('says in the tooltip when an excerpt was cut to its limit', () => {
    const cut = { ...file, quote: 'q'.repeat(REFERENCE_LIMITS.readableQuoteChars) }
    expect(referenceTooltip(cut, t, '/repo')).toContain(`Excerpt shortened to ${REFERENCE_LIMITS.readableQuoteChars} characters`)
    expect(referenceTooltip(file, t, '/repo').split('\n')[0]).toBe('src/agent/system-prompt.ts:8-9')
  })
})

describe('legacy attached paths', () => {
  it('an old message keeps its text and shows its paths as path cards after its own references', () => {
    const content = 'Look at these\n\n<attached_paths>\n/tmp/q3.pdf\n/Users/me/site/\n</attached_paths>'
    const { text, references } = messageReferences(content, [file])
    expect(text).toBe('Look at these')
    expect(references.map(ref => referenceLabel(ref, t))).toEqual(['system-prompt.ts:8-9', 'q3.pdf', 'site/'])
  })

  it('text that merely mentions the tag stays text', () => {
    const content = 'The block is <attached_paths> … </attached_paths>'
    expect(messageReferences(content)).toEqual({ text: content, references: [] })
  })
})

describe('sameReferenceSource', () => {
  it('matches a diff side only under the same compare scope', () => {
    const shown = { kind: 'diff' as const, path: '/repo/a.ts', side: 'after' as const, compareLabel: 'Uncommitted changes' }
    expect(sameReferenceSource({ ...shown }, shown)).toBe(true)
    expect(sameReferenceSource({ ...shown, compareLabel: 'Staged changes' }, shown)).toBe(false)
    expect(sameReferenceSource({ ...shown, side: 'before' }, shown)).toBe(false)
    expect(sameReferenceSource({ kind: 'file', path: '/repo/a.ts', precision: 'lines' }, shown)).toBe(false)
  })

  it('marks no passage for a whole-reply card', () => {
    const shown = { kind: 'message' as const, conversationId: 'c', messageId: 'm' }
    expect(sameReferenceSource({ ...shown }, shown)).toBe(true)
    expect(sameReferenceSource({ ...shown, whole: true }, shown)).toBe(false)
  })
})

describe('commentHeader', () => {
  it('names the lines a comment is on, and the side of a diff, without numbering comments', () => {
    expect(commentHeader(file, t)).toBe('Comment · lines 8–9')
    expect(commentHeader({ ...file, range: { startLine: 4, endLine: 4 } }, t)).toBe('Comment · line 4')
    expect(commentHeader({ source: { kind: 'diff', path: '/repo/a.ts', side: 'after', compareLabel: 'Uncommitted changes' }, range: { startLine: 11, endLine: 12 } }, t))
      .toBe('Comment · lines 11–12 · After')
    expect(commentHeader({ source: { kind: 'diff', path: '/repo/a.ts', side: 'before', compareLabel: 'Changes in the reply at 14:20' } }, t)).toBe('Comment · Before')
  })
})

describe('quoteFirstLine', () => {
  it('lists a selection by the first line of its text that says something', () => {
    expect(quoteFirstLine({ ...file, quote: '\n   \n  const a = 1\n  const b = 2' })).toBe('const a = 1')
    expect(quoteFirstLine({ source: { kind: 'terminal', title: 'zsh' } })).toBe('')
  })
})
