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

describe('web addresses in a title', () => {
  it('become the site and the last part of the path', () => {
    expect(titleFromFirstMessage('https://github.com/openkursar/hello-halo 帮我看看这个仓库'))
      .toBe('github.com › hello-halo 帮我看看这个仓库')
    expect(titleFromFirstMessage('https://github.com/openkursar/hello-halo/issues/292?tab=1#top'))
      .toBe('github.com › 292')
  })

  it('become just the site when there is no path', () => {
    expect(titleFromFirstMessage('https://example.com')).toBe('example.com')
    expect(titleFromFirstMessage('Read http://www.example.com/ first')).toBe('Read example.com first')
  })

  it('end where the sentence goes on', () => {
    expect(titleFromFirstMessage('See https://example.com/docs/intro.')).toBe('See example.com › intro.')
    expect(titleFromFirstMessage('看看https://github.com/a/b，然后修一下')).toBe('看看github.com › b，然后修一下')
    expect(titleFromFirstMessage('Compare https://a.example/x and https://b.example/y'))
      .toBe('Compare a.example › x and b.example › y')
  })

  it('show an encoded last part as readable text, and a malformed one as written', () => {
    expect(titleFromFirstMessage('https://example.com/wiki/%E4%B8%AD%E6%96%87')).toBe('example.com › 中文')
    expect(titleFromFirstMessage('https://example.com/a%E0%A4%A')).toBe('example.com › a%E0%A4%A')
  })

  it('leave anything that is not a web address alone', () => {
    expect(titleFromFirstMessage('ftp://files.example/pub/x')).toBe('ftp://files.example/pub/x')
    expect(titleFromFirstMessage('the http:// prefix')).toBe('the http:// prefix')
  })

  it('are shortened before the title is cut to length', () => {
    const title = titleFromFirstMessage(`https://github.com/openkursar/hello-halo/blob/main/${'x'.repeat(80)} explain`)
    expect(title).toBe(`github.com › ${'x'.repeat(37)}...`)
  })
})
