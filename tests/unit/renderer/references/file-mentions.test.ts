/**
 * Which inline code in a reply is a file mention worth checking, and the mark
 * the renderer looks for. Fenced code is never a mention.
 */

import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { defaultRehypePlugins } from 'streamdown'
import { detectFileLink, detectFileMention, FILE_MENTION_PROPERTY, rehypeFileMentions, rehypeLocalFileLinks, rehypeRestoreFileLinks } from '../../../../src/renderer/components/references/file-mentions'

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

describe('Markdown file destinations', () => {
  it('keeps relative and absolute paths, including escaped filenames and line ranges', () => {
    for (const path of ['.halo/tmp/report.final.md', './notes/report.md', '../notes/report.md', '/repo/report.md', 'README.md']) {
      expect(detectFileLink(path)).toEqual({ path })
    }
    expect(detectFileLink('C:/repo/report.md')).toEqual({ path: 'C:/repo/report.md' })
    expect(detectFileLink('docs/%E8%AF%84%E5%AE%A1%20(1).md')).toEqual({ path: 'docs/评审 (1).md' })
    expect(detectFileLink('src/app.ts:3-5')).toEqual({ path: 'src/app.ts', range: { startLine: 3, endLine: 5 } })
    expect(detectFileLink('%20report.md')).toEqual({ path: ' report.md' })
    expect(detectFileLink('report.md%20')).toBeNull()
  })

  it('never treats URLs, network paths or malformed destinations as files', () => {
    for (const href of ['https://example.com/a.md', 'mailto:user@example.com', 'javascript:alert(1)', 'file:///repo/a.md',
      'data:text/html,hello', 'vbscript:run', '//host/a.md', '\\\\host\\share\\a.md', '#intro', 'a.md?download', 'a.md#heading',
      'java%73cript:alert(1).md', '%2F%2Fhost/a.md', 'a%00.md', 'a%0A.md', '%E0%A4%A.md']) {
      expect(detectFileLink(href), href).toBeNull()
    }
  })

  async function render(markdown: string, files = true) {
    const processor = unified().use(remarkParse).use(remarkRehype, { allowDangerousHtml: true })
      .use([defaultRehypePlugins.raw])
    if (files) processor.use(rehypeLocalFileLinks)
    processor.use([defaultRehypePlugins.sanitize])
    if (files) processor.use(rehypeRestoreFileLinks)
    processor.use([defaultRehypePlugins.harden]).use(rehypeFileMentions)
    return processor.run(processor.parse(markdown))
  }
  function elements(tree: any): any[] {
    return [tree, ...(tree.children ?? []).flatMap(elements)].filter(node => node.type === 'element')
  }

  it('preserves named files through the real sanitizer and hardener, without navigable URLs', async () => {
    const tree = await render('[Report](.halo/tmp/report.final.md) [Windows](C:/repo/report.md) [Code](src/app.ts:3) [Unicode](docs/%E8%AF%84%E5%AE%A1%20(1).md)')
    const files = elements(tree).filter(node => node.properties?.[FILE_MENTION_PROPERTY])
    expect(files.map(node => node.properties[FILE_MENTION_PROPERTY])).toEqual([
      '.halo/tmp/report.final.md', 'C:/repo/report.md', 'src/app.ts:3', 'docs/%E8%AF%84%E5%AE%A1%20(1).md',
    ])
    expect(files.every(node => node.tagName === 'span' && !node.properties.href && !node.properties.dataFileLink)).toBe(true)
    expect(JSON.stringify(tree)).not.toContain('[blocked]')
  })

  it('retains external links and sanitizes dangerous HTML and forged file metadata', async () => {
    const tree = await render('[Web](https://example.com) [Bad](javascript:alert) <span data-file-link="/outside/secret.md" data-file-mention="fake.md" onclick="alert(1)">spoof</span> <a href=".halo/tmp/report.md" onclick="alert(1)"><b>Report</b><script>alert(1)</script></a>')
    const nodes = elements(tree)
    expect(nodes.find(node => node.tagName === 'a' && node.properties.href === 'https://example.com/')?.properties.href).toBe('https://example.com/')
    expect(nodes.filter(node => node.properties?.[FILE_MENTION_PROPERTY])).toHaveLength(1)
    expect(nodes.some(node => node.tagName === 'script' || node.properties?.onClick || node.properties?.onclick || node.properties?.dataFileLink)).toBe(false)
    expect(JSON.stringify(tree)).not.toContain('javascript:')
    expect(JSON.stringify(tree)).not.toContain('/outside/secret.md')
  })

  it('does not mark code inside links twice, and leaves non-file-link surfaces unchanged', async () => {
    const tree = await render('[`src/app.ts`](notes/todo.md) [`src/util.ts`](https://example.com)')
    expect(elements(tree).filter(node => node.properties?.[FILE_MENTION_PROPERTY])).toHaveLength(1)
    const plain = await render('[Report](.halo/tmp/report.md)', false)
    expect(JSON.stringify(plain)).toContain('[blocked]')
    expect(elements(plain).some(node => node.properties?.[FILE_MENTION_PROPERTY])).toBe(false)
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
