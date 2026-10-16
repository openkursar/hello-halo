/**
 * Which links in rendered Markdown stay live. Only a link that would run code
 * in Halo's own window is taken out, and nothing is ever labelled as blocked.
 */

import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { MARKDOWN_REHYPE_PLUGINS } from '../../../src/renderer/lib/markdown-link-policy'

async function render(markdown: string): Promise<any> {
  const processor = unified().use(remarkParse).use(remarkRehype, { allowDangerousHtml: true }).use(MARKDOWN_REHYPE_PLUGINS)
  return processor.run(processor.parse(markdown))
}

function elements(tree: any): any[] {
  return [tree, ...(tree.children ?? []).flatMap(elements)].filter(node => node.type === 'element')
}

function text(tree: any): string {
  if (tree.type === 'text') return tree.value
  return (tree.children ?? []).map(text).join('')
}

const hrefs = (tree: any): string[] => elements(tree).filter(node => node.tagName === 'a').map(node => node.properties.href)

describe('markdown link policy', () => {
  it('keeps conversation references, web, mail, local file and app links live', async () => {
    const tree = await render('[#Plan](conv:3a5d77ea) [Web](https://example.com/a) [Mail](mailto:a@b.c) [File](file:///repo/a.md) [Code](vscode://file/repo/a.ts) [Top](#intro)')
    expect(hrefs(tree)).toEqual(['conv:3a5d77ea', 'https://example.com/a', 'mailto:a@b.c', 'file:///repo/a.md', 'vscode://file/repo/a.ts', '#intro'])
  })

  it('shows a link that would run code as its text, with nothing added', async () => {
    const tree = await render('[one](javascript:alert(1)) [two](JaVaScRiPt:alert) [three](vbscript:run) [four](data:text/html,x) <a href="java&#9;script:alert(1)">five</a>')
    expect(hrefs(tree)).toEqual([])
    expect(text(tree)).toBe('one two three four five')
    expect(JSON.stringify(tree)).not.toContain('script:')
  })

  it('shows a relative path, which has no target here, as its text', async () => {
    const tree = await render('[Report](.halo/tmp/report.md) and [abs](/Users/me/a.md)')
    expect(hrefs(tree)).toEqual([])
    expect(text(tree)).toBe('Report and abs')
  })

  it('shows an image without a usable source as its alt text', async () => {
    const tree = await render('![chart](https://example.com/c.png) ![inline](data:image/png;base64,AAAA) ![](javascript:x)')
    const images = elements(tree).filter(node => node.tagName === 'img')
    expect(images.map(node => node.properties.src)).toEqual(['https://example.com/c.png'])
    expect(text(tree)).toContain('inline')
  })

  it('never writes the third-party blocked marker', async () => {
    const tree = await render('[a](conv:3a5d77ea) [b](javascript:x) [c](relative.md) ![d](file:///x.png)')
    expect(JSON.stringify(tree)).not.toMatch(/blocked/i)
  })
})
