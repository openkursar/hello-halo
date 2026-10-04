/**
 * Which inline code in a reply is a file mention worth checking, and the mark
 * the renderer looks for. Fenced code is never a mention.
 */

import { describe, expect, it } from 'vitest'
import { detectFileMention, FILE_MENTION_PROPERTY, rehypeFileMentions } from '../../../../src/renderer/components/references/file-mentions'

describe('detectFileMention', () => {
  it('reads a path alone, with a line, or with a line range', () => {
    expect(detectFileMention('src/main/foo.ts')).toEqual({ path: 'src/main/foo.ts' })
    expect(detectFileMention('src/main/foo.ts:45')).toEqual({ path: 'src/main/foo.ts', range: { startLine: 45, endLine: 45 } })
    expect(detectFileMention('src/main/foo.ts:12-18')).toEqual({ path: 'src/main/foo.ts', range: { startLine: 12, endLine: 18 } })
  })

  it('treats a compiler-style column as the line it is on', () => {
    expect(detectFileMention('src/a.ts:12:5')).toEqual({ path: 'src/a.ts', range: { startLine: 12, endLine: 12 } })
  })

  it('accepts absolute paths, Windows paths, dotfiles, multi-dot and extensionless well-known names', () => {
    expect(detectFileMention('/Users/me/repo/README.md:3')?.path).toBe('/Users/me/repo/README.md')
    expect(detectFileMention('C:\\repo\\src\\a.ts:7')).toEqual({ path: 'C:\\repo\\src\\a.ts', range: { startLine: 7, endLine: 7 } })
    expect(detectFileMention('.env.local')?.path).toBe('.env.local')
    expect(detectFileMention('src/foo.test.ts')?.path).toBe('src/foo.test.ts')
    expect(detectFileMention('docker/Dockerfile')?.path).toBe('docker/Dockerfile')
    expect(detectFileMention('package.json')?.path).toBe('package.json')
  })

  it('rejects code that is not a path', () => {
    for (const text of ['useState', 'npm run build', 'foo.bar()', 'a => b', 'https://example.com/a.ts', 'src/', '{ key: 1 }', 'x:y', '']) {
      expect(detectFileMention(text), text).toBeNull()
    }
  })

  it('never offers a network share or device path for checking', () => {
    for (const text of ['\\\\host\\share\\a.ts', '//host/share/a.ts:3', '\\\\?\\C:\\a.ts', '\\\\.\\pipe\\x.ts']) {
      expect(detectFileMention(text), text).toBeNull()
    }
  })

  it('rejects an inverted or zero line range', () => {
    expect(detectFileMention('src/a.ts:9-3')).toBeNull()
    expect(detectFileMention('src/a.ts:0')).toBeNull()
  })
})

describe('rehypeFileMentions', () => {
  const text = (value: string) => ({ type: 'text', value })
  const code = (value: string) => ({ type: 'element', tagName: 'code', properties: {}, children: [text(value)] })

  it('marks inline code that looks like a file, never code inside a fenced block', () => {
    const inline = code('src/a.ts:3')
    const plain = code('useState')
    const fenced = code('src/b.ts:9')
    const tree = {
      type: 'root',
      children: [
        { type: 'element', tagName: 'p', children: [text('see '), inline, text(' and '), plain] },
        { type: 'element', tagName: 'pre', children: [fenced] },
      ],
    }
    rehypeFileMentions()(tree)
    expect(inline.properties).toEqual({ [FILE_MENTION_PROPERTY]: 'src/a.ts:3' })
    expect(plain.properties).toEqual({})
    expect(fenced.properties).toEqual({})
  })
})
