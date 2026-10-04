import { describe, it, expect } from 'vitest'
import {
  displayPath,
  formatLineRange,
  isQuoteAtLimit,
  messageReferences,
  messageSummaryText,
  normalizeReference,
  parseReferences,
  pathRelativeTo,
  quoteCharLimit,
  referenceLocation,
  referenceLocationText,
  truncateChars,
} from '../../../src/shared/content-reference'
import { previewFromMessage, titleFromFirstMessage } from '../../../src/shared/conversation-title'
import { REFERENCE_LIMITS, type ContentReference } from '../../../src/shared/types/content-reference'

const fileRef = (over: Partial<ContentReference> = {}): ContentReference => ({
  id: 'r1',
  source: { kind: 'file', path: '/work/src/a.ts', precision: 'lines' },
  range: { startLine: 3, endLine: 5 },
  quote: 'const a = 1',
  ...over,
})

describe('truncateChars', () => {
  it('keeps short text and cuts long text from the chosen end', () => {
    expect(truncateChars('abc', 5)).toBe('abc')
    expect(truncateChars('abcdef', 3)).toBe('abc')
    expect(truncateChars('abcdef', 3, 'end')).toBe('def')
    expect(truncateChars('abc', 0)).toBe('')
  })

  it('never splits a surrogate pair', () => {
    expect(truncateChars('ab😀', 3)).toBe('ab')
    expect(truncateChars('😀ab', 3, 'end')).toBe('ab')
  })
})

describe('normalizeReference', () => {
  it('bounds quotes by how readable their source is', () => {
    const long = 'x'.repeat(REFERENCE_LIMITS.standaloneQuoteChars + 10)
    expect(normalizeReference(fileRef({ quote: long })).quote).toHaveLength(REFERENCE_LIMITS.readableQuoteChars)
    const message = normalizeReference({
      id: 'm', source: { kind: 'message', conversationId: 'c', messageId: 'x' }, quote: long,
    })
    expect(message.quote).toHaveLength(REFERENCE_LIMITS.standaloneQuoteChars)
  })

  it('keeps the newest terminal output when cutting', () => {
    const output = 'old\n' + 'y'.repeat(REFERENCE_LIMITS.standaloneQuoteChars) + 'END'
    const ref = normalizeReference({ id: 't', source: { kind: 'terminal', title: 'zsh' }, quote: output })
    expect(ref.quote?.endsWith('END')).toBe(true)
    expect(ref.quote?.startsWith('old')).toBe(false)
  })

  it('drops what a source cannot carry and empty fields, trims and bounds notes', () => {
    const path = normalizeReference({
      id: 'p', source: { kind: 'path', path: '/tmp/a', isDirectory: false },
      quote: 'nope', range: { startLine: 1, endLine: 2 }, note: '   ',
    })
    expect(path).toEqual({ id: 'p', source: { kind: 'path', path: '/tmp/a', isDirectory: false } })
    const note = normalizeReference(fileRef({ note: `  ${'n'.repeat(REFERENCE_LIMITS.noteChars + 5)}  ` }))
    expect(note.note).toHaveLength(REFERENCE_LIMITS.noteChars)
  })

  it('orders a reversed range and is idempotent', () => {
    const ref = normalizeReference(fileRef({ range: { startLine: 9, endLine: 4 } }))
    expect(ref.range).toEqual({ startLine: 4, endLine: 9 })
    expect(normalizeReference(ref)).toEqual(ref)
  })
})

describe('parseReferences', () => {
  it('accepts every source kind and treats absence as none', () => {
    expect(parseReferences(undefined)).toEqual({ ok: true, references: [] })
    const input = [
      fileRef(),
      { id: 'd', source: { kind: 'diff', path: '/repo/x.ts', side: 'before', compareLabel: 'Uncommitted changes', repo: { root: '/repo', beforeRevision: '4b825dc' } }, range: { startLine: 1, endLine: 1 } },
      { id: 't', source: { kind: 'terminal', title: 'zsh', sessionId: 's1' }, quote: 'error' },
      { id: 'm', source: { kind: 'message', conversationId: 'c', messageId: 'x', whole: true }, quote: 'report' },
      { id: 'p', source: { kind: 'path', path: 'C:\\Users\\me', isDirectory: true } },
    ]
    const result = parseReferences(input)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.references.map(r => r.source.kind)).toEqual(['file', 'diff', 'terminal', 'message', 'path'])
  })

  it('refuses the whole list on any malformed entry so numbering never shifts', () => {
    const result = parseReferences([fileRef(), { id: 'bad', source: { kind: 'file', path: 'relative.ts', precision: 'lines' } }])
    expect(result).toEqual({ ok: false, error: 'references[1] file source needs an absolute path' })
    expect(parseReferences('x').ok).toBe(false)
    expect(parseReferences([fileRef(), fileRef()]).ok).toBe(false)
    expect(parseReferences([{ ...fileRef(), range: { startLine: 'a', endLine: 2 } }]).ok).toBe(false)
    expect(parseReferences([{ id: 'd', source: { kind: 'diff', path: '/r/a', side: 'before', compareLabel: 'x', repo: { root: '/r', beforeRevision: 'HEAD; rm' } } }]).ok).toBe(false)
  })

  it('refuses more references than a message may carry', () => {
    const many = Array.from({ length: REFERENCE_LIMITS.maxPerMessage + 1 }, (_, i) => fileRef({ id: `r${i}` }))
    expect(parseReferences(many).ok).toBe(false)
  })

  it('bounds over-long texts instead of refusing them', () => {
    const result = parseReferences([fileRef({ quote: 'q'.repeat(10_000) })])
    expect(result.ok && result.references[0].quote?.length).toBe(REFERENCE_LIMITS.readableQuoteChars)
  })
})

