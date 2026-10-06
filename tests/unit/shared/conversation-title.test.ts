import { describe, it, expect } from 'vitest'
import { previewFromMessages, titleFromFirstMessage } from '../../../src/shared/conversation-title'

describe('titleFromFirstMessage', () => {
  it('keeps a short message as-is', () => {
    expect(titleFromFirstMessage('Deploy staging')).toBe('Deploy staging')
  })

  it('collapses line breaks and surrounding whitespace', () => {
    expect(titleFromFirstMessage('\n  Fix the build\n\nthen ship  ')).toBe('Fix the build then ship')
  })

  it('truncates past 50 characters with an ellipsis', () => {
    expect(titleFromFirstMessage('a'.repeat(51))).toBe('a'.repeat(50) + '...')
    expect(titleFromFirstMessage('a'.repeat(50))).toBe('a'.repeat(50))
  })

  it('never splits an astral character at the cut', () => {
    const title = titleFromFirstMessage('a'.repeat(49) + '😀😀')
    expect(title).toBe('a'.repeat(49) + '😀...')
  })

  it('returns null for a message with no text', () => {
    expect(titleFromFirstMessage('')).toBeNull()
    expect(titleFromFirstMessage(' \n\t')).toBeNull()
  })
})

describe('previewFromMessages', () => {
  it('shows the latest message that has text, skipping replies that carry none', () => {
    expect(previewFromMessages([{ content: 'Deploy staging' }, { content: '' }])).toBe('Deploy staging')
    expect(previewFromMessages([{ content: 'first' }, { content: 'Done.' }])).toBe('Done.')
  })

  it('is undefined without messages and empty when none has text', () => {
    expect(previewFromMessages([])).toBeUndefined()
    expect(previewFromMessages([{ content: '' }, { content: ' ' }])).toBe('')
  })
})
