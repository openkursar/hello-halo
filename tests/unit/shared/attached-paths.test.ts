/**
 * Messages written before attachments became path references carry them as a
 * block at the end of their text; those still read back as paths. The block
 * is written here the way the composer used to write it.
 */

import { describe, it, expect } from 'vitest'
import { attachedPathName, canAttachPath, splitAttachedPaths, type AttachedPath } from '../../../src/shared/attached-paths'
import { titleFromFirstMessage } from '../../../src/shared/conversation-title'

/** The block as the composer used to append it: one path per line, JSON for a path that cannot be a line, folders with a trailing separator. */
function appendAttachedPaths(text: string, paths: AttachedPath[]): string {
  if (paths.length === 0) return text
  const lines = paths.map(({ path, isDirectory }) => {
    const written = isDirectory && !/[\\/]$/.test(path) ? path + (path.includes('\\') && !path.includes('/') ? '\\' : '/') : path
    return /[\r\n]/.test(written) || written.startsWith('"') ? JSON.stringify(written) : written
  })
  const block = `<attached_paths>\n${lines.join('\n')}\n</attached_paths>`
  return text ? `${text}\n\n${block}` : block
}

describe('attached paths', () => {
  it('round-trips text with files and folders', () => {
    const content = appendAttachedPaths('Summarize these', [
      { path: '/Users/me/Reports/q3 final.pdf', isDirectory: false },
      { path: '/Users/me/Projects/site', isDirectory: true },
    ])
    expect(content).toBe('Summarize these\n\n<attached_paths>\n/Users/me/Reports/q3 final.pdf\n/Users/me/Projects/site/\n</attached_paths>')
    expect(splitAttachedPaths(content)).toEqual({
      text: 'Summarize these',
      paths: [
        { path: '/Users/me/Reports/q3 final.pdf', isDirectory: false },
        { path: '/Users/me/Projects/site/', isDirectory: true },
      ],
    })
  })

  it('keeps Windows separators for folders', () => {
    const content = appendAttachedPaths('', [{ path: 'C:\\Users\\me\\Docs', isDirectory: true }])
    expect(content).toBe('<attached_paths>\nC:\\Users\\me\\Docs\\\n</attached_paths>')
    expect(splitAttachedPaths(content).paths).toEqual([{ path: 'C:\\Users\\me\\Docs\\', isDirectory: true }])
  })

  it('leaves text without a trailing block untouched', () => {
    const content = 'Explain <attached_paths>\n/x\n</attached_paths> then continue'
    expect(splitAttachedPaths(content)).toEqual({ text: content, paths: [] })
    expect(appendAttachedPaths('hi', [])).toBe('hi')
  })

  it('carries spaces, markup characters, quotes and CJK in paths unchanged', () => {
    const paths = [
      { path: '/Users/me/My Docs/a <b> & "c".pdf', isDirectory: false },
      { path: "/Users/me/报告 '2026'/", isDirectory: true },
      { path: '/Users/me/trailing space ', isDirectory: false },
    ]
    const content = appendAttachedPaths('看看这些', paths)
    expect(splitAttachedPaths(content)).toEqual({ text: '看看这些', paths })
  })

  it('carries a line break in a file name as one entry, reversibly', () => {
    const paths = [
      { path: '/tmp/evil\n/etc/passwd', isDirectory: false },
      { path: '/tmp/cr\rname', isDirectory: false },
      { path: '/tmp/"quoted-start', isDirectory: false },
      { path: '/tmp/ok.txt', isDirectory: false },
    ]
    const content = appendAttachedPaths('x', paths)
    expect(content).toContain('"/tmp/evil\\n/etc/passwd"')
    expect(splitAttachedPaths(content)).toEqual({ text: 'x', paths })
  })

  it('accepts only absolute local paths', () => {
    expect(canAttachPath('/tmp/a')).toBe(true)
    expect(canAttachPath('C:\\a')).toBe(true)
    expect(canAttachPath('d:/a')).toBe(true)
    expect(canAttachPath('\\\\server\\share\\a')).toBe(true)
    expect(canAttachPath('')).toBe(false)
    expect(canAttachPath('relative/a')).toBe(false)
    expect(canAttachPath('</attached_paths>')).toBe(false)
  })

  it('keeps typed text that mentions the tags whole, with the real block after it', () => {
    const typed = 'The format is <attached_paths>\nlike this\n</attached_paths> — see?'
    const content = appendAttachedPaths(typed, [{ path: '/tmp/a.md', isDirectory: false }])
    expect(splitAttachedPaths(content)).toEqual({ text: typed, paths: [{ path: '/tmp/a.md', isDirectory: false }] })
  })

  it('does not invent attachments from typed text that ends like a block', () => {
    for (const typed of [
      'see:\n<attached_paths>\nnot a path\n</attached_paths>',
      'see:\n<attached_paths>\n/ok\nrelative\n</attached_paths>',
      '<attached_paths>\n"broken json\n</attached_paths>',
      '<attached_paths>\n"relative"\n</attached_paths>',
    ]) {
      expect(splitAttachedPaths(typed)).toEqual({ text: typed, paths: [] })
    }
  })

  it('keeps file names that contain the tags as paths, not as block boundaries', () => {
    const paths = [
      { path: '/tmp/<attached_paths>', isDirectory: false },
      { path: '/tmp/</attached_paths>', isDirectory: false },
      { path: '/tmp/<attached_paths>/', isDirectory: true },
    ]
    const content = appendAttachedPaths('body\n<attached_paths>', paths)
    expect(splitAttachedPaths(content)).toEqual({ text: 'body\n<attached_paths>', paths })
  })

  it('tolerates trailing whitespace after the block and ignores an empty block', () => {
    expect(splitAttachedPaths('hi\n\n<attached_paths>\n/a\n</attached_paths>\n  ').paths).toEqual([{ path: '/a', isDirectory: false }])
    const empty = 'hi\n<attached_paths>\n</attached_paths>'
    expect(splitAttachedPaths(empty)).toEqual({ text: empty, paths: [] })
  })

  it('names a path by its last segment', () => {
    expect(attachedPathName('/Users/me/Projects/site/')).toBe('site')
    expect(attachedPathName('C:\\Users\\me\\a.txt')).toBe('a.txt')
    expect(attachedPathName('/')).toBe('/')
  })

  it('titles a conversation by its text, or by attachment names when there is none', () => {
    const withText = appendAttachedPaths('Review this', [{ path: '/tmp/a.pdf', isDirectory: false }])
    expect(titleFromFirstMessage(withText)).toBe('Review this')
    const onlyPaths = appendAttachedPaths('', [
      { path: '/tmp/a.pdf', isDirectory: false },
      { path: '/tmp/src', isDirectory: true },
    ])
    expect(titleFromFirstMessage(onlyPaths)).toBe('a.pdf, src')
  })
})