describe('locations', () => {
  it('relates paths to a base directory on POSIX and Windows', () => {
    expect(pathRelativeTo('/work/src/a.ts', '/work')).toBe('src/a.ts')
    expect(pathRelativeTo('/work/src/a.ts', '/work/')).toBe('src/a.ts')
    expect(pathRelativeTo('/work', '/work')).toBe('.')
    expect(pathRelativeTo('/workshop/a.ts', '/work')).toBeNull()
    expect(pathRelativeTo('C:\\Work\\src\\a.ts', 'c:\\work')).toBe('src/a.ts')
    expect(pathRelativeTo('/a', undefined)).toBeNull()
    expect(displayPath('/elsewhere/a.ts', '/work')).toBe('/elsewhere/a.ts')
  })

  it('formats line ranges', () => {
    expect(formatLineRange(undefined)).toBe('')
    expect(formatLineRange({ startLine: 7, endLine: 7 })).toBe('7')
    expect(formatLineRange({ startLine: 7, endLine: 9 })).toBe('7-9')
  })

  it('names each kind of source without wording', () => {
    expect(referenceLocation(fileRef(), '/work')).toEqual({ name: 'a.ts', lines: '3-5', path: 'src/a.ts' })
    expect(referenceLocationText(fileRef())).toBe('a.ts:3-5')
    expect(referenceLocationText({ id: 't', source: { kind: 'terminal', title: 'zsh' } })).toBe('zsh')
    expect(referenceLocationText({ id: 'm', source: { kind: 'message', conversationId: 'c', messageId: 'x' } })).toBe('')
    expect(referenceLocationText({ id: 'p', source: { kind: 'path', path: '/a/site/', isDirectory: true } })).toBe('site')
  })

  it('knows when a quote may have been cut', () => {
    expect(quoteCharLimit('path')).toBe(0)
    expect(isQuoteAtLimit('file', 'x'.repeat(REFERENCE_LIMITS.readableQuoteChars))).toBe(true)
    expect(isQuoteAtLimit('file', 'short')).toBe(false)
  })
})

describe('message references, titles and previews', () => {
  it('reads a legacy attached-paths block as path references for display', () => {
    const content = 'Look\n\n<attached_paths>\n/tmp/a.pdf\n</attached_paths>'
    expect(messageReferences(content)).toEqual({
      text: 'Look',
      references: [{ id: 'attached-path-1', source: { kind: 'path', path: '/tmp/a.pdf', isDirectory: false } }],
    })
    expect(messageReferences('plain', [fileRef()]).references).toHaveLength(1)
  })

  it('titles a card-only message by its first card note, else its location', () => {
    expect(titleFromFirstMessage('', [fileRef({ note: 'Why does this throw?' }), fileRef({ id: 'r2' })])).toBe('Why does this throw?')
    expect(titleFromFirstMessage('', [fileRef()])).toBe('a.ts:3-5')
    expect(titleFromFirstMessage('Fix these', [fileRef()])).toBe('Fix these')
    expect(titleFromFirstMessage('', [{ id: 'm', source: { kind: 'message', conversationId: 'c', messageId: 'x' } }])).toBeNull()
  })

  it('passes over a first card that names nothing', () => {
    const untitled: ContentReference = { id: 'm', source: { kind: 'message', conversationId: 'c', messageId: 'x' } }
    expect(messageSummaryText('', [untitled, fileRef({ id: 'r2' })])).toBe('a.ts:3-5')
    expect(messageSummaryText('', [untitled])).toBe('')
  })

  it('names a message of attachments alone by all of them, as before', () => {
    const refs: ContentReference[] = [
      { id: 'a', source: { kind: 'path', path: '/tmp/a.pdf', isDirectory: false } },
      { id: 'b', source: { kind: 'path', path: '/tmp/src/', isDirectory: true } },
    ]
    expect(messageSummaryText('', refs)).toBe('a.pdf, src')
  })

  it('previews like it titles, cut at 50 characters', () => {
    expect(previewFromMessage('', [fileRef({ note: 'n'.repeat(60) })])).toBe('n'.repeat(50) + '...')
    expect(previewFromMessage('hello')).toBe('hello')
    expect(previewFromMessage('')).toBeUndefined()
  })
})
